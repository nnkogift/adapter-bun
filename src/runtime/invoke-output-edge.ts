import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type {
  AppendMutableHeader,
  RuntimeBuildConfig,
  RuntimeFunctionOutput,
  RuntimeNextConfig,
  RuntimePrerenderManifest,
  RuntimeRequestMeta,
  RuntimeRequiredServerFilesConfig,
  WaitUntilCollector,
  WriteFetchResponse,
} from './invoke-output-types.js';

type RuntimeIncrementalCache = {
  resetRequestCache?: () => void;
};
type RuntimeIncrementalCacheConstructor = new (options: {
  dev: boolean;
  minimalMode?: boolean;
  flushToDisk?: boolean;
  serverDistDir?: string;
  requestHeaders: IncomingHttpHeaders;
  maxMemoryCacheSize?: number;
  getPrerenderManifest: () => RuntimePrerenderManifest;
  fetchCacheKeyPrefix?: string;
  CurCacheHandler?: new (...args: any[]) => unknown;
  allowedRevalidateHeaderKeys?: string[];
}) => RuntimeIncrementalCache;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canImportEdgeAsset(filePath: string): boolean {
  return filePath.endsWith('.js') || filePath.endsWith('.mjs');
}

function applyEdgeEnv(env: Record<string, string> | undefined): void {
  if (!env) {
    return;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length > 0) {
      process.env[key] = value;
    }
  }
}

function deriveEdgeEntryKey(output: RuntimeFunctionOutput): string {
  const normalizedId = output.id.endsWith('.rsc') ? output.id.slice(0, -4) : output.id;
  const idWithoutLeadingSlash = normalizedId.replace(/^\/+/, '');
  return `middleware_${idWithoutLeadingSlash}`;
}

const require = createRequire(import.meta.url);
const edgeChunkLoadPromises = new Map<string, Promise<void>>();

async function importEdgeChunk(filePath: string): Promise<void> {
  const normalizedPath = path.resolve(filePath);
  const existingLoadPromise = edgeChunkLoadPromises.get(normalizedPath);
  if (existingLoadPromise) {
    await existingLoadPromise;
    return;
  }
  const loadPromise = import(pathToFileURL(normalizedPath).href).then(() => undefined);
  edgeChunkLoadPromises.set(normalizedPath, loadPromise);
  try {
    await loadPromise;
  } catch (error) {
    edgeChunkLoadPromises.delete(normalizedPath);
    throw error;
  }
}

async function readReadableStreamBody(
  body: ReadableStream<Uint8Array> | null | undefined
): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      chunks.push(value);
      totalLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0] ?? new Uint8Array(0);
  }
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

interface CreateEdgeOutputInvokerOptions {
  appendMutableHeader: AppendMutableHeader;
  buildId: string;
  canRequestHaveBody: (method: string | undefined) => boolean;
  createWaitUntilCollector: () => WaitUntilCollector;
  isReadMethod: (method: string | undefined) => boolean;
  manifestBuild?: RuntimeBuildConfig;
  manifestDistDir: string | null;
  prerenderManifest: RuntimePrerenderManifest;
  requiredServerFilesConfig: RuntimeRequiredServerFilesConfig;
  runtimeNextConfig: RuntimeNextConfig;
  writeFetchResponse: WriteFetchResponse;
}

export function createEdgeOutputInvoker(options: CreateEdgeOutputInvokerOptions): {
  invokeEdgeFunctionOutput: (
    req: IncomingMessage,
    res: ServerResponse,
    output: RuntimeFunctionOutput,
    requestUrl: URL,
    requestBody: Uint8Array,
    requestMeta?: RuntimeRequestMeta
  ) => Promise<void>;
  invokeEdgeMiddleware: (
    middleware: RuntimeFunctionOutput,
    requestUrl: URL,
    method: string | undefined,
    headers: Headers,
    requestBody: ReadableStream<Uint8Array>
  ) => Promise<Response>;
} {
  const {
    appendMutableHeader,
    buildId,
    canRequestHaveBody,
    createWaitUntilCollector,
    isReadMethod,
    manifestBuild,
    manifestDistDir,
    prerenderManifest,
    requiredServerFilesConfig,
    runtimeNextConfig,
    writeFetchResponse,
  } = options;

  const edgeRuntimeProjectDir =
    typeof manifestBuild?.projectDir === 'string' && manifestBuild.projectDir.length > 0
      ? manifestBuild.projectDir
      : process.cwd();
  const edgeRuntimeDistDir =
    typeof manifestBuild?.distDir === 'string' && manifestBuild.distDir.length > 0
      ? path.isAbsolute(manifestBuild.distDir)
        ? manifestBuild.distDir
        : path.join(edgeRuntimeProjectDir, manifestBuild.distDir)
      : path.join(edgeRuntimeProjectDir, '.next');
  const edgeRequestNextConfig = {
    basePath: manifestBuild?.basePath,
    i18n: manifestBuild?.i18n ?? null,
    trailingSlash: Boolean(manifestBuild?.trailingSlash),
  };
  const edgeClientAssetToken =
    process.env.IMMUTABLE_ASSET_TOKEN ||
    process.env.VERCEL_IMMUTABLE_ASSET_TOKEN ||
    process.env.NEXT_DEPLOYMENT_ID ||
    '';

  let sandboxRun:
    | ((params: any) => Promise<{ response: Response; waitUntil: Promise<unknown> }>)
    | null = null;
  let incrementalCacheConstructor: RuntimeIncrementalCacheConstructor | null = null;
  let incrementalCacheHandlerConstructor:
    | (new (...args: any[]) => unknown)
    | null
    | undefined = undefined;

  function getIncrementalCacheConstructor(): RuntimeIncrementalCacheConstructor {
    if (incrementalCacheConstructor) {
      return incrementalCacheConstructor;
    }
    const incrementalCacheModule = require('next/dist/server/lib/incremental-cache') as {
      IncrementalCache?: unknown;
    };
    if (typeof incrementalCacheModule.IncrementalCache !== 'function') {
      throw new Error('[adapter-bun] failed to load IncrementalCache constructor');
    }
    incrementalCacheConstructor =
      incrementalCacheModule.IncrementalCache as RuntimeIncrementalCacheConstructor;
    return incrementalCacheConstructor;
  }

  function resolveModuleClassExport(value: unknown): (new (...args: any[]) => unknown) | null {
    if (typeof value === 'function') {
      return value as new (...args: any[]) => unknown;
    }
    if (!isRecord(value)) {
      return null;
    }
    const defaultExport = value.default;
    if (typeof defaultExport === 'function') {
      return defaultExport as new (...args: any[]) => unknown;
    }
    if (isRecord(defaultExport) && typeof defaultExport.default === 'function') {
      return defaultExport.default as new (...args: any[]) => unknown;
    }
    return null;
  }

  function getIncrementalCacheHandlerConstructor():
    | (new (...args: any[]) => unknown)
    | undefined {
    if (incrementalCacheHandlerConstructor !== undefined) {
      return incrementalCacheHandlerConstructor ?? undefined;
    }
    incrementalCacheHandlerConstructor = null;
    const cacheHandlerPath =
      requiredServerFilesConfig.cacheHandler || runtimeNextConfig.cacheHandler;
    if (typeof cacheHandlerPath !== 'string' || cacheHandlerPath.length === 0) {
      return undefined;
    }
    const resolvedCacheHandlerPath = path.isAbsolute(cacheHandlerPath)
      ? cacheHandlerPath
      : path.resolve(manifestDistDir ?? edgeRuntimeDistDir, cacheHandlerPath);
    try {
      const loadedModule = require(resolvedCacheHandlerPath) as unknown;
      const resolvedConstructor = resolveModuleClassExport(loadedModule);
      if (resolvedConstructor) {
        incrementalCacheHandlerConstructor = resolvedConstructor;
      }
    } catch {
      // Ignore load failures and let Next.js fall back to the default handler.
    }
    return incrementalCacheHandlerConstructor ?? undefined;
  }

  function createEdgeIncrementalCache(
    requestHeaders: IncomingHttpHeaders
  ): RuntimeIncrementalCache | undefined {
    try {
      const IncrementalCache = getIncrementalCacheConstructor();
      const cacheHandlerConstructor = getIncrementalCacheHandlerConstructor();
      const experimentalConfig =
        requiredServerFilesConfig.experimental ?? runtimeNextConfig.experimental;
      const cacheMaxMemorySize =
        typeof requiredServerFilesConfig.cacheMaxMemorySize === 'number'
          ? requiredServerFilesConfig.cacheMaxMemorySize
          : typeof runtimeNextConfig.cacheMaxMemorySize === 'number'
            ? runtimeNextConfig.cacheMaxMemorySize
            : undefined;
      const allowedRevalidateHeaderKeys = Array.isArray(
        experimentalConfig?.allowedRevalidateHeaderKeys
      )
        ? experimentalConfig.allowedRevalidateHeaderKeys.filter(
            (item): item is string => typeof item === 'string'
          )
        : undefined;
      const incrementalCache = new IncrementalCache({
        dev: false,
        minimalMode: true,
        flushToDisk: experimentalConfig?.isrFlushToDisk,
        serverDistDir: path.join(edgeRuntimeDistDir, 'server'),
        requestHeaders,
        maxMemoryCacheSize: cacheMaxMemorySize,
        getPrerenderManifest: () => prerenderManifest,
        fetchCacheKeyPrefix: experimentalConfig?.fetchCacheKeyPrefix,
        CurCacheHandler: cacheHandlerConstructor,
        allowedRevalidateHeaderKeys,
      });
      if (typeof incrementalCache.resetRequestCache === 'function') {
        incrementalCache.resetRequestCache();
      }
      return incrementalCache;
    } catch {
      return undefined;
    }
  }

  async function runEdgeFunctionOutput(
    output: RuntimeFunctionOutput,
    method: string | undefined,
    headers: IncomingHttpHeaders,
    requestUrl: URL,
    requestBody: Uint8Array,
    waitUntil: (prom: Promise<void>) => void,
    requestMeta?: RuntimeRequestMeta,
    timeoutMs?: number
  ): Promise<Response> {
    const edgeEnv = {
      ...(output.env ?? {}),
      ...(buildId ? { BUN_ADAPTER_BUILD_ID: buildId } : {}),
    };
    applyEdgeEnv(edgeEnv);
    const resolvedEntryKey = output.edgeRuntime?.entryKey ?? deriveEdgeEntryKey(output);
    const name = resolvedEntryKey.startsWith('middleware_')
      ? resolvedEntryKey.slice('middleware_'.length)
      : resolvedEntryKey;
    const normalizedEntrypoint = path.resolve(output.filePath);
    const importOrderCandidates = [...(output.assets ?? [])];
    if (
      !importOrderCandidates.some(
        (assetFile) => path.resolve(assetFile) === normalizedEntrypoint
      )
    ) {
      importOrderCandidates.unshift(output.filePath);
    }
    const seenEdgePaths = new Set<string>();
    const edgePaths: string[] = [];
    for (const assetFile of importOrderCandidates) {
      if (!canImportEdgeAsset(assetFile)) {
        continue;
      }
      const normalizedAssetPath = path.resolve(assetFile);
      if (seenEdgePaths.has(normalizedAssetPath)) {
        continue;
      }
      seenEdgePaths.add(normalizedAssetPath);
      edgePaths.push(normalizedAssetPath);
      await importEdgeChunk(normalizedAssetPath);
    }
    if (!sandboxRun) {
      const sandboxModule = require('next/dist/server/web/sandbox') as {
        run: (params: any) => Promise<{ response: Response; waitUntil: Promise<unknown> }>;
      };
      sandboxRun = sandboxModule.run;
    }
    const run = sandboxRun;
    const hasBody = canRequestHaveBody(method) && requestBody.byteLength > 0;
    const requestBodyBuffer = hasBody ? Buffer.from(requestBody) : null;
    const clonedRequestBody = hasBody
      ? {
          cloneBodyStream: () =>
            Readable.from(
              requestBodyBuffer && requestBodyBuffer.byteLength > 0 ? [requestBodyBuffer] : []
            ),
          finalize: async () => {},
        }
      : null;
    const edgeRequestUrl = new URL(requestUrl);
    const abortController = new AbortController();
    const incrementalCache = createEdgeIncrementalCache(headers);
    const runPromise = run({
      distDir: edgeRuntimeDistDir,
      name,
      paths: edgePaths,
      edgeFunctionEntry: {
        env: edgeEnv,
        wasm: output.wasmBindings ?? [],
        ...(output.assetBindings && output.assetBindings.length > 0
          ? { assets: output.assetBindings }
          : {}),
      },
      request: {
        headers,
        method: method || 'GET',
        nextConfig: edgeRequestNextConfig,
        url: edgeRequestUrl.toString(),
        page: {
          name: output.pathname.includes('/_next/data/') ? output.sourcePage : output.pathname,
        },
        ...(clonedRequestBody ? { body: clonedRequestBody } : {}),
        signal: abortController.signal,
        waitUntil,
        ...(requestMeta ? { requestMeta } : {}),
      },
      useCache: true,
      ...(incrementalCache ? { incrementalCache } : {}),
      clientAssetToken: edgeClientAssetToken,
    });
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            abortController.abort();
            reject(
              new Error(
                `[adapter-bun] edge function timed out after ${timeoutMs}ms (${output.pathname})`
              )
            );
          }, timeoutMs);
        });
        const timedResult = await Promise.race([runPromise, timeoutPromise]);
        waitUntil(Promise.resolve(timedResult.waitUntil).then(() => undefined));
        return timedResult.response;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }
    const result = await runPromise;
    waitUntil(Promise.resolve(result.waitUntil).then(() => undefined));
    return result.response;
  }

  async function invokeEdgeFunctionOutput(
    req: IncomingMessage,
    res: ServerResponse,
    output: RuntimeFunctionOutput,
    requestUrl: URL,
    requestBody: Uint8Array,
    requestMeta?: RuntimeRequestMeta
  ): Promise<void> {
    const configuredTimeout = Number.parseInt(
      process.env.ADAPTER_BUN_EDGE_FUNCTION_TIMEOUT_MS || '',
      10
    );
    const edgeTimeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : undefined;
    const maxAttempts = isReadMethod(req.method) ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const waitUntil = createWaitUntilCollector();
      try {
        const response = await runEdgeFunctionOutput(
          output,
          req.method,
          req.headers,
          requestUrl,
          requestBody,
          waitUntil.waitUntil,
          requestMeta,
          edgeTimeoutMs
        );
        await writeFetchResponse(req, res, response);
        void waitUntil.drain();
        return;
      } catch (error) {
        void waitUntil.drain();
        lastError = error;
        const isAbortLike =
          Boolean(error) &&
          typeof error === 'object' &&
          (() => {
            const record = error as { name?: unknown; message?: unknown };
            const name = typeof record.name === 'string' ? record.name : '';
            if (name === 'AbortError') {
              return true;
            }
            const message =
              typeof record.message === 'string' ? record.message.toLowerCase() : '';
            return message.includes('abort') || message.includes('timeout');
          })();
        if (attempt >= maxAttempts || !isAbortLike) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`[adapter-bun] edge function invocation failed (${output.pathname})`);
  }

  async function invokeEdgeMiddleware(
    middleware: RuntimeFunctionOutput,
    requestUrl: URL,
    method: string | undefined,
    headers: Headers,
    requestBody: ReadableStream<Uint8Array>
  ): Promise<Response> {
    const waitUntil = createWaitUntilCollector();
    const requestBodyBytes = canRequestHaveBody(method)
      ? await readReadableStreamBody(requestBody)
      : new Uint8Array(0);
    const incomingHeaders: IncomingHttpHeaders = {};
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    if (typeof getSetCookie === 'function') {
      for (const value of getSetCookie.call(headers)) {
        appendMutableHeader(incomingHeaders, 'set-cookie', value);
      }
    }
    headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        return;
      }
      appendMutableHeader(incomingHeaders, key, value);
    });
    const response = await runEdgeFunctionOutput(
      middleware,
      method,
      incomingHeaders,
      requestUrl,
      requestBodyBytes,
      waitUntil.waitUntil
    );
    void waitUntil.drain();
    return response;
  }

  return {
    invokeEdgeFunctionOutput,
    invokeEdgeMiddleware,
  };
}
