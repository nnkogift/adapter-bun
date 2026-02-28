import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import {
  createServer,
  request as sendHttpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import type { MiddlewareContext } from '@next/routing';
import { responseToMiddlewareResult } from '@next/routing';
import type { BunFunctionArtifact } from '../types.ts';
import type {
  FunctionRouteDispatchContext,
  RouterMiddlewareResult,
  RouterRuntimeHandlers,
} from './types.ts';
import {
  asResponse,
  defaultLoadModule,
  resolveOutputEntrypointPath,
  resolveRouteHandlerExport,
  type ArtifactRouteHandler,
  type CreateFunctionArtifactInvokerOptions,
  type LoadedModule,
  type LambdaLikeResult,
} from './function-invoker-shared.ts';

type LoadedNodeExecutor = {
  handler: ArtifactRouteHandler;
  workingDirectory: string;
};

let processCwdLock: Promise<void> = Promise.resolve();

function createOnceCallback(callback: () => void): () => void {
  let didRun = false;
  return () => {
    if (didRun) {
      return;
    }
    didRun = true;
    callback();
  };
}

async function acquireProcessWorkingDirectory(
  workingDirectory: string
): Promise<() => void> {
  const previousLock = processCwdLock;
  let releaseCurrentLock: (() => void) | undefined;
  processCwdLock = new Promise<void>((resolve) => {
    releaseCurrentLock = resolve;
  });

  await previousLock;

  const currentWorkingDirectory = process.cwd();
  process.chdir(workingDirectory);

  return createOnceCallback(() => {
    process.chdir(currentWorkingDirectory);
    releaseCurrentLock?.();
  });
}

async function withProcessWorkingDirectory<T>(
  workingDirectory: string,
  operation: () => Promise<T>
): Promise<T> {
  let releaseWorkingDirectory: (() => void) | undefined;
  try {
    releaseWorkingDirectory = await acquireProcessWorkingDirectory(workingDirectory);
    return await operation();
  } finally {
    releaseWorkingDirectory?.();
  }
}

function inferOutputWorkingDirectory(
  entrypointPath: string,
  adapterDir: string
): string {
  const nextDistMarker = `${path.sep}.next${path.sep}`;
  const markerIndex = entrypointPath.lastIndexOf(nextDistMarker);
  if (markerIndex > 0) {
    return entrypointPath.slice(0, markerIndex);
  }

  return adapterDir;
}

function toOutgoingHttpHeaders(headers: Headers): OutgoingHttpHeaders {
  const outgoing: OutgoingHttpHeaders = {};
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === 'host') {
      continue;
    }
    outgoing[key] = value;
  }
  return outgoing;
}

function toResponseHeaders(headers: IncomingHttpHeaders): Headers {
  const normalized = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'undefined') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        normalized.append(key, item);
      }
      continue;
    }

    normalized.set(key, value);
  }
  return normalized;
}

async function writeResponseToNode(
  destination: ServerResponse,
  response: Response
): Promise<void> {
  destination.statusCode = response.status;

  const groupedHeaders = new Map<string, string[]>();
  for (const [key, value] of response.headers.entries()) {
    const current = groupedHeaders.get(key) ?? [];
    current.push(value);
    groupedHeaders.set(key, current);
  }

  for (const [key, values] of groupedHeaders.entries()) {
    if (key.toLowerCase() === 'set-cookie') {
      destination.setHeader(key, values);
      continue;
    }
    destination.setHeader(key, values.join(', '));
  }

  if (!response.body) {
    destination.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const shouldContinue = destination.write(Buffer.from(value));
      if (!shouldContinue) {
        await once(destination, 'drain');
      }
    }
    destination.end();
  } catch (error) {
    destination.destroy(error instanceof Error ? error : new Error(String(error)));
  } finally {
    reader.releaseLock();
  }
}

function toStreamingResponse(
  clientResponse: IncomingMessage,
  requestMethod: string,
  onBodyComplete: () => void
): Response {
  const isHeadRequest = requestMethod.toUpperCase() === 'HEAD';
  if (isHeadRequest || !clientResponse.readable) {
    onBodyComplete();
    return new Response(null, {
      status: clientResponse.statusCode ?? 200,
      statusText: clientResponse.statusMessage,
      headers: toResponseHeaders(clientResponse.headers),
    });
  }

  const sourceStream = Readable.toWeb(clientResponse) as ReadableStream<Uint8Array>;
  const sourceReader = sourceStream.getReader();
  const finalize = createOnceCallback(() => {
    sourceReader.releaseLock();
    onBodyComplete();
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await sourceReader.read();
        if (done) {
          controller.close();
          finalize();
          return;
        }
        if (value && value.byteLength > 0) {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        finalize();
      }
    },
    async cancel(reason) {
      try {
        await sourceReader.cancel(reason);
      } finally {
        finalize();
      }
    },
  });

  return new Response(body, {
    status: clientResponse.statusCode ?? 200,
    statusText: clientResponse.statusMessage,
    headers: toResponseHeaders(clientResponse.headers),
  });
}

async function invokeNodeRuntimeHandler({
  handler,
  context,
}: {
  handler: ArtifactRouteHandler;
  context: FunctionRouteDispatchContext;
}): Promise<Response> {
  const requestUrl = new URL(context.request.url);
  const body = Buffer.from(await context.request.arrayBuffer());
  const requestHeaders = {
    host: requestUrl.host,
    ...toOutgoingHttpHeaders(context.request.headers),
  };

  return new Promise<Response>((resolve, reject) => {
    let settled = false;

    function settle(complete: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      complete();
    }

    const server = createServer((req, res) => {
      void (async () => {
        try {
          const maybeResult = await handler(req, res, {
            waitUntil(waitable: Promise<unknown>) {
              void waitable.catch(() => undefined);
            },
            requestMeta: {
              outputId: context.output.id,
              source: context.source,
              matchedPathname: context.matchedPathname,
              routeMatches: context.routeMatches ?? null,
              cacheState: context.cacheState ?? null,
            },
          });

          if (maybeResult !== undefined) {
            await writeResponseToNode(
              res,
              asResponse(maybeResult as Response | LambdaLikeResult)
            );
            return;
          }

          if (!res.writableEnded) {
            res.end();
          }
        } catch (error) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Internal Server Error');
          } else if (!res.writableEnded) {
            res.end();
          }

          settle(() => {
            server.close(() => {
              reject(error instanceof Error ? error : new Error(String(error)));
            });
          });
        }
      })();
    });

    server.once('error', (error) => {
      settle(() => reject(error));
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        settle(() => {
          server.close(() => {
            reject(
              new Error('Failed to allocate a local port for node handler invocation')
            );
          });
        });
        return;
      }

      // Upgrade HEAD to GET so the handler returns a full response body.
      // HEAD suppresses the body per HTTP spec, but the caller (e.g. ISR
      // cache during res.revalidate()) needs the body to store a complete
      // cache entry.  All other methods are preserved as-is.
      const internalMethod = context.request.method === 'HEAD' ? 'GET' : context.request.method;
      const clientRequest = sendHttpRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          method: internalMethod,
          path: `${requestUrl.pathname}${requestUrl.search}`,
          headers: requestHeaders,
        },
        (clientResponse) => {
          const closeServer = createOnceCallback(() => {
            server.close(() => undefined);
          });
          clientResponse.once('close', closeServer);
          clientResponse.once('error', closeServer);

          const response = toStreamingResponse(
            clientResponse,
            internalMethod,
            closeServer
          );
          settle(() => {
            resolve(response);
          });
        }
      );

      clientRequest.once('error', (error) => {
        settle(() => {
          server.close(() => reject(error));
        });
      });

      if (body.byteLength > 0) {
        clientRequest.write(body);
      }
      clientRequest.end();
    });
  });
}

const NEXT_SETUP_NODE_ENV_ENTRY = 'next/setup-node-env';
let nextNodeEnvInitialized = false;
let nextNodeEnvPromise: Promise<void> | undefined;

function isModuleNotFoundError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown })?.message === 'string'
        ? (error as { message: string }).message
        : null;

  if (message) {
    return (
      message.includes('Cannot find package') ||
      message.includes('Cannot find module') ||
      message.includes('ERR_MODULE_NOT_FOUND') ||
      message.includes('Cannot resolve module')
    );
  }
  return false;
}

function ensureNextNodeEnvironment(
  options: { entrypointPath?: string } = {}
): Promise<void> {
  if (nextNodeEnvInitialized) {
    return Promise.resolve();
  }

  if (!nextNodeEnvPromise) {
    nextNodeEnvPromise = (async () => {
      try {
        await import(NEXT_SETUP_NODE_ENV_ENTRY);
        nextNodeEnvInitialized = true;
        return;
      } catch (error) {
        if (!isModuleNotFoundError(error)) throw error;
      }

      if (options.entrypointPath) {
        try {
          const requireFromEntrypoint = createRequire(options.entrypointPath);
          const resolvedPath = requireFromEntrypoint.resolve(NEXT_SETUP_NODE_ENV_ENTRY);
          await import(pathToFileURL(resolvedPath).href);
          nextNodeEnvInitialized = true;
          return;
        } catch (error) {
          if (!isModuleNotFoundError(error)) throw error;
        }
      }
    })().finally(() => {
      nextNodeEnvPromise = undefined;
    });
  }

  return nextNodeEnvPromise;
}

export function createNodeFunctionArtifactInvoker({
  manifest,
  adapterDir,
  loadModule = defaultLoadModule,
}: CreateFunctionArtifactInvokerOptions): RouterRuntimeHandlers['invokeFunction'] {
  const outputById = new Map<string, BunFunctionArtifact>();
  const executorByOutputId = new Map<string, Promise<LoadedNodeExecutor>>();
  let workingDirectorySet = false;

  for (const output of manifest.functionMap) {
    if (output.runtime !== 'nodejs') {
      continue;
    }
    outputById.set(output.id, output);
  }

  return async (ctx: FunctionRouteDispatchContext): Promise<Response> => {
    const output = outputById.get(ctx.output.id);
    if (!output) {
      throw new Error(`Unknown node function output id "${ctx.output.id}"`);
    }

    const cached = executorByOutputId.get(output.id);
    const executorPromise =
      cached ??
      (async () => {
        const entrypointPath = resolveOutputEntrypointPath(
          output,
          adapterDir,
          manifest.artifacts.functionRoot
        );
        if (!existsSync(entrypointPath)) {
          throw new Error(
            `Function entrypoint file is missing for output "${output.id}" at "${entrypointPath}"`
          );
        }

        const workingDirectory = inferOutputWorkingDirectory(
          entrypointPath,
          adapterDir
        );

        // All functions share the same bundle root, so set cwd once
        // rather than locking per-invocation (which deadlocks when a
        // handler self-fetches, e.g. res.revalidate()).
        if (!workingDirectorySet) {
          process.chdir(workingDirectory);
          workingDirectorySet = true;
        }

        await ensureNextNodeEnvironment({
          entrypointPath,
        });
        const loadedModule = await loadModule(entrypointPath);
        return {
          handler: resolveRouteHandlerExport(loadedModule as LoadedModule),
          workingDirectory,
        };
      })();

    if (!cached) {
      executorByOutputId.set(output.id, executorPromise);
    }

    const executor = await executorPromise;
    return invokeNodeRuntimeHandler({
      handler: executor.handler,
      context: ctx,
    });
  };
}

type NodeMiddlewareModule = {
  default?: (...args: unknown[]) => unknown;
  proxy?: (...args: unknown[]) => unknown;
  middleware?: (...args: unknown[]) => unknown;
};

type NodeMiddlewareResult = {
  response: Response;
  waitUntil?: Promise<unknown>;
};

export function createNodeMiddlewareInvoker({
  manifest,
  adapterDir,
  loadModule = defaultLoadModule,
}: CreateFunctionArtifactInvokerOptions): RouterRuntimeHandlers['invokeMiddleware'] | null {
  const middlewareOutputId = manifest.runtime?.middlewareOutputId;
  if (!middlewareOutputId) {
    return null;
  }

  const output = manifest.functionMap.find(
    (f) => f.id === middlewareOutputId && f.runtime === 'nodejs'
  );
  if (!output) {
    return null;
  }

  let modulePromise: Promise<NodeMiddlewareModule> | undefined;

  return async (ctx: MiddlewareContext): Promise<RouterMiddlewareResult> => {
    modulePromise ??= (async () => {
      const entrypointPath = resolveOutputEntrypointPath(
        output,
        adapterDir,
        manifest.artifacts.functionRoot
      );
      if (!existsSync(entrypointPath)) {
        throw new Error(
          `Node middleware entrypoint is missing at "${entrypointPath}"`
        );
      }

      await ensureNextNodeEnvironment({ entrypointPath });
      return loadModule(entrypointPath) as Promise<NodeMiddlewareModule>;
    })();

    const mod = await modulePromise;

    const adapterFn = (typeof mod.default === 'function' ? mod.default : undefined) as
      | ((payload: unknown) => Promise<NodeMiddlewareResult>)
      | undefined;
    if (!adapterFn) {
      throw new Error(
        'Node middleware module does not export a default adapter function'
      );
    }

    const handler = mod.proxy ?? mod.middleware ?? mod.default;

    const result = await adapterFn({
      handler,
      request: {
        headers: Object.fromEntries(ctx.headers.entries()),
        method: 'GET',
        nextConfig: {
          basePath: manifest.build.basePath,
          i18n: manifest.build.i18n,
        },
        url: ctx.url.toString(),
        page: {},
        body: undefined,
        signal: AbortSignal.timeout(30_000),
        waitUntil: () => {},
      },
      page: 'middleware',
    });

    if (result.waitUntil) {
      void result.waitUntil.catch(() => undefined);
    }

    const response = result.response;
    const middlewareResult = responseToMiddlewareResult(
      response,
      ctx.headers,
      ctx.url
    );

    return {
      ...middlewareResult,
      response: middlewareResult.bodySent ? response : undefined,
    };
  };
}
