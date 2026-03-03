import { existsSync } from 'node:fs';
import * as AsyncHooksImplementation from 'node:async_hooks';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { MiddlewareContext } from '@next/routing';
import { responseToMiddlewareResult } from '@next/routing';
import type { BunDeploymentManifest, BunFunctionArtifact } from '../types.ts';
import type {
  FunctionRouteDispatchContext,
  RouteMatches,
  RouterMiddlewareResult,
  RouterRuntimeHandlers,
} from './types.ts';
import {
  asResponse,
  resolveOutputFilePath,
  type CreateFunctionArtifactInvokerOptions,
  type LambdaLikeResult,
} from './function-invoker-shared.ts';
import { createMiddlewareMatcher } from './middleware-matcher.ts';

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

type EdgeHostHandler = (params: {
  request: {
    headers: Record<string, string>;
    method: string;
    nextConfig: {
      basePath: string;
      i18n: BunDeploymentManifest['build']['i18n'];
      trailingSlash?: boolean;
    };
    url: string;
    page?: { name?: string; params?: RouteMatches };
    body?: ReadableStream<Uint8Array>;
    signal: AbortSignal;
    waitUntil?: (promise: Promise<unknown>) => void;
  };
}) => Promise<unknown> | unknown;

type EdgeHostGlobals = typeof globalThis & {
  _ENTRIES?: Record<string, { default?: EdgeHostHandler }>;
  __incrementalCacheShared?: boolean;
  __incrementalCache?: unknown;
  NEXT_CLIENT_ASSET_SUFFIX?: string;
  TURBOPACK?: unknown;
  __RSC_MANIFEST?: Record<string, unknown>;
  __RSC_SERVER_MANIFEST?: unknown;
};

type EdgeHostGlobalSnapshot = {
  hasEntries: boolean;
  entries: EdgeHostGlobals['_ENTRIES'];
  hasTurbopack: boolean;
  turbopack: unknown;
  hasServerManifests: boolean;
  serverManifests: unknown;
  hasRscManifest: boolean;
  rscManifest: EdgeHostGlobals['__RSC_MANIFEST'];
  hasRscServerManifest: boolean;
  rscServerManifest: unknown;
};

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
]);

const NEXT_SERVER_MANIFESTS_SYMBOL = Symbol.for('next.server.manifests');
const edgeRequire = createRequire(import.meta.url);
let activeHostEdgeOutputId: string | null = null;
const hostEdgeHandlerByOutputId = new Map<string, EdgeHostHandler>();
const hostEdgeGlobalsByOutputId = new Map<string, EdgeHostGlobalSnapshot>();

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

function ensureHostAsyncLocalStorage(): void {
  const globalWithAls = globalThis as { AsyncLocalStorage?: unknown };
  // Next's edge runtime chunks rely on global AsyncLocalStorage.
  globalWithAls.AsyncLocalStorage = AsyncHooksImplementation.AsyncLocalStorage;
}

function clearHostRequireCache(scriptPath: string): void {
  try {
    const resolvedPath = edgeRequire.resolve(scriptPath);
    if (edgeRequire.cache && resolvedPath in edgeRequire.cache) {
      delete edgeRequire.cache[resolvedPath];
    }
  } catch {
    // Best-effort cache eviction.
  }
}

function resetHostEdgeGlobals(): void {
  const hostGlobals = globalThis as EdgeHostGlobals;
  delete hostGlobals._ENTRIES;

  hostGlobals.TURBOPACK = [];

  const globalRecord = globalThis as Record<string | symbol, unknown>;
  delete globalRecord[NEXT_SERVER_MANIFESTS_SYMBOL];
  delete globalRecord.__RSC_MANIFEST;
  delete globalRecord.__RSC_SERVER_MANIFEST;
}

function captureHostEdgeGlobals(): EdgeHostGlobalSnapshot {
  const hostGlobals = globalThis as EdgeHostGlobals;
  const hostRecord = globalThis as Record<string | symbol, unknown>;
  const hasEntries = Object.prototype.hasOwnProperty.call(hostGlobals, '_ENTRIES');
  const hasTurbopack = Object.prototype.hasOwnProperty.call(hostGlobals, 'TURBOPACK');
  const hasServerManifests = Object.prototype.hasOwnProperty.call(
    hostRecord,
    NEXT_SERVER_MANIFESTS_SYMBOL
  );
  const hasRscManifest = Object.prototype.hasOwnProperty.call(
    hostGlobals,
    '__RSC_MANIFEST'
  );
  const hasRscServerManifest = Object.prototype.hasOwnProperty.call(
    hostGlobals,
    '__RSC_SERVER_MANIFEST'
  );

  return {
    hasEntries,
    entries: hasEntries ? hostGlobals._ENTRIES : undefined,
    hasTurbopack,
    turbopack: hasTurbopack ? hostGlobals.TURBOPACK : undefined,
    hasServerManifests,
    serverManifests: hasServerManifests
      ? hostRecord[NEXT_SERVER_MANIFESTS_SYMBOL]
      : undefined,
    hasRscManifest,
    rscManifest: hasRscManifest ? hostGlobals.__RSC_MANIFEST : undefined,
    hasRscServerManifest,
    rscServerManifest: hasRscServerManifest
      ? hostGlobals.__RSC_SERVER_MANIFEST
      : undefined,
  };
}

function applyHostEdgeGlobals(snapshot: EdgeHostGlobalSnapshot): void {
  const hostGlobals = globalThis as EdgeHostGlobals;
  const hostRecord = globalThis as Record<string | symbol, unknown>;

  if (snapshot.hasEntries) {
    hostGlobals._ENTRIES = snapshot.entries;
  } else {
    delete hostGlobals._ENTRIES;
  }

  if (snapshot.hasTurbopack) {
    hostGlobals.TURBOPACK = snapshot.turbopack;
  } else {
    delete hostGlobals.TURBOPACK;
  }

  if (snapshot.hasServerManifests) {
    hostRecord[NEXT_SERVER_MANIFESTS_SYMBOL] = snapshot.serverManifests;
  } else {
    delete hostRecord[NEXT_SERVER_MANIFESTS_SYMBOL];
  }

  if (snapshot.hasRscManifest) {
    hostGlobals.__RSC_MANIFEST = snapshot.rscManifest;
  } else {
    delete hostGlobals.__RSC_MANIFEST;
  }

  if (snapshot.hasRscServerManifest) {
    hostGlobals.__RSC_SERVER_MANIFEST = snapshot.rscServerManifest;
  } else {
    delete hostGlobals.__RSC_SERVER_MANIFEST;
  }
}

async function ensureHostEdgeHandlerLoaded({
  outputId,
  name,
  paths,
}: {
  outputId: string;
  name: string;
  paths: string[];
}): Promise<EdgeHostHandler> {
  ensureHostAsyncLocalStorage();

  const cachedHandler = hostEdgeHandlerByOutputId.get(outputId);
  if (cachedHandler && hostEdgeGlobalsByOutputId.has(outputId)) {
    return cachedHandler;
  }

  if (activeHostEdgeOutputId !== outputId || !cachedHandler) {
    resetHostEdgeGlobals();
    try {
      for (const scriptPath of paths) {
        clearHostRequireCache(scriptPath);
      }
      for (const scriptPath of paths) {
        edgeRequire(scriptPath);
      }
      activeHostEdgeOutputId = outputId;
    } catch (error) {
      activeHostEdgeOutputId = null;
      hostEdgeHandlerByOutputId.delete(outputId);
      hostEdgeGlobalsByOutputId.delete(outputId);
      throw error;
    }
  }

  const entryKey = `middleware_${name}`;
  const hostGlobals = globalThis as EdgeHostGlobals;
  const entry = hostGlobals._ENTRIES?.[entryKey];
  if (!entry) {
    throw new Error(`Failed to resolve edge handler "${entryKey}"`);
  }

  // Resolve the entry module once so module-level globals (including
  // manifests singleton wiring) are initialized before we snapshot globals.
  const resolvedEntry = await Promise.resolve(entry);
  const handler =
    typeof (resolvedEntry as { default?: unknown }).default === 'function'
      ? ((resolvedEntry as { default: EdgeHostHandler }).default as EdgeHostHandler)
      : typeof (entry as { default?: unknown }).default === 'function'
        ? ((entry as { default: EdgeHostHandler }).default as EdgeHostHandler)
        : undefined;

  if (typeof handler !== 'function') {
    throw new Error(`Failed to resolve edge handler "${entryKey}"`);
  }

  hostEdgeHandlerByOutputId.set(outputId, handler);
  hostEdgeGlobalsByOutputId.set(outputId, captureHostEdgeGlobals());
  return handler;
}

function isScriptPath(filePath: string): boolean {
  return /\.(?:mjs|cjs|js)$/i.test(filePath);
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

function toEdgeFunctionName(outputId: string): string {
  return outputId.replace(/\.rsc$/, '');
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
  const paths: string[] = [];
  const seenPaths = new Set<string>();
  for (const file of output.files) {
    if (file.kind === 'wasm' || !isScriptPath(file.relativePath)) {
      continue;
    }

    const candidatePath = resolveOutputFilePath(
      output,
      file.relativePath,
      adapterDir,
      functionRoot
    );
    if (!existsSync(candidatePath) || seenPaths.has(candidatePath)) {
      continue;
    }

    seenPaths.add(candidatePath);
    paths.push(candidatePath);
  }

  if (paths.length === 0) {
    throw new Error(
      `Edge function output "${output.id}" has no script files to evaluate`
    );
  }

  const assets: EdgeAssetBinding[] = output.files
    .filter(
      (file) =>
        file.kind === 'asset' &&
        !isScriptPath(file.relativePath)
    )
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
    name: toEdgeFunctionName(output.id),
    paths,
    assets,
    wasm,
    env: normalizeEdgeEnv(output.config.env),
    nextConfig,
  };
}

function toRequestHeadersRecord(
  headers: Headers,
  fallbackHost: string
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    record[key] = value;
  }
  if (!record.host) {
    record.host = fallbackHost;
  }
  return record;
}

function buildPagePayload({
  pageName,
  routeMatches,
}: {
  pageName?: string;
  routeMatches?: RouteMatches;
}): { name?: string; params?: RouteMatches } | undefined {
  if (pageName === undefined) {
    return undefined;
  }

  return {
    name: pageName,
    ...(routeMatches && Object.keys(routeMatches).length > 0
      ? { params: routeMatches }
      : {}),
  };
}

function toEdgeRequestBody(
  request: Request
): ReadableStream<Uint8Array> | undefined {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return undefined;
  }
  return request.body ?? undefined;
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

function normalizeEdgeResponseHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const header of FORBIDDEN_RESPONSE_HEADERS) {
    headers.delete(header);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function resolveClientAssetSuffix(): string {
  const token =
    process.env.VERCEL_IMMUTABLE_ASSET_TOKEN ??
    process.env.IMMUTABLE_ASSET_TOKEN ??
    process.env.NEXT_DEPLOYMENT_ID ??
    null;

  if (typeof token === 'string' && token.length > 0) {
    return `?dpl=${token}`;
  }

  if (
    typeof process.env.NEXT_CLIENT_ASSET_SUFFIX === 'string' &&
    process.env.NEXT_CLIENT_ASSET_SUFFIX.length > 0
  ) {
    return process.env.NEXT_CLIENT_ASSET_SUFFIX;
  }

  return '';
}

async function invokeEdgeRuntimeHandler({
  sandbox,
  request,
  pageName,
  routeMatches,
  signal,
  incrementalCache,
}: {
  sandbox: EdgeSandboxDefinition;
  request: Request;
  pageName?: string;
  routeMatches?: RouteMatches;
  signal: AbortSignal;
  incrementalCache: unknown;
}): Promise<Response> {
  const hostGlobals = globalThis as EdgeHostGlobals;
  const hostSnapshot = captureHostEdgeGlobals();
  try {
    const edgeHandler = await ensureHostEdgeHandlerLoaded({
      outputId: sandbox.outputId,
      name: sandbox.name,
      paths: sandbox.paths,
    });

    const edgeSnapshot = hostEdgeGlobalsByOutputId.get(sandbox.outputId);
    if (edgeSnapshot) {
      applyHostEdgeGlobals(edgeSnapshot);
    }

    const hadAssetSuffix = Object.prototype.hasOwnProperty.call(
      hostGlobals,
      'NEXT_CLIENT_ASSET_SUFFIX'
    );
    const previousAssetSuffix = hostGlobals.NEXT_CLIENT_ASSET_SUFFIX;
    const hadIncrementalCache = Object.prototype.hasOwnProperty.call(
      hostGlobals,
      '__incrementalCache'
    );
    const previousIncrementalCache = hostGlobals.__incrementalCache;
    const hadIncrementalCacheShared = Object.prototype.hasOwnProperty.call(
      hostGlobals,
      '__incrementalCacheShared'
    );
    const previousIncrementalCacheShared = hostGlobals.__incrementalCacheShared;

    const requestUrl = new URL(request.url);
    const requestUrlWithParams = new URL(requestUrl.toString());
    const requestHeaders = toRequestHeadersRecord(
      request.headers,
      requestUrlWithParams.host
    );
    if (
      requestUrl.pathname.startsWith('/_next/data/') &&
      requestUrl.pathname.endsWith('.json') &&
      requestHeaders['x-nextjs-data'] !== '1'
    ) {
      requestHeaders['x-nextjs-data'] = '1';
    }
    const requestBody = toEdgeRequestBody(request);
    const waitUntilTasks: Promise<unknown>[] = [];
    const pagePayload = buildPagePayload({
      pageName,
      routeMatches,
    });

    let invocationResult: unknown;
    try {
      hostGlobals.NEXT_CLIENT_ASSET_SUFFIX = resolveClientAssetSuffix();

      if (incrementalCache !== undefined) {
        hostGlobals.__incrementalCacheShared = true;
        hostGlobals.__incrementalCache = incrementalCache;
      }

      const registerWaitUntil = (waitable: Promise<unknown>) => {
        waitUntilTasks.push(waitable);
      };
      invocationResult = await edgeHandler({
        request: {
          headers: requestHeaders,
          method: request.method,
          nextConfig: {
            basePath: sandbox.nextConfig.basePath,
            i18n: sandbox.nextConfig.i18n,
            trailingSlash: false,
          },
          url: requestUrlWithParams.toString(),
          page: pagePayload,
          body: requestBody,
          signal,
          waitUntil(waitable: Promise<unknown>) {
            registerWaitUntil(waitable);
          },
        },
      });
    } finally {
      if (hadAssetSuffix) {
        hostGlobals.NEXT_CLIENT_ASSET_SUFFIX = previousAssetSuffix;
      } else {
        delete hostGlobals.NEXT_CLIENT_ASSET_SUFFIX;
      }

      if (hadIncrementalCache) {
        hostGlobals.__incrementalCache = previousIncrementalCache;
      } else {
        delete hostGlobals.__incrementalCache;
      }

      if (hadIncrementalCacheShared) {
        hostGlobals.__incrementalCacheShared = previousIncrementalCacheShared;
      } else {
        delete hostGlobals.__incrementalCacheShared;
      }
    }

    let rawResponse = invocationResult;
    if (
      invocationResult &&
      typeof invocationResult === 'object' &&
      'response' in invocationResult
    ) {
      const fetchEventResult = invocationResult as EdgeFetchEventResultLike;
      rawResponse = fetchEventResult.response;
      if (fetchEventResult.waitUntil) {
        waitUntilTasks.push(fetchEventResult.waitUntil);
      }
    }

    for (const waitable of waitUntilTasks) {
      void waitable.catch(() => undefined);
    }

    let response: Response;
    if (isEdgeResponseLike(rawResponse)) {
      response = await toHostResponse(rawResponse);
    } else if (rawResponse instanceof Response) {
      response = rawResponse;
    } else if (rawResponse !== undefined && rawResponse !== null) {
      response = asResponse(rawResponse as Response | LambdaLikeResult);
    } else {
      throw new Error(
        `Edge function handler for output "${sandbox.outputId}" returned no response`
      );
    }

    return normalizeEdgeResponseHeaders(response);
  } finally {
    applyHostEdgeGlobals(hostSnapshot);
  }
}

export function createEdgeFunctionArtifactInvoker({
  manifest,
  adapterDir,
  incrementalCache,
}: CreateFunctionArtifactInvokerOptions): RouterRuntimeHandlers['invokeFunction'] {
  const outputById = new Map<string, BunFunctionArtifact>();
  const sandboxByOutputId = new Map<string, EdgeSandboxDefinition>();

  for (const output of manifest.functionMap) {
    if (output.runtime !== 'edge') {
      continue;
    }
    outputById.set(output.id, output);

    const sandbox = buildEdgeSandboxDefinition({
      output,
      adapterDir,
      functionRoot: manifest.artifacts.functionRoot,
      nextConfig: {
        basePath: manifest.build.basePath,
        i18n: manifest.build.i18n,
      },
    });
    sandboxByOutputId.set(output.id, sandbox);
  }

  return async (ctx: FunctionRouteDispatchContext): Promise<Response> => {
    const output = outputById.get(ctx.output.id);
    if (!output) {
      throw new Error(`Unknown edge function output id "${ctx.output.id}"`);
    }

    const sandbox = sandboxByOutputId.get(output.id);
    if (!sandbox) {
      throw new Error(`Missing edge sandbox definition for output "${output.id}"`);
    }

    return invokeEdgeRuntimeHandler({
      sandbox,
      request: ctx.request,
      pageName: output.pathname,
      routeMatches: ctx.routeMatches ?? undefined,
      signal: ctx.request.signal,
      incrementalCache,
    });
  };
}

export function createEdgeMiddlewareInvoker({
  manifest,
  adapterDir,
  incrementalCache,
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

  let sandbox: EdgeSandboxDefinition | undefined;
  const matcher = createMiddlewareMatcher(output);

  return async (ctx: MiddlewareContext): Promise<RouterMiddlewareResult> => {
    if (matcher && !matcher(ctx.url, ctx.headers)) {
      return {};
    }

    sandbox ??= buildEdgeSandboxDefinition({
      output,
      adapterDir,
      functionRoot: manifest.artifacts.functionRoot,
      nextConfig: {
        basePath: manifest.build.basePath,
        i18n: manifest.build.i18n,
      },
    });

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

    const response = await invokeEdgeRuntimeHandler({
      sandbox,
      request: new Request(ctx.url.toString(), {
        method: middlewareMethod,
        headers: ctx.headers,
        body: middlewareBody,
      }),
      signal: AbortSignal.timeout(30_000),
      incrementalCache: undefined,
    });
    const normalizedResponse = normalizeMiddlewareSetCookieHeaders(response);

    const middlewareResult = responseToMiddlewareResult(
      normalizedResponse,
      ctx.headers,
      ctx.url
    );

    return {
      ...middlewareResult,
      response: middlewareResult.bodySent ? normalizedResponse : undefined,
    };
  };
}
