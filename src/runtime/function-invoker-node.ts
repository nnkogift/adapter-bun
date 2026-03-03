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
import { createMiddlewareMatcher } from './middleware-matcher.ts';

type LoadedNodeExecutor = {
  handler: ArtifactRouteHandler;
  workingDirectory: string;
  patchFetch?: () => void;
};

async function normalizeLoadedNodeModule(
  loadedModule: LoadedModule
): Promise<LoadedModule> {
  const defaultExport = (loadedModule as Record<string, unknown>).default;
  if (
    defaultExport &&
    typeof defaultExport === 'object' &&
    typeof (defaultExport as { then?: unknown }).then === 'function'
  ) {
    const resolvedDefault = await (defaultExport as Promise<unknown>);
    if (resolvedDefault && typeof resolvedDefault === 'object') {
      return resolvedDefault as LoadedModule;
    }
  }

  return loadedModule;
}

let processCwdLock: Promise<void> = Promise.resolve();
let fileSystemCacheClass:
  | {
      prototype?: {
        get?: (...args: unknown[]) => Promise<unknown>;
      };
      memoryCache?: {
        clear?: () => void;
      };
    }
  | null
  | undefined;
let didPatchFileSystemCacheFetchTagMismatch = false;
let nodeBaseFetch: typeof fetch | null = null;
let fetchTagEvolutionCounter = 0;
const observedFetchTags = new Map<string, Set<string>>();

const nodeRequire = createRequire(import.meta.url);
const NEXT_PATCH_SYMBOL = Symbol.for('next-patch');
let didPatchReactDomServerForBun = false;

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

function clearNodeFetchMemoryCache(): void {
  if (fileSystemCacheClass === undefined) {
    try {
      const module = nodeRequire(
        'next/dist/server/lib/incremental-cache/file-system-cache'
      ) as { default?: unknown };
      fileSystemCacheClass = (module.default ?? null) as
        | {
            memoryCache?: {
              clear?: () => void;
            };
          }
        | null;
    } catch {
      fileSystemCacheClass = null;
    }
  }

  const fileSystemCache = fileSystemCacheClass;
  if (!fileSystemCache || typeof fileSystemCache !== 'object') {
    return;
  }

  const memoryCache = fileSystemCache.memoryCache;
  if (memoryCache && typeof memoryCache.clear === 'function') {
    memoryCache.clear();
    return;
  }

  fileSystemCache.memoryCache = undefined;
}

function isImplicitCacheTag(tag: string): boolean {
  return tag.startsWith('_N_T_');
}

function ensureFileSystemCacheFetchTagMismatchReturnsMiss(): void {
  if (didPatchFileSystemCacheFetchTagMismatch) {
    return;
  }

  const fileSystemCache = fileSystemCacheClass;
  const prototype = fileSystemCache?.prototype;
  if (!prototype || typeof prototype.get !== 'function') {
    return;
  }

  const originalGet = prototype.get;
  prototype.get = async function patchedGet(...args: unknown[]): Promise<unknown> {
    const result = await originalGet.apply(this, args);
    if (!result || typeof result !== 'object') {
      return result;
    }

    const ctx = args[1] as { tags?: unknown } | undefined;
    const fetchUrl =
      ctx &&
      typeof (ctx as { fetchUrl?: unknown }).fetchUrl === 'string'
        ? ((ctx as { fetchUrl: string }).fetchUrl as string)
        : null;
    const requestedTags = Array.isArray(ctx?.tags)
      ? ctx.tags.filter(
          (tag): tag is string =>
            typeof tag === 'string' &&
            tag.length > 0 &&
            !isImplicitCacheTag(tag)
        )
      : [];
    if (requestedTags.length === 0) {
      return result;
    }

    const value = (result as { value?: { kind?: unknown; tags?: unknown } }).value;
    if (!value || value.kind !== 'FETCH') {
      return result;
    }

    const storedTags = Array.isArray(value.tags)
      ? value.tags.filter(
          (tag): tag is string =>
            typeof tag === 'string' && !isImplicitCacheTag(tag)
        )
      : [];
    if (
      process.env.ADAPTER_BUN_DEBUG_NODE === '1' &&
      typeof fetchUrl === 'string' &&
      fetchUrl.includes('next-data-api-endpoint.vercel.app/api/random?page')
    ) {
      console.log('[adapter-bun][node][fetch-cache:get]', {
        fetchUrl,
        requestedTags,
        storedTags,
        valueKind: value.kind,
      });
    }
    for (const tag of requestedTags) {
      if (!storedTags.includes(tag)) {
        return null;
      }
    }

    return result;
  };

  didPatchFileSystemCacheFetchTagMismatch = true;
}

function scopeNodeFetchMemoryCacheByOutput(): void {
  clearNodeFetchMemoryCache();
  ensureFileSystemCacheFetchTagMismatchReturnsMiss();
}

function resetNodeFetchPatchState(): void {
  if (nodeBaseFetch === null) {
    nodeBaseFetch = globalThis.fetch;
  }
  globalThis.fetch = nodeBaseFetch;
  (globalThis as Record<symbol, unknown>)[NEXT_PATCH_SYMBOL] = false;
}

function toFetchTagList(init: RequestInit | undefined): string[] {
  const nextValue = (init as { next?: unknown } | undefined)?.next;
  if (!nextValue || typeof nextValue !== 'object') {
    return [];
  }
  const tags = (nextValue as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags.filter(
    (tag): tag is string =>
      typeof tag === 'string' &&
      tag.length > 0 &&
      !isImplicitCacheTag(tag)
  );
}

function withTagEvolutionBuster(resource: string | URL | Request, init?: RequestInit): {
  resource: string | URL | Request;
  init?: RequestInit;
} {
  const tags = toFetchTagList(init);
  if (tags.length === 0) {
    return { resource, init };
  }

  const method = (
    init?.method ?? (resource instanceof Request ? resource.method : 'GET')
  ).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return { resource, init };
  }

  const originalUrl =
    typeof resource === 'string'
      ? resource
      : resource instanceof URL
        ? resource.toString()
        : resource.url;

  const key = `${method}:${originalUrl}`;
  const previousTags = observedFetchTags.get(key);
  if (!previousTags) {
    observedFetchTags.set(key, new Set(tags));
    return { resource, init };
  }

  let sawNewTag = false;
  for (const tag of tags) {
    if (!previousTags.has(tag)) {
      previousTags.add(tag);
      sawNewTag = true;
    }
  }
  if (!sawNewTag) {
    return { resource, init };
  }

  const rewrittenUrl = new URL(originalUrl);
  rewrittenUrl.searchParams.set(
    '__adapter_bun_tag_bust',
    String(++fetchTagEvolutionCounter)
  );
  if (
    process.env.ADAPTER_BUN_DEBUG_NODE === '1' &&
    rewrittenUrl.toString().includes('next-data-api-endpoint.vercel.app/api/random?page')
  ) {
    console.log('[adapter-bun][node][fetch-cache:tag-bust]', {
      originalUrl,
      rewrittenUrl: rewrittenUrl.toString(),
      tags,
      observedTags: [...previousTags],
    });
  }
  if (typeof resource === 'string') {
    return { resource: rewrittenUrl.toString(), init };
  }
  if (resource instanceof URL) {
    return { resource: rewrittenUrl, init };
  }
  return { resource: new Request(rewrittenUrl.toString(), resource), init };
}

function createTagEvolutionGuardFetch(baseFetch: typeof fetch): typeof fetch {
  return Object.assign(function guardedFetch(
    resource: string | URL | Request,
    init?: RequestInit
  ) {
    const maybeRewritten = withTagEvolutionBuster(resource, init);
    return baseFetch(maybeRewritten.resource, maybeRewritten.init);
  }, baseFetch);
}

function ensureReactDomServerNodeCompatibility(
  requireFromEntrypoint: ReturnType<typeof createRequire>
): void {
  if (didPatchReactDomServerForBun) {
    return;
  }

  let reactDomServer: Record<string, unknown> | null = null;
  try {
    reactDomServer = requireFromEntrypoint('react-dom/server') as Record<
      string,
      unknown
    >;
  } catch {
    return;
  }

  if (!reactDomServer || typeof reactDomServer !== 'object') {
    return;
  }
  if (typeof reactDomServer.renderToPipeableStream === 'function') {
    didPatchReactDomServerForBun = true;
    return;
  }
  if (typeof reactDomServer.renderToReadableStream !== 'function') {
    return;
  }

  const renderToReadableStream = reactDomServer
    .renderToReadableStream as (...args: unknown[]) => Promise<ReadableStream> | ReadableStream;

  reactDomServer.renderToPipeableStream = function renderToPipeableStream(
    ...args: unknown[]
  ) {
    const [reactNode, rawOptions] = args;
    const options =
      rawOptions && typeof rawOptions === 'object'
        ? ({ ...(rawOptions as Record<string, unknown>) } as Record<string, unknown>)
        : {};

    const abortController = new AbortController();
    if (!('signal' in options)) {
      options.signal = abortController.signal;
    }

    const readablePromise = Promise.resolve(
      renderToReadableStream(reactNode, options)
    );

    return {
      pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream {
        void readablePromise
          .then(async (webStream) => {
            const streamWithReady = webStream as ReadableStream & {
              allReady?: Promise<unknown>;
            };
            if (streamWithReady.allReady) {
              try {
                await streamWithReady.allReady;
              } catch {
                // Let stream piping surface the render error.
              }
            }
            const nodeReadable = Readable.fromWeb(
              webStream as globalThis.ReadableStream<Uint8Array>
            );
            nodeReadable.on('error', (error) => {
              if (typeof (destination as { emit?: unknown }).emit === 'function') {
                (destination as { emit: (event: string, value: unknown) => void }).emit(
                  'error',
                  error
                );
              }
            });
            nodeReadable.pipe(destination as NodeJS.WritableStream);
          })
          .catch((error) => {
            if (typeof (destination as { emit?: unknown }).emit === 'function') {
              (destination as { emit: (event: string, value: unknown) => void }).emit(
                'error',
                error
              );
            }
          });
        return destination;
      },
      abort(reason?: unknown): void {
        try {
          abortController.abort(reason as Error | undefined);
        } catch {
          abortController.abort();
        }
      },
    };
  };

  didPatchReactDomServerForBun = true;
}

type BunRequestLike = Request & {
  bytes?: () => Promise<Uint8Array>;
};

async function readRequestBodyBuffer(request: Request): Promise<Buffer> {
  const requestWithBytes = request as BunRequestLike;
  if (typeof requestWithBytes.bytes === 'function') {
    try {
      return Buffer.from(await requestWithBytes.bytes());
    } catch {
      // Fall back to the standard Request reader.
    }
  }

  return Buffer.from(await request.arrayBuffer());
}

function toOutgoingHttpHeaders(headers: Headers): OutgoingHttpHeaders {
  const outgoing: OutgoingHttpHeaders = {};
  for (const [key, value] of headers.entries()) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'host' ||
      normalizedKey === 'connection' ||
      normalizedKey === 'keep-alive' ||
      normalizedKey === 'proxy-connection' ||
      normalizedKey === 'transfer-encoding' ||
      normalizedKey === 'upgrade' ||
      normalizedKey === 'te' ||
      normalizedKey === 'trailer' ||
      normalizedKey === 'expect'
    ) {
      continue;
    }
    outgoing[key] = value;
  }
  return outgoing;
}

function hasOutgoingHeader(
  headers: OutgoingHttpHeaders & Record<string, string | string[] | number | undefined>,
  expectedKey: string
): boolean {
  const lowerExpectedKey = expectedKey.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerExpectedKey) {
      return true;
    }
  }
  return false;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message;
  }
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return '';
}

function isUnrecognizedServerActionError(error: unknown): boolean {
  return readErrorMessage(error).includes('Failed to find Server Action');
}

function isMpaActionSubmissionRequest({
  request,
  requestMethod,
}: {
  request: Request;
  requestMethod: string;
}): boolean {
  if (requestMethod.toUpperCase() !== 'POST') {
    return false;
  }
  if (request.headers.has('next-action')) {
    return false;
  }
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.startsWith('multipart/form-data');
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

    if (
      key.toLowerCase() === 'content-type' &&
      value.toLowerCase().startsWith('application/json;')
    ) {
      normalized.set(key, 'application/json');
      continue;
    }

    normalized.set(key, value);
  }
  return normalized;
}

function readContentTypeHeader(
  headers: IncomingHttpHeaders
): string | null {
  const value = headers['content-type'] as string | string[] | undefined;
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0]?.toLowerCase() ?? null;
  }
  return null;
}

function readSingleHeaderValue(
  headers: IncomingHttpHeaders,
  name: string
): string | null {
  const value = headers[name] as string | string[] | undefined;
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0] ?? null;
  }
  return null;
}

function splitSetCookieHeaderValue(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (!trimmed.includes(',')) {
    return [trimmed];
  }

  const cookies: string[] = [];
  let segmentStart = 0;
  let inExpiresAttribute = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === ',') {
      if (!inExpiresAttribute) {
        const cookie = trimmed.slice(segmentStart, index).trim();
        if (cookie.length > 0) {
          cookies.push(cookie);
        }
        segmentStart = index + 1;
      }
      continue;
    }

    if (char === ';') {
      inExpiresAttribute = false;
      continue;
    }

    if (
      (char === 'e' || char === 'E') &&
      trimmed.slice(index, index + 8).toLowerCase() === 'expires='
    ) {
      inExpiresAttribute = true;
    }
  }

  const tail = trimmed.slice(segmentStart).trim();
  if (tail.length > 0) {
    cookies.push(tail);
  }

  return cookies;
}

function normalizeMiddlewareSetCookieHeaders(response: Response): Response {
  const rawSetCookie = response.headers.get('set-cookie');
  if (!rawSetCookie) {
    return response;
  }

  const splitCookies = splitSetCookieHeaderValue(rawSetCookie);
  if (splitCookies.length <= 1) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  for (const cookie of splitCookies) {
    headers.append('set-cookie', cookie);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function resetGlobalIncrementalCacheRequestState(): void {
  const globalAny = globalThis as {
    __incrementalCache?: { resetRequestCache?: () => void };
  };
  const cache = globalAny.__incrementalCache;
  if (!cache || typeof cache.resetRequestCache !== 'function') {
    return;
  }
  try {
    cache.resetRequestCache();
  } catch {
    // Best-effort parity with Next request startup.
  }
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
    start(controller) {
      void (async () => {
        try {
          while (true) {
            const { done, value } = await sourceReader.read();
            if (done) {
              controller.close();
              finalize();
              return;
            }
            if (value && value.byteLength > 0) {
              controller.enqueue(value);
            }
          }
        } catch (error) {
          controller.error(error);
          finalize();
        }
      })();
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

async function toBufferedResponse(
  clientResponse: IncomingMessage,
  requestMethod: string,
  onBodyComplete: () => void
): Promise<Response> {
  const isHeadRequest = requestMethod.toUpperCase() === 'HEAD';
  if (isHeadRequest || !clientResponse.readable) {
    onBodyComplete();
    return new Response(null, {
      status: clientResponse.statusCode ?? 200,
      statusText: clientResponse.statusMessage,
      headers: toResponseHeaders(clientResponse.headers),
    });
  }

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of clientResponse) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } finally {
    onBodyComplete();
  }

  const body = chunks.length > 0 ? Buffer.concat(chunks) : null;
  return new Response(body, {
    status: clientResponse.statusCode ?? 200,
    statusText: clientResponse.statusMessage,
    headers: toResponseHeaders(clientResponse.headers),
  });
}

async function invokeNodeRuntimeHandler({
  handler,
  patchFetch,
  context,
}: {
  handler: ArtifactRouteHandler;
  patchFetch?: () => void;
  context: FunctionRouteDispatchContext;
}): Promise<Response> {
  scopeNodeFetchMemoryCacheByOutput();
  resetGlobalIncrementalCacheRequestState();
  resetNodeFetchPatchState();
  patchFetch?.();

  const requestUrl = new URL(context.request.url);
  const originalMethod = context.request.headers.get('x-adapter-original-method');
  const requestMethod = originalMethod ?? context.request.method;
  const debugNodeInvoke = process.env.ADAPTER_BUN_DEBUG_NODE === '1';
  if (debugNodeInvoke) {
    console.log('[adapter-bun][node][invoke:start]', {
      outputId: context.output.id,
      source: context.source,
      matchedPathname: context.matchedPathname,
      pathname: requestUrl.pathname,
      method: requestMethod,
      requestHostHeader: context.request.headers.get('host'),
      requestUrlHost: requestUrl.host,
    });
  }
  const body = await readRequestBodyBuffer(context.request);
  if (
    process.env.ADAPTER_BUN_DEBUG_BODY === '1' &&
    requestUrl.pathname.includes('/advanced/body/json')
  ) {
    const requestWithBytes = context.request as BunRequestLike;
    console.log('[adapter-bun][node][request-body]', {
      method: context.request.method,
      effectiveMethod: requestMethod,
      pathname: requestUrl.pathname,
      contentLengthHeader: context.request.headers.get('content-length'),
      contentTypeHeader: context.request.headers.get('content-type'),
      hasBodyStream: context.request.body !== null,
      hasBytesMethod: typeof requestWithBytes.bytes === 'function',
      bodyLength: body.byteLength,
      bodyPreview: body.toString('utf8').slice(0, 100),
    });
  }
  const requestHeaders = {
    host: requestUrl.host,
    ...toOutgoingHttpHeaders(context.request.headers),
  } as OutgoingHttpHeaders & Record<string, string | string[] | number | undefined>;
  delete requestHeaders['x-adapter-original-method'];
  if (
    requestUrl.pathname.startsWith('/_next/data/') &&
    requestUrl.pathname.endsWith('.json') &&
    !hasOutgoingHeader(requestHeaders, 'x-nextjs-data')
  ) {
    requestHeaders['x-nextjs-data'] = '1';
  }
  const forwardedProto = requestUrl.protocol.replace(/:$/, '') || 'http';
  if (!hasOutgoingHeader(requestHeaders, 'x-forwarded-host')) {
    requestHeaders['x-forwarded-host'] = requestUrl.host;
  }
  if (!hasOutgoingHeader(requestHeaders, 'x-forwarded-port')) {
    requestHeaders['x-forwarded-port'] =
      requestUrl.port ||
      (forwardedProto === 'https' ? '443' : '80');
  }
  if (!hasOutgoingHeader(requestHeaders, 'x-forwarded-proto')) {
    requestHeaders['x-forwarded-proto'] = forwardedProto;
  }
  if (debugNodeInvoke) {
    console.log('[adapter-bun][node][invoke:request-headers]', {
      outputId: context.output.id,
      pathname: requestUrl.pathname,
      method: requestMethod,
      host: requestHeaders.host,
      xForwardedHost: requestHeaders['x-forwarded-host'],
      xForwardedPort: requestHeaders['x-forwarded-port'],
      xForwardedProto: requestHeaders['x-forwarded-proto'],
      xNextjsData: requestHeaders['x-nextjs-data'],
    });
  }

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
        const previousFetch = globalThis.fetch;
        globalThis.fetch = createTagEvolutionGuardFetch(previousFetch);
        try {
          const tunneledOriginalMethodHeader = req.headers['x-adapter-original-method'];
          const tunneledOriginalMethod = Array.isArray(tunneledOriginalMethodHeader)
            ? tunneledOriginalMethodHeader[0]
            : tunneledOriginalMethodHeader;
          if (
            typeof tunneledOriginalMethod === 'string' &&
            tunneledOriginalMethod.length > 0
          ) {
            req.method = tunneledOriginalMethod.toUpperCase();
            delete req.headers['x-adapter-original-method'];
          }
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

          if (maybeResult !== undefined && maybeResult !== null) {
            await writeResponseToNode(
              res,
              asResponse(maybeResult as Response | LambdaLikeResult)
            );
            return;
          }
        } catch (error) {
          const shouldReturnMethodNotAllowed =
            isUnrecognizedServerActionError(error) &&
            isMpaActionSubmissionRequest({
              request: context.request,
              requestMethod,
            });
          if (!res.headersSent) {
            if (shouldReturnMethodNotAllowed) {
              res.statusCode = 405;
              res.setHeader('allow', 'GET, HEAD');
              res.setHeader('content-type', 'text/html; charset=utf-8');
              res.end('<!DOCTYPE html><html><body>Method Not Allowed</body></html>');
            } else {
              res.statusCode = 500;
              res.end('Internal Server Error');
            }
          } else if (!res.writableEnded) {
            res.end();
          }
          // Do not reject the invocation after writing a 500 response.
          // Rejecting here races with the loopback client receiving the
          // response and frequently surfaces as ECONNRESET to callers.
          // Keep the response path intact and let the normal response
          // stream lifecycle close the local server.
          console.error(
            '[adapter-bun] Node function handler error during invocation',
            {
              error,
              request: {
                url: requestUrl.toString(),
                method: requestMethod,
                headers: Object.fromEntries(context.request.headers.entries()),
              },
              route: {
                id: context.output.id,
                source: context.source,
                matchedPathname: context.matchedPathname,
              },
            }
          );
        } finally {
          globalThis.fetch = previousFetch;
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

      const shouldTunnelOptionsBody =
        requestMethod.toUpperCase() === 'OPTIONS' && body.byteLength > 0;
      const internalMethod = shouldTunnelOptionsBody ? 'POST' : requestMethod;
      const clientRequest = sendHttpRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          method: internalMethod,
          path: `${requestUrl.pathname}${requestUrl.search}`,
          headers: {
            ...requestHeaders,
            ...(shouldTunnelOptionsBody
              ? { 'x-adapter-original-method': requestMethod }
              : {}),
            connection: 'close',
          },
          agent: false,
        },
        (clientResponse) => {
          const closeServer = createOnceCallback(() => {
            server.close(() => undefined);
          });
          clientResponse.once('close', closeServer);
          clientResponse.once('error', closeServer);
          const contentType = readContentTypeHeader(clientResponse.headers);
          const varyHeader = readSingleHeaderValue(
            clientResponse.headers,
            'vary'
          )?.toLowerCase();
          const transferEncoding = readSingleHeaderValue(
            clientResponse.headers,
            'transfer-encoding'
          )?.toLowerCase();
          const isHtmlResponse =
            typeof contentType === 'string' && contentType.startsWith('text/html');
          const isRscResponse =
            typeof contentType === 'string' &&
            contentType.startsWith('text/x-component');
          const isChunkedResponse = transferEncoding === 'chunked';
          const isChunkedRouterStateResponse =
            isChunkedResponse &&
            typeof varyHeader === 'string' &&
            varyHeader.includes('next-router-state-tree');
          const shouldStreamResponse =
            (requestMethod.toUpperCase() === 'GET' ||
              requestMethod.toUpperCase() === 'HEAD') &&
            (isRscResponse ||
              isChunkedRouterStateResponse ||
              (isChunkedResponse && !isHtmlResponse));

          if (shouldStreamResponse) {
            const response = toStreamingResponse(
              clientResponse,
                  requestMethod,
                  closeServer
                );
            if (debugNodeInvoke) {
              console.log('[adapter-bun][node][invoke:response]', {
                outputId: context.output.id,
                pathname: requestUrl.pathname,
                method: requestMethod,
                status: clientResponse.statusCode ?? 200,
                mode: 'stream',
                headers: clientResponse.headers,
              });
            }
            settle(() => {
              resolve(response);
            });
            return;
          }

          void toBufferedResponse(clientResponse, requestMethod, closeServer)
            .then((response) => {
              if (debugNodeInvoke) {
                console.log('[adapter-bun][node][invoke:response]', {
                  outputId: context.output.id,
                  pathname: requestUrl.pathname,
                  method: requestMethod,
                  status: clientResponse.statusCode ?? 200,
                  mode: 'buffer',
                  headers: clientResponse.headers,
                });
              }
              settle(() => {
                resolve(response);
              });
            })
            .catch((error) => {
              settle(() => {
                reject(error);
              });
            });
        }
      );

      clientRequest.once('error', (error) => {
        if (debugNodeInvoke) {
          console.error('[adapter-bun][node][invoke:client-error]', {
            outputId: context.output.id,
            pathname: requestUrl.pathname,
            method: requestMethod,
            error,
          });
        }
        settle(() => {
          reject(error);
          server.close(() => undefined);
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

        if (nodeBaseFetch === null) {
          nodeBaseFetch = globalThis.fetch;
        }

        await ensureNextNodeEnvironment({
          entrypointPath,
        });
        const requireFromEntrypoint = createRequire(entrypointPath);
        ensureReactDomServerNodeCompatibility(requireFromEntrypoint);
        const rawLoadedModule = await loadModule(entrypointPath);
        const loadedModule = await normalizeLoadedNodeModule(
          rawLoadedModule as LoadedModule
        );
        resetNodeFetchPatchState();
        const patchFetch =
          typeof (loadedModule as LoadedModule).patchFetch === 'function'
            ? ((loadedModule as LoadedModule).patchFetch as () => void)
            : (loadedModule as LoadedModule).default &&
                typeof ((loadedModule as LoadedModule).default as Record<string, unknown>)
                  .patchFetch === 'function'
              ? (((loadedModule as LoadedModule).default as Record<string, unknown>)
                  .patchFetch as () => void)
              : undefined;
        return {
          handler: resolveRouteHandlerExport(loadedModule as LoadedModule),
          workingDirectory,
          patchFetch,
        };
      })();

    if (!cached) {
      executorByOutputId.set(output.id, executorPromise);
    }

    const executor = await executorPromise;
    return invokeNodeRuntimeHandler({
      handler: executor.handler,
      patchFetch: executor.patchFetch,
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
  const matcher = createMiddlewareMatcher(output);

  return async (ctx: MiddlewareContext): Promise<RouterMiddlewareResult> => {
    if (matcher && !matcher(ctx.url, ctx.headers)) {
      return {};
    }

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
    const customMethod = (
      ctx as MiddlewareContext & { method?: string }
    ).method;
    const middlewareMethod = (
      customMethod ??
      ctx.headers.get('x-adapter-original-method') ??
      'GET'
    ).toUpperCase();
    const middlewareBody =
      middlewareMethod === 'GET' || middlewareMethod === 'HEAD'
        ? undefined
        : ctx.requestBody;

    const result = await adapterFn({
      handler,
      request: {
        headers: Object.fromEntries(ctx.headers.entries()),
        method: middlewareMethod,
        nextConfig: {
          basePath: manifest.build.basePath,
          i18n: manifest.build.i18n,
        },
        url: ctx.url.toString(),
        page: {},
        body: middlewareBody,
        signal: AbortSignal.timeout(30_000),
        waitUntil: () => {},
      },
      page: 'middleware',
    });

    if (result.waitUntil) {
      void result.waitUntil.catch(() => undefined);
    }

    const response = normalizeMiddlewareSetCookieHeaders(result.response);
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
