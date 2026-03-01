import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as AsyncHooksImplementation from 'node:async_hooks';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
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
    buildId: string;
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

type EdgeEntryHandler = (payload: unknown) => Promise<unknown> | unknown;

type EdgeGlobalState = {
  initialized: boolean;
  activeOutputId: string | null;
  inlineAssetByName: Map<string, string>;
  compiledWasmByPath: Map<string, WebAssembly.Module>;
  loadedWasmPaths: Set<string>;
  loadingWasmByPath: Map<string, Promise<WebAssembly.Module>>;
  loadedScriptPaths: Set<string>;
  loadingScriptByPath: Map<string, Promise<void>>;
};

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
]);

const EDGE_GLOBAL_STATE_SYMBOL = Symbol.for('adapter-bun.edge-global-state');
const NEXT_PATCH_SYMBOL = Symbol.for('next-patch');
const edgeRequire = createRequire(import.meta.url);
let edgeInvocationLock: Promise<void> = Promise.resolve();

function logEdgeDebug(message: string, details?: unknown): void {
  if (process.env.ADAPTER_BUN_DEBUG_EDGE !== '1') {
    return;
  }
  if (details === undefined) {
    console.error(`[adapter-bun][edge] ${message}`);
    return;
  }
  console.error(`[adapter-bun][edge] ${message}`, details);
}

function getEdgeGlobalState(): EdgeGlobalState {
  const globalAny = globalThis as Record<PropertyKey, unknown>;
  const existing = globalAny[EDGE_GLOBAL_STATE_SYMBOL] as EdgeGlobalState | undefined;
  if (existing) {
    return existing;
  }

  const created: EdgeGlobalState = {
    initialized: false,
    activeOutputId: null,
    inlineAssetByName: new Map<string, string>(),
    compiledWasmByPath: new Map<string, WebAssembly.Module>(),
    loadedWasmPaths: new Set<string>(),
    loadingWasmByPath: new Map<string, Promise<WebAssembly.Module>>(),
    loadedScriptPaths: new Set<string>(),
    loadingScriptByPath: new Map<string, Promise<void>>(),
  };
  globalAny[EDGE_GLOBAL_STATE_SYMBOL] = created;
  return created;
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
  const entrypointPath = resolveOutputEntrypointPath(
    output,
    adapterDir,
    functionRoot
  );

  const scriptCandidates = output.files
    .filter((file) => file.kind !== 'wasm' && isScriptPath(file.relativePath))
    .map((file) =>
      resolveOutputFilePath(output, file.relativePath, adapterDir, functionRoot)
    )
    .filter((candidatePath) => existsSync(candidatePath));

  const paths: string[] = [];
  const seen = new Set<string>();
  const pushPath = (candidatePath: string): void => {
    if (seen.has(candidatePath)) {
      return;
    }
    seen.add(candidatePath);
    paths.push(candidatePath);
  };

  if (existsSync(entrypointPath)) {
    // The edge entrypoint frequently seeds globals (for example __RSC_MANIFEST)
    // required by subsequently loaded chunks.
    pushPath(entrypointPath);
  }

  for (const candidatePath of scriptCandidates) {
    pushPath(candidatePath);
  }

  if (paths.length === 0) {
    throw new Error(
      `Edge function output "${output.id}" has no script files to evaluate`
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

function resolveInlineAssetPath(
  input: unknown,
  inlineAssetByName: Map<string, string>
): string | null {
  const inputString = responseInputToString(input);
  if (!inputString.startsWith('blob:')) {
    return null;
  }

  const name = inputString.slice('blob:'.length);
  return (
    inlineAssetByName.get(name) ??
    inlineAssetByName.get(decodeURIComponent(name)) ??
    inlineAssetByName.get(name.replace(/^\/+/, '')) ??
    null
  );
}

function ensureEdgeGlobalsInitialized(): EdgeGlobalState {
  const state = getEdgeGlobalState();
  if (!state.initialized) {
    const globalWithSelf = globalThis as unknown as { self?: typeof globalThis };
    if (typeof globalWithSelf.self === 'undefined') {
      globalWithSelf.self = globalThis;
    }

    if (typeof (globalThis as { require?: unknown }).require !== 'function') {
      (globalThis as Record<string, unknown>).require = edgeRequire;
    }

    // Edge chunks snapshot AsyncLocalStorage availability at module eval time.
    // Always force Node's implementation before loading any edge chunk.
    (globalThis as { AsyncLocalStorage: unknown }).AsyncLocalStorage =
      AsyncHooksImplementation.AsyncLocalStorage;
    state.initialized = true;
  }
  return state;
}

async function withPatchedEdgeFetch<T>({
  state: _state,
  run,
}: {
  state: EdgeGlobalState;
  run: () => Promise<T>;
}): Promise<T> {
  // Edge chunks can mutate process-global fetch state at eval time.
  // Snapshot and restore around each edge invocation so node runtime
  // fetch instrumentation (React dedupe/cache) remains stable.
  const globalAny = globalThis as Record<PropertyKey, unknown>;
  const originalFetch = globalThis.fetch;
  const hadNextPatchSymbol = Object.prototype.hasOwnProperty.call(
    globalAny,
    NEXT_PATCH_SYMBOL
  );
  const originalNextPatchValue = globalAny[NEXT_PATCH_SYMBOL];

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (hadNextPatchSymbol) {
      globalAny[NEXT_PATCH_SYMBOL] = originalNextPatchValue;
    } else {
      delete globalAny[NEXT_PATCH_SYMBOL];
    }
  }
}

function registerInlineAssets(
  state: EdgeGlobalState,
  assets: EdgeAssetBinding[]
): void {
  for (const asset of assets) {
    state.inlineAssetByName.set(asset.name, asset.filePath);
    const normalized = asset.name.replace(/^\/+/, '');
    state.inlineAssetByName.set(normalized, asset.filePath);
  }
}

async function ensureWasmLoaded(
  state: EdgeGlobalState,
  wasmBinding: EdgeWasmBinding
): Promise<WebAssembly.Module> {
  const loaded = state.compiledWasmByPath.get(wasmBinding.filePath);
  if (loaded) {
    return loaded;
  }

  const pending = state.loadingWasmByPath.get(wasmBinding.filePath);
  if (pending) {
    return pending;
  }

  const loadPromise = (async () => {
    const module = await WebAssembly.compile(await readFile(wasmBinding.filePath));
    state.compiledWasmByPath.set(wasmBinding.filePath, module);
    return module;
  })();

  state.loadingWasmByPath.set(wasmBinding.filePath, loadPromise);
  try {
    return await loadPromise;
  } finally {
    state.loadingWasmByPath.delete(wasmBinding.filePath);
  }
}

function resetActiveEdgeOutput(state: EdgeGlobalState): void {
  state.activeOutputId = null;
  state.inlineAssetByName.clear();
  state.loadedScriptPaths.clear();
  state.loadedWasmPaths.clear();
  state.loadingScriptByPath.clear();
  state.loadingWasmByPath.clear();

  const globalAny = globalThis as Record<string, unknown>;
  delete globalAny._ENTRIES;
  globalAny.TURBOPACK = [];
  delete globalAny[Symbol.for('next.server.manifests') as unknown as string];
  delete globalAny.__RSC_MANIFEST;
  delete globalAny.__RSC_SERVER_MANIFEST;
}

async function ensureScriptLoaded(
  state: EdgeGlobalState,
  scriptPath: string
): Promise<void> {
  if (state.loadedScriptPaths.has(scriptPath)) {
    return;
  }

  const pending = state.loadingScriptByPath.get(scriptPath);
  if (pending) {
    await pending;
    return;
  }

  const loadPromise = (async () => {
    const source = await readFile(scriptPath, 'utf8');
    runInThisContext(source, {
      filename: scriptPath,
    });
    state.loadedScriptPaths.add(scriptPath);
  })();

  state.loadingScriptByPath.set(scriptPath, loadPromise);
  try {
    await loadPromise;
  } finally {
    state.loadingScriptByPath.delete(scriptPath);
  }
}

async function ensureEdgeOutputLoaded({
  sandbox,
}: {
  sandbox: EdgeSandboxDefinition;
}): Promise<void> {
  const state = ensureEdgeGlobalsInitialized();

  if (state.activeOutputId !== sandbox.outputId) {
    resetActiveEdgeOutput(state);
    state.activeOutputId = sandbox.outputId;
    registerInlineAssets(state, sandbox.assets);
  }

  try {
    for (const wasmBinding of sandbox.wasm) {
      if (!state.loadedWasmPaths.has(wasmBinding.filePath)) {
        const module = await ensureWasmLoaded(state, wasmBinding);
        (globalThis as Record<string, unknown>)[wasmBinding.name] = module;
        state.loadedWasmPaths.add(wasmBinding.filePath);
      } else {
        const module = state.compiledWasmByPath.get(wasmBinding.filePath);
        if (module) {
          (globalThis as Record<string, unknown>)[wasmBinding.name] = module;
        }
      }
    }

    for (const scriptPath of sandbox.paths) {
      await ensureScriptLoaded(state, scriptPath);
    }
  } catch (error) {
    logEdgeDebug('failed to load output', {
      outputId: sandbox.outputId,
      entryKey: `middleware_${sandbox.name}`,
      paths: sandbox.paths,
      error,
    });
    resetActiveEdgeOutput(state);
    throw error;
  }
}

async function withEdgeInvocationLock<T>(run: () => Promise<T>): Promise<T> {
  const previousLock = edgeInvocationLock;
  let releaseCurrentLock: (() => void) | undefined;
  edgeInvocationLock = new Promise<void>((resolve) => {
    releaseCurrentLock = resolve;
  });

  await previousLock;
  try {
    return await run();
  } finally {
    releaseCurrentLock?.();
  }
}

function resolveEdgeEntryHandler({
  outputId,
  entryKey,
}: {
  outputId: string;
  entryKey: string;
}): EdgeEntryHandler {
  const entries = (globalThis as Record<string, unknown>)._ENTRIES as
    | Record<string, EdgeEntryModule>
    | undefined;

  if (!entries || typeof entries !== 'object') {
    throw new Error(`Edge output "${outputId}" did not register global _ENTRIES`);
  }

  const entry = entries[entryKey];
  if (!entry || typeof entry.default !== 'function') {
    throw new Error(
      `Edge output "${outputId}" is missing entry "${entryKey}"`
    );
  }

  return entry.default;
}

function buildPagePayload({
  pageName,
  routeMatches,
}: {
  pageName?: string;
  routeMatches?: Record<string, string>;
}): { name?: string; params?: Record<string, string> } | undefined {
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

async function toEdgeRuntimeRequestBody(
  request: Request
): Promise<ReadableStream<Uint8Array> | undefined> {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return undefined;
  }

  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    return undefined;
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
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

async function invokeEdgeRuntimeHandler({
  sandbox,
  request,
  pageName,
  routeMatches,
  requestMeta,
  signal,
  incrementalCache,
}: {
  sandbox: EdgeSandboxDefinition;
  request: Request;
  pageName?: string;
  routeMatches?: Record<string, string>;
  requestMeta?: Record<string, unknown>;
  signal: AbortSignal;
  incrementalCache: unknown;
}): Promise<Response> {
  return withEdgeInvocationLock(async () => {
    try {
      const edgeState = ensureEdgeGlobalsInitialized();
      return await withPatchedEdgeFetch({
        state: edgeState,
        run: async () => {
          await ensureEdgeOutputLoaded({
            sandbox,
          });
          const edgeFunction = resolveEdgeEntryHandler({
            outputId: sandbox.outputId,
            entryKey: `middleware_${sandbox.name}`,
          });

          if (incrementalCache) {
            const globalAny = globalThis as Record<string, unknown>;
            globalAny.__incrementalCacheShared = true;
            globalAny.__incrementalCache = incrementalCache;
          }

          const requestUrl = new URL(request.url);
          const requestBody = await toEdgeRuntimeRequestBody(request);
          const requestHeaders = toRequestHeadersRecord(request.headers, requestUrl.host);

          const waitUntilTasks: Promise<unknown>[] = [];
          const invoke = (): Promise<unknown> | unknown =>
            edgeFunction({
              request: {
                headers: requestHeaders,
                method: request.method,
                url: requestUrl.toString(),
                body: requestBody,
                signal,
                waitUntil(waitable: Promise<unknown>) {
                  waitUntilTasks.push(waitable);
                },
                page: buildPagePayload({
                  pageName,
                  routeMatches,
                }),
                nextConfig: {
                  basePath: sandbox.nextConfig.basePath,
                  i18n: sandbox.nextConfig.i18n,
                },
                requestMeta,
              },
            });

          const result = await invoke();

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

          let response: Response;
          if (isEdgeResponseLike(responseValue)) {
            response = await toHostResponse(responseValue);
          } else if (responseValue instanceof Response) {
            response = responseValue;
          } else if (responseValue !== undefined && responseValue !== null) {
            response = asResponse(responseValue as Response | LambdaLikeResult);
          } else {
            throw new Error(
              `Edge function handler for output "${sandbox.outputId}" returned no response`
            );
          }

          return normalizeEdgeResponseHeaders(response);
        },
      });
    } catch (error) {
      logEdgeDebug('invocation failed', {
        outputId: sandbox.outputId,
        requestUrl: request.url,
        requestMethod: request.method,
        error,
      });
      throw error;
    }
  });
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
  }

  return async (ctx: FunctionRouteDispatchContext): Promise<Response> => {
    const output = outputById.get(ctx.output.id);
    if (!output) {
      throw new Error(`Unknown edge function output id "${ctx.output.id}"`);
    }

    let sandbox = sandboxByOutputId.get(output.id);
    if (!sandbox) {
      sandbox = buildEdgeSandboxDefinition({
        output,
        adapterDir,
        functionRoot: manifest.artifacts.functionRoot,
        nextConfig: {
          basePath: manifest.build.basePath,
          buildId: manifest.build.buildId,
          i18n: manifest.build.i18n,
        },
      });
      sandboxByOutputId.set(output.id, sandbox);
    }

    return invokeEdgeRuntimeHandler({
      sandbox,
      request: ctx.request,
      pageName: output.sourcePage,
      routeMatches: ctx.routeMatches ?? undefined,
      requestMeta: {
        outputId: output.id,
        source: ctx.source,
        matchedPathname: ctx.matchedPathname,
        routeMatches: ctx.routeMatches ?? null,
        cacheState: ctx.cacheState ?? null,
        initURL: ctx.request.url,
      },
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

  return async (ctx: MiddlewareContext): Promise<RouterMiddlewareResult> => {
    sandbox ??= buildEdgeSandboxDefinition({
      output,
      adapterDir,
      functionRoot: manifest.artifacts.functionRoot,
        nextConfig: {
          basePath: manifest.build.basePath,
          buildId: manifest.build.buildId,
          i18n: manifest.build.i18n,
        },
      });

    const response = await invokeEdgeRuntimeHandler({
      sandbox,
      request: new Request(ctx.url.toString(), {
        method: 'GET',
        headers: ctx.headers,
      }),
      requestMeta: {
        initURL: ctx.url.toString(),
      },
      signal: AbortSignal.timeout(30_000),
      incrementalCache,
    });

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
