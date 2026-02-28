import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as AsyncHooksImplementation from 'node:async_hooks';
import * as AssertImplementation from 'node:assert';
import * as BufferImplementation from 'node:buffer';
import * as EventsImplementation from 'node:events';
import path from 'node:path';
import * as UtilImplementation from 'node:util';
import { runInContext } from 'node:vm';
import { EdgeRuntime } from 'edge-runtime';
import type { MiddlewareContext } from '@next/routing';
import { responseToMiddlewareResult } from '@next/routing';
import type { BunDeploymentManifest, BunFunctionArtifact } from '../types.ts';
import type {
  FunctionRouteDispatchContext,
  RouterMiddlewareResult,
  RouterRuntimeHandlers,
} from './types.ts';
import {
  asResponse,
  resolveOutputEntrypointPath,
  resolveOutputFilePath,
  type CreateFunctionArtifactInvokerOptions,
  type LambdaLikeResult,
} from './function-invoker-shared.ts';

type EdgeRuntimeInstance = InstanceType<typeof EdgeRuntime>;

type EdgeAssetBinding = {
  name: string;
  filePath: string;
};

type EdgeWasmBinding = {
  name: string;
  filePath: string;
};

type EdgeSandboxDefinition = {
  outputId: string;
  name: string;
  paths: string[];
  assets: EdgeAssetBinding[];
  wasm: EdgeWasmBinding[];
  env: Record<string, string>;
  nextConfig: {
    basePath: string;
    i18n: BunDeploymentManifest['build']['i18n'];
  };
};

type EdgeEntryModule = {
  default?: (payload: unknown) => Promise<unknown> | unknown;
};

type EdgeFetchEventResultLike = {
  response: unknown;
  waitUntil?: Promise<unknown>;
};

type EdgeResponseLike = {
  status: number;
  statusText: string;
  headers: unknown;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type EdgeRuntimeExecutor = {
  outputId: string;
  entryKey: string;
  nextConfig: EdgeSandboxDefinition['nextConfig'];
  runtime: EdgeRuntimeInstance;
};

const EDGE_NATIVE_MODULES = new Map<string, unknown>([
  ['async_hooks', AsyncHooksImplementation],
  ['node:async_hooks', AsyncHooksImplementation],
  ['assert', AssertImplementation],
  ['node:assert', AssertImplementation],
  ['buffer', BufferImplementation],
  ['node:buffer', BufferImplementation],
  ['events', EventsImplementation],
  ['node:events', EventsImplementation],
  ['util', UtilImplementation],
  ['node:util', UtilImplementation],
]);

function isScriptPath(filePath: string): boolean {
  return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function scriptPriority(filePath: string, entrypointPath: string): number {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/edge-runtime-webpack')) {
    return 0;
  }
  if (normalized.includes('/webpack-runtime')) {
    return 1;
  }
  if (normalized.includes('/server/chunks/')) {
    return 2;
  }
  if (normalized === entrypointPath.replace(/\\/g, '/')) {
    return 4;
  }
  return 3;
}

function extractWasmBindingName(fileRelativePath: string): string {
  const normalized = fileRelativePath.replace(/\\/g, '/');
  if (normalized.startsWith('_wasm/')) {
    return normalized.slice('_wasm/'.length);
  }
  return path.posix.basename(normalized);
}

function normalizeEdgeEnv(
  value: BunFunctionArtifact['config']['env']
): Record<string, string> {
  if (!value) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, current] of Object.entries(value)) {
    env[key] = String(current);
  }
  return env;
}

function buildEdgeSandboxDefinition({
  output,
  adapterDir,
  functionRoot,
  nextConfig,
}: {
  output: BunFunctionArtifact;
  adapterDir: string;
  functionRoot: string;
  nextConfig: EdgeSandboxDefinition['nextConfig'];
}): EdgeSandboxDefinition {
  const entrypointPath = resolveOutputEntrypointPath(
    output,
    adapterDir,
    functionRoot
  );
  const scriptCandidates = output.files
    .filter((file) => file.kind !== 'wasm' && isScriptPath(file.relativePath))
    .map((file) => resolveOutputFilePath(output, file.relativePath, adapterDir, functionRoot))
    .filter((candidatePath) => existsSync(candidatePath));

  const uniqueScripts = new Set<string>(scriptCandidates);
  if (existsSync(entrypointPath)) {
    uniqueScripts.add(entrypointPath);
  }

  const paths = [...uniqueScripts].sort((left, right) => {
    const priorityDelta =
      scriptPriority(left, entrypointPath) - scriptPriority(right, entrypointPath);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return left.localeCompare(right);
  });
  if (paths.length === 0) {
    throw new Error(
      `Edge function output "${output.id}" has no script files to evaluate in sandbox`
    );
  }

  const assets: EdgeAssetBinding[] = output.files
    .filter((file) => file.kind === 'asset')
    .map((file) => ({
      name: file.relativePath,
      filePath: resolveOutputFilePath(
        output,
        file.relativePath,
        adapterDir,
        functionRoot
      ),
    }))
    .filter((item) => existsSync(item.filePath));
  const wasm: EdgeWasmBinding[] = output.files
    .filter((file) => file.kind === 'wasm')
    .map((file) => ({
      name: extractWasmBindingName(file.relativePath),
      filePath: resolveOutputFilePath(
        output,
        file.relativePath,
        adapterDir,
        functionRoot
      ),
    }))
    .filter((item) => existsSync(item.filePath));

  return {
    outputId: output.id,
    name: output.id,
    paths,
    assets,
    wasm,
    env: normalizeEdgeEnv(output.config.env),
    nextConfig,
  };
}

function toRequestHeadersRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    record[key] = value;
  }
  return record;
}

function buildEdgeProcessEnv(injected: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(injected)) {
    env[key] = value;
  }
  env.NEXT_RUNTIME = 'edge';
  return env;
}

function responseInputToString(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input && typeof input === 'object' && 'url' in input) {
    const withUrl = input as { url?: unknown };
    if (typeof withUrl.url === 'string') {
      return withUrl.url;
    }
  }

  return String(input);
}

async function maybeReadInlineAssetResponse({
  input,
  assetsByName,
  context,
}: {
  input: unknown;
  assetsByName: Map<string, string>;
  context: EdgeRuntimeInstance['context'];
}): Promise<Response | undefined> {
  const inputString = responseInputToString(input);
  if (!inputString.startsWith('blob:')) {
    return undefined;
  }

  const name = inputString.slice('blob:'.length);
  const assetPath =
    assetsByName.get(name) ??
    assetsByName.get(decodeURIComponent(name)) ??
    assetsByName.get(name.replace(/^\/+/, ''));
  if (!assetPath || !existsSync(assetPath)) {
    return undefined;
  }

  const content = await readFile(assetPath);
  return new context.Response(content);
}

function isEdgeFetchEventResultLike(value: unknown): value is EdgeFetchEventResultLike {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'response' in value &&
      (value as { response?: unknown }).response
  );
}

function isEdgeResponseLike(value: unknown): value is EdgeResponseLike {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<EdgeResponseLike>;
  return (
    typeof candidate.status === 'number' &&
    typeof candidate.arrayBuffer === 'function' &&
    candidate.headers !== undefined
  );
}

async function toHostResponse(response: Response | EdgeResponseLike): Promise<Response> {
  if (response instanceof Response) {
    return response;
  }

  return new Response(Buffer.from(await response.arrayBuffer()), {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers as Headers),
  });
}

function resolveEdgeEntryHandler(
  executor: EdgeRuntimeExecutor
): (payload: unknown) => Promise<unknown> | unknown {
  const entriesValue = (executor.runtime.context as Record<string, unknown>)._ENTRIES;
  if (!entriesValue || typeof entriesValue !== 'object') {
    throw new Error(
      `Edge output "${executor.outputId}" did not register global _ENTRIES`
    );
  }

  const entries = entriesValue as Record<string, EdgeEntryModule>;
  const entry = entries[executor.entryKey];
  if (!entry || typeof entry.default !== 'function') {
    throw new Error(
      `Edge output "${executor.outputId}" is missing entry "${executor.entryKey}"`
    );
  }

  return entry.default;
}

async function toEdgeRuntimeRequestBody(
  runtime: EdgeRuntimeInstance,
  request: Request
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined;
  }

  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    return undefined;
  }

  const RuntimeUint8Array = runtime.evaluate<typeof Uint8Array>('Uint8Array');
  return new runtime.context.ReadableStream({
    start(controller) {
      controller.enqueue(new RuntimeUint8Array(bytes));
      controller.close();
    },
  });
}

async function createEdgeRuntimeExecutor(
  sandbox: EdgeSandboxDefinition
): Promise<EdgeRuntimeExecutor> {
  const assetsByName = new Map<string, string>(
    sandbox.assets.map((asset) => [asset.name, asset.filePath])
  );
  const edgeProcess = {
    env: buildEdgeProcessEnv(sandbox.env),
  };

  const runtime = new EdgeRuntime({
    extend(context) {
      context.process = edgeProcess;

      Object.defineProperty(context, 'require', {
        enumerable: false,
        value: (id: string) => {
          const moduleValue = EDGE_NATIVE_MODULES.get(id);
          if (!moduleValue) {
            throw new TypeError(`Native module not found: ${id}`);
          }
          return moduleValue;
        },
      });

      const originalFetch = context.fetch.bind(context);
      context.fetch = async (input, init = {}) => {
        const assetResponse = await maybeReadInlineAssetResponse({
          input,
          assetsByName,
          context,
        });
        if (assetResponse) {
          return assetResponse;
        }
        return originalFetch(input, init);
      };

      return context;
    },
  });

  runtime.context.AsyncLocalStorage = AsyncHooksImplementation.AsyncLocalStorage;

  for (const wasmBinding of sandbox.wasm) {
    const module = await WebAssembly.compile(await readFile(wasmBinding.filePath));
    runtime.context[wasmBinding.name] = module;
  }

  for (const scriptPath of sandbox.paths) {
    const source = await readFile(scriptPath, 'utf8');
    runInContext(source, runtime.context, {
      filename: scriptPath,
    });
  }

  return {
    outputId: sandbox.outputId,
    entryKey: `middleware_${sandbox.name}`,
    nextConfig: sandbox.nextConfig,
    runtime,
  };
}

async function invokeEdgeRuntimeHandler({
  executor,
  context,
}: {
  executor: EdgeRuntimeExecutor;
  context: FunctionRouteDispatchContext;
}): Promise<Response> {
  const handler = resolveEdgeEntryHandler(executor);
  const requestBody = await toEdgeRuntimeRequestBody(executor.runtime, context.request);
  const requestHeaders = toRequestHeadersRecord(context.request.headers);
  const requestUrl = new URL(context.request.url);
  if (!requestHeaders.host) {
    requestHeaders.host = requestUrl.host;
  }

  const waitUntilTasks: Promise<unknown>[] = [];
  const result = await handler({
    request: {
      headers: requestHeaders,
      method: context.request.method,
      url: context.request.url,
      body: requestBody,
      signal: context.request.signal,
      waitUntil(waitable: Promise<unknown>) {
        waitUntilTasks.push(waitable);
      },
      page: {
        name: context.output.sourcePage,
        params: context.routeMatches ?? {},
      },
      nextConfig: {
        basePath: executor.nextConfig.basePath,
        i18n: executor.nextConfig.i18n,
      },
      requestMeta: {
        initURL: context.request.url,
      },
    },
  });

  let responseValue: unknown;
  if (isEdgeFetchEventResultLike(result)) {
    responseValue = result.response;
    if (result.waitUntil) {
      waitUntilTasks.push(result.waitUntil);
    }
  } else {
    responseValue = result;
  }

  for (const waitable of waitUntilTasks) {
    void waitable.catch(() => undefined);
  }

  if (isEdgeResponseLike(responseValue)) {
    return toHostResponse(responseValue);
  }
  if (responseValue instanceof Response) {
    return responseValue;
  }
  if (responseValue !== undefined && responseValue !== null) {
    return asResponse(responseValue as Response | LambdaLikeResult);
  }

  throw new Error(
    `Edge function handler for output "${context.output.id}" returned no response`
  );
}

export function createEdgeFunctionArtifactInvoker({
  manifest,
  adapterDir,
}: CreateFunctionArtifactInvokerOptions): RouterRuntimeHandlers['invokeFunction'] {
  const outputById = new Map<string, BunFunctionArtifact>();
  const executorByOutputId = new Map<string, Promise<EdgeRuntimeExecutor>>();

  for (const output of manifest.functionMap) {
    if (output.runtime !== 'edge') {
      continue;
    }
    outputById.set(output.id, output);
  }

  return async (ctx: FunctionRouteDispatchContext): Promise<Response> => {
    const output = outputById.get(ctx.output.id);
    if (!output) {
      throw new Error(`Unknown edge function output id "${ctx.output.id}"`);
    }

    const cached = executorByOutputId.get(output.id);
    const executorPromise =
      cached ??
      (async () => {
        const sandbox = buildEdgeSandboxDefinition({
          output,
          adapterDir,
          functionRoot: manifest.artifacts.functionRoot,
          nextConfig: {
            basePath: manifest.build.basePath,
            i18n: manifest.build.i18n,
          },
        });
        return createEdgeRuntimeExecutor(sandbox);
      })();

    if (!cached) {
      executorByOutputId.set(output.id, executorPromise);
    }

    const executor = await executorPromise;
    return invokeEdgeRuntimeHandler({
      executor,
      context: ctx,
    });
  };
}

export function createEdgeMiddlewareInvoker({
  manifest,
  adapterDir,
}: CreateFunctionArtifactInvokerOptions): RouterRuntimeHandlers['invokeMiddleware'] | null {
  const middlewareOutputId = manifest.runtime?.middlewareOutputId;
  if (!middlewareOutputId) {
    return null;
  }

  const output = manifest.functionMap.find(
    (f) => f.id === middlewareOutputId && f.runtime === 'edge'
  );
  if (!output) {
    return null;
  }

  let executorPromise: Promise<EdgeRuntimeExecutor> | undefined;

  return async (ctx: MiddlewareContext): Promise<RouterMiddlewareResult> => {
    executorPromise ??= (async () => {
      const sandbox = buildEdgeSandboxDefinition({
        output,
        adapterDir,
        functionRoot: manifest.artifacts.functionRoot,
        nextConfig: {
          basePath: manifest.build.basePath,
          i18n: manifest.build.i18n,
        },
      });
      return createEdgeRuntimeExecutor(sandbox);
    })();

    const executor = await executorPromise;
    const handler = resolveEdgeEntryHandler(executor);

    const requestHeaders = toRequestHeadersRecord(ctx.headers);
    if (!requestHeaders.host) {
      requestHeaders.host = ctx.url.host;
    }

    const waitUntilTasks: Promise<unknown>[] = [];
    const result = await handler({
      request: {
        headers: requestHeaders,
        method: 'GET',
        url: ctx.url.toString(),
        body: undefined,
        waitUntil(waitable: Promise<unknown>) {
          waitUntilTasks.push(waitable);
        },
        page: {
          name: output.sourcePage,
          params: {},
        },
        nextConfig: {
          basePath: executor.nextConfig.basePath,
          i18n: executor.nextConfig.i18n,
        },
        requestMeta: {
          initURL: ctx.url.toString(),
        },
      },
    });

    for (const waitable of waitUntilTasks) {
      void waitable.catch(() => undefined);
    }

    let responseValue: unknown;
    if (isEdgeFetchEventResultLike(result)) {
      responseValue = result.response;
      if (result.waitUntil) {
        waitUntilTasks.push(result.waitUntil);
      }
    } else {
      responseValue = result;
    }

    let response: Response;
    if (isEdgeResponseLike(responseValue)) {
      response = await toHostResponse(responseValue);
    } else if (responseValue instanceof Response) {
      response = responseValue;
    } else {
      response = new Response(null, { status: 200 });
    }

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
