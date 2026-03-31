import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import './early-timers.js';
// Must run before loading @next/routing/route handlers so AsyncLocalStorage
// and other Next.js node polyfills are available in Bun runtime.
import 'next/dist/build/adapter/setup-node-env.external.js';
import {
  resolveRoutes,
  type Route,
  type RouteHas,
  type ResolveRoutesQuery,
  type ResolveRoutesResult,
} from '@next/routing';
import { getSharedPrerenderCacheStore } from './cache-store.js';
import { handleCacheHttpRequest } from './cache-http-server.js';
import { createInvokeOutput } from './invoke-output.js';
const DEFAULT_CACHE_HANDLER_MODE = 'http';
const DEFAULT_CACHE_ENDPOINT_PATH = '/_adapter/cache';
const DEFAULT_PORT = 3000;
const DEFAULT_HOSTNAME = '0.0.0.0';
const DEFAULT_KEEP_ALIVE_TIMEOUT = 75_000;
const REQUEST_BODY_BYTES_SYMBOL = Symbol.for('adapter-bun.request-body-bytes');
const RSC_HEADER = 'rsc';
const ACTION_HEADER = 'next-action';
const NEXT_ROUTER_PREFETCH_HEADER = 'next-router-prefetch';
const NEXT_ROUTER_SEGMENT_PREFETCH_HEADER = 'next-router-segment-prefetch';
const TEST_ROUTE = /\/[^/]*\[[^/]+\][^/]*(?=\/|$)/;
const TEST_STRICT_ROUTE = /\/\[[^/]+\](?=\/|$)/;
type CacheHandlerMode = 'sqlite' | 'http';
type RuntimeFunctionRuntime = 'nodejs' | 'edge';
type RuntimeRequestMetaValue = string | string[] | undefined;
type RuntimeRequestMetaParams = Record<string, RuntimeRequestMetaValue>;
type RuntimeRevalidateHeaders = Record<string, string | string[]>;
type RuntimeInternalRevalidate = (config: {
  urlPath: string;
  headers: RuntimeRevalidateHeaders;
  opts: { unstable_onlyGenerated?: boolean };
}) => Promise<void>;
interface RuntimeRequestMeta {
  initURL?: string;
  initProtocol?: string;
  hostname?: string;
  revalidate?: RuntimeInternalRevalidate;
  isRSCRequest?: true;
  isPrefetchRSCRequest?: true;
  segmentPrefetchRSCRequest?: string;
}
interface RuntimeCacheConfig {
  handlerMode?: CacheHandlerMode;
  endpointPath?: string;
  authToken?: string | null;
}
interface RuntimeRouteHasHeader {
  type: 'header' | 'cookie' | 'query';
  key: string;
  value?: string;
}
interface RuntimeRouteHasHost {
  type: 'host';
  value: string;
}
type RuntimeRouteHas = RuntimeRouteHasHeader | RuntimeRouteHasHost;
interface RuntimeRoute {
  sourceRegex: string;
  destination?: string;
  headers?: Record<string, string>;
  has?: RuntimeRouteHas[];
  missing?: RuntimeRouteHas[];
  status?: number;
}
interface RuntimeFallbackRouteParam {
  paramName: string;
  paramType: string;
}
interface RuntimePrerenderManifestDynamicRoute {
  fallback?: string | null | false;
  fallbackRouteParams?: RuntimeFallbackRouteParam[];
}
interface RuntimePrerenderManifest {
  dynamicRoutes?: Record<string, RuntimePrerenderManifestDynamicRoute>;
  preview?: {
    previewModeId?: string;
    previewModeSigningKey?: string;
    previewModeEncryptionKey?: string;
  };
  routes?: Record<string, unknown>;
  notFoundRoutes?: string[];
  version?: number;
}
interface RuntimeI18nConfig {
  defaultLocale: string;
  locales: string[];
  localeDetection?: false;
  domains?: Array<{
    defaultLocale: string;
    domain: string;
    http?: true;
    locales?: string[];
  }>;
}
interface RuntimeRoutingConfig {
  i18n?: RuntimeI18nConfig | null;
  caseSensitive?: boolean;
  beforeMiddleware: RuntimeRoute[];
  beforeFiles: RuntimeRoute[];
  afterFiles: RuntimeRoute[];
  dynamicRoutes: RuntimeRoute[];
  onMatch: RuntimeRoute[];
  fallback: RuntimeRoute[];
  shouldNormalizeNextData: boolean;
}
interface RuntimeNextImageConfig {
  loader?: string;
  unoptimized?: boolean;
  dangerouslyAllowLocalIP?: boolean;
  maximumResponseBody?: number;
}
interface RuntimeNextExperimentalConfig {
  imgOptConcurrency?: number | null;
  imgOptMaxInputPixels?: number;
  imgOptSequentialRead?: boolean | null;
  imgOptSkipMetadata?: boolean | null;
  imgOptTimeoutInSeconds?: number;
  isrFlushToDisk?: boolean;
  fetchCacheKeyPrefix?: string;
  allowedRevalidateHeaderKeys?: string[];
}
interface RuntimeNextConfig {
  output?: string;
  basePath?: string;
  cacheHandler?: string;
  cacheMaxMemorySize?: number;
  images?: RuntimeNextImageConfig;
  experimental?: RuntimeNextExperimentalConfig;
}
interface RuntimeRequiredServerFilesConfig {
  cacheHandler?: string;
  cacheMaxMemorySize?: number;
  experimental?: RuntimeNextExperimentalConfig;
}
interface RuntimeRequiredServerFilesManifest {
  config?: RuntimeRequiredServerFilesConfig;
}
interface RuntimeEdgeOutput {
  modulePath: string;
  entryKey: string;
  handlerExport: string;
}
interface RuntimeAssetBinding {
  name: string;
  filePath: string;
}
interface RuntimeMiddlewareRouteMatcherHas {
  type: 'header' | 'cookie' | 'query' | 'host';
  key?: string;
  value?: string;
}
interface RuntimeMiddlewareRouteMatcher {
  regexp: string;
  has?: RuntimeMiddlewareRouteMatcherHas[];
  missing?: RuntimeMiddlewareRouteMatcherHas[];
}
interface RuntimeFunctionOutput {
  id: string;
  pathname: string;
  sourcePage: string;
  runtime: RuntimeFunctionRuntime;
  filePath: string;
  edgeRuntime?: RuntimeEdgeOutput;
  assets?: string[];
  assetBindings?: RuntimeAssetBinding[];
  wasmBindings?: RuntimeAssetBinding[];
  env?: Record<string, string>;
}
interface ResolvedFunctionOutput {
  output: RuntimeFunctionOutput;
  params?: RuntimeRequestMetaParams;
}
interface DynamicOutputRouteSegmentStatic {
  type: 'static';
  value: string;
}
interface DynamicOutputRouteSegmentDynamic {
  type: 'dynamic';
  key: string;
}
interface DynamicOutputRouteSegmentCatchAll {
  type: 'catchall';
  key: string;
}
interface DynamicOutputRouteSegmentOptionalCatchAll {
  type: 'optionalCatchall';
  key: string;
}
type DynamicOutputRouteSegment =
  | DynamicOutputRouteSegmentStatic
  | DynamicOutputRouteSegmentDynamic
  | DynamicOutputRouteSegmentCatchAll
  | DynamicOutputRouteSegmentOptionalCatchAll;
interface DynamicOutputMatcher {
  sourcePage: string;
  pathname: string;
  segments: DynamicOutputRouteSegment[];
  staticSegmentCount: number;
  catchAllSegmentCount: number;
  optionalCatchAllSegmentCount: number;
}
interface RuntimeLookup {
  routingPathnames?: string[];
  pathnameAliasToCanonical?: Record<string, string>;
  functionPathnameToOutputPathname?: Record<string, string>;
  rscFunctionPathnameToOutputPathname?: Record<string, string>;
  sourcePageByPathname?: Record<string, string>;
  outputPathnamesBySourcePage?: Record<string, string[]>;
  staticAssetPathnameToAssetPathname?: Record<string, string>;
  dynamicMatchers?: DynamicOutputMatcher[];
  middlewareMatchers?: RuntimeMiddlewareRouteMatcher[] | null;
}
interface RuntimeSection {
  cache?: RuntimeCacheConfig | null;
  routing?: RuntimeRoutingConfig | null;
  middleware?: RuntimeFunctionOutput | null;
  functions?: RuntimeFunctionOutput[];
  resolvedPathnameToSourcePage?: Record<string, string>;
  lookup?: RuntimeLookup;
}
interface StaticAsset {
  pathname: string;
  stagedPath: string;
  contentType: string | null;
  cacheControl: string | null;
}
interface DeploymentManifest {
  server?: {
    port?: number;
    hostname?: string;
  };
  build?: {
    nextVersion?: string;
    buildId?: string;
    basePath?: string;
    trailingSlash?: boolean;
    i18n?: RuntimeI18nConfig | null;
    projectDir?: string;
    distDir?: string;
  };
  pathnames: string[];
  runtime?: RuntimeSection | null;
  staticAssets: StaticAsset[];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDynamicRoute(route: string, strict: boolean = true): boolean {
  const normalizedRoute = normalizePathnameForRouteMatching(route);
  if (strict) {
    return TEST_STRICT_ROUTE.test(normalizedRoute);
  }
  return TEST_ROUTE.test(normalizedRoute);
}
function getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
const INTERNAL_REQUEST_HEADERS = new Set([
  'x-middleware-rewrite',
  'x-middleware-redirect',
  'x-middleware-set-cookie',
  'x-middleware-skip',
  'x-middleware-override-headers',
  'x-middleware-next',
  'x-now-route-matches',
  'x-matched-path',
]);
function markConnectionClose(res: ServerResponse): void {
  res.shouldKeepAlive = false;
  if (!res.headersSent) {
    res.setHeader('connection', 'close');
  }
}
function pathnameEqualsWithRootAlias(leftPathname: string, rightPathname: string): boolean {
  if (leftPathname === rightPathname) {
    return true;
  }
  return (
    getIndexAlias(leftPathname) === rightPathname ||
    getIndexAlias(rightPathname) === leftPathname
  );
}
function hasInterceptionMarkerPrefix(segment: string): boolean {
  return (
    segment.startsWith('(.)') ||
    segment.startsWith('(..)') ||
    segment.startsWith('(...)')
  );
}
function hasInterceptionMarkerInPathname(pathname: string): boolean {
  return pathname.split('/').some((segment) => hasInterceptionMarkerPrefix(segment));
}
function normalizePathnameForRouteMatching(pathname: string): string {
  if (!pathname.includes('(.')) {
    return pathname;
  }
  return pathname
    .split('/')
    .map((segment) => {
      let normalizedSegment = segment;
      while (hasInterceptionMarkerPrefix(normalizedSegment)) {
        if (normalizedSegment.startsWith('(.)')) {
          normalizedSegment = normalizedSegment.slice('(.)'.length);
          continue;
        }
        if (normalizedSegment.startsWith('(..)')) {
          normalizedSegment = normalizedSegment.slice('(..)'.length);
          continue;
        }
        if (normalizedSegment.startsWith('(...)')) {
          normalizedSegment = normalizedSegment.slice('(...)'.length);
          continue;
        }
      }
      return normalizedSegment;
    })
    .join('/');
}
function getNextDataNormalizedPathname(
  requestPathname: string,
  buildId: string,
  basePath: string,
  decodeSquareBrackets: boolean = true
): string | null {
  if (!buildId) {
    return null;
  }
  const nextDataPrefix = `${basePath}/_next/data/${buildId}/`;
  if (!requestPathname.startsWith(nextDataPrefix)) {
    return null;
  }
  let normalizedPath = requestPathname.slice(nextDataPrefix.length);
  if (!normalizedPath.endsWith('.json')) {
    return null;
  }
  normalizedPath = normalizedPath.slice(0, -'.json'.length);
  if (normalizedPath === 'index') {
    return basePath || '/';
  }
  if (decodeSquareBrackets) {
    // Preserve encoded slashes (%2F) for dynamic segment matching, but decode
    // encoded square brackets so static paths like /dynamic/[first] match.
    normalizedPath = normalizedPath
      .replace(/%5B/gi, '[')
      .replace(/%5D/gi, ']');
  }
  return `${basePath}${basePath ? '/' : '/'}${normalizedPath}`;
}
function toNextDataPathname(
  pathname: string,
  buildId: string,
  basePath: string
): string | null {
  if (!buildId) {
    return null;
  }
  const withoutBasePath = getPathnameWithoutBasePath(pathname, basePath);
  const normalizedPathname = removePathnameTrailingSlash(withoutBasePath);
  const dataRoutePathname = normalizedPathname === '/' ? '/index' : normalizedPathname;
  return `${basePath}/_next/data/${buildId}${dataRoutePathname}.json`;
}
function normalizeCacheControlHeader(
  req: IncomingMessage,
  value: unknown,
  nextCacheHeaderValue: unknown
): string {
  const raw = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  const normalized = raw.trim();
  if (normalized.length === 0) {
    return raw;
  }
  const lower = normalized.toLowerCase();
  const hasNextCacheMarker =
    typeof nextCacheHeaderValue === 'string' && nextCacheHeaderValue.length > 0;
  const isDataRequest =
    typeof req.url === 'string' && req.url.includes('/_next/data/');
  const isRscRequest =
    getSingleHeaderValue(req.headers[RSC_HEADER]) === '1' ||
    (typeof req.url === 'string' && req.url.includes('_rsc='));
  if (isRscRequest) {
    return normalized;
  }
  if (
    hasNextCacheMarker &&
    !isDataRequest &&
    lower === 'private, no-cache, no-store, max-age=0, must-revalidate'
  ) {
    // Pages-router fallback HTML responses in deploy mode still flow through
    // Next's private no-store branch on the first MISS. Deployed environments
    // expose these as public must-revalidate responses instead.
    return 'public, max-age=0, must-revalidate';
  }
  if (lower.includes('immutable')) {
    return normalized;
  }
  if (lower.includes('s-maxage=')) {
    return 'public, max-age=0, must-revalidate';
  }
  return normalized;
}
function patchCacheControlHeader(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return;
  }
  const mutableRes = res as unknown as {
    setHeader: (...args: unknown[]) => ServerResponse;
    writeHead: (...args: unknown[]) => ServerResponse;
  };
  const originalSetHeader = res.setHeader.bind(res);
  mutableRes.setHeader = (name: unknown, value: unknown) => {
    if (typeof name === 'string' && name.toLowerCase() === 'cache-control') {
      return originalSetHeader(
        name,
        normalizeCacheControlHeader(req, value, res.getHeader('x-nextjs-cache'))
      );
    }
    return originalSetHeader(name as string, value as never);
  };
  const originalWriteHead = res.writeHead.bind(res) as (
    ...args: unknown[]
  ) => ServerResponse;
  mutableRes.writeHead = (
    statusCode: unknown,
    statusMessage?: unknown,
    headers?: unknown
  ) => {
    let resolvedStatusMessage = statusMessage;
    let resolvedHeaders = headers;
    if (resolvedHeaders === undefined && isRecord(resolvedStatusMessage)) {
      resolvedHeaders = resolvedStatusMessage;
      resolvedStatusMessage = undefined;
    }
    if (isRecord(resolvedHeaders)) {
      let resolvedNextCacheHeaderValue: unknown = undefined;
      for (const [key, value] of Object.entries(resolvedHeaders)) {
        if (key.toLowerCase() === 'x-nextjs-cache') {
          resolvedNextCacheHeaderValue = value;
          break;
        }
      }
      const nextCacheHeaderValue =
        resolvedNextCacheHeaderValue ?? res.getHeader('x-nextjs-cache');
      for (const key of Object.keys(resolvedHeaders)) {
        if (key.toLowerCase() !== 'cache-control') {
          continue;
        }
        resolvedHeaders[key] = normalizeCacheControlHeader(
          req,
          resolvedHeaders[key],
          nextCacheHeaderValue
        );
      }
    }
    if (resolvedStatusMessage === undefined) {
      return originalWriteHead(statusCode, resolvedHeaders);
    }
    return originalWriteHead(statusCode, resolvedStatusMessage, resolvedHeaders);
  };
}
function patchResponseAppendHeader(res: ServerResponse): void {
  if (typeof res.appendHeader !== 'function') {
    return;
  }
  const originalAppendHeader = res.appendHeader.bind(res) as (
    ...args: unknown[]
  ) => ServerResponse;
  const mutableRes = res as unknown as {
    appendHeader: (...args: unknown[]) => ServerResponse;
  };
  mutableRes.appendHeader = (name: unknown, value: unknown) => {
    if (typeof name !== 'string' || typeof value !== 'string') {
      return originalAppendHeader(name as string, value as never);
    }
    const existingValue = res.getHeader(name);
    const existingValues =
      existingValue === undefined
        ? []
        : Array.isArray(existingValue)
          ? existingValue.map((item) => String(item))
          : [String(existingValue)];
    if (!existingValues.includes(value)) {
      res.setHeader(name, [...existingValues, value]);
    }
    return res;
  };
}
function patchRscContentTypeHeader(
  res: ServerResponse,
  shouldRewrite: () => boolean = () => true
): void {
  const mutableRes = res as unknown as {
    setHeader: (...args: unknown[]) => ServerResponse;
    writeHead: (...args: unknown[]) => ServerResponse;
    appendHeader?: (...args: unknown[]) => ServerResponse;
  };
  const normalizeContentTypeValue = (value: unknown): unknown => {
    if (!shouldRewrite()) {
      return value;
    }
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') {
      return value;
    }
    if (raw.toLowerCase().startsWith('text/html')) {
      return 'text/x-component';
    }
    return value;
  };
  const normalizeRawHeaders = (headers: unknown[]): unknown[] => {
    const nextHeaders = [...headers];
    for (let index = 0; index < nextHeaders.length - 1; index += 2) {
      const headerName = nextHeaders[index];
      if (
        typeof headerName === 'string' &&
        headerName.toLowerCase() === 'content-type'
      ) {
        nextHeaders[index + 1] = normalizeContentTypeValue(nextHeaders[index + 1]);
      }
    }
    return nextHeaders;
  };
  const originalSetHeader = res.setHeader.bind(res);
  mutableRes.setHeader = (name: unknown, value: unknown) => {
    if (typeof name === 'string' && name.toLowerCase() === 'content-type') {
      return originalSetHeader(name, normalizeContentTypeValue(value) as never);
    }
    return originalSetHeader(name as string, value as never);
  };
  if (typeof res.appendHeader === 'function') {
    const originalAppendHeader = res.appendHeader.bind(res) as (
      ...args: unknown[]
    ) => ServerResponse;
    mutableRes.appendHeader = (name: unknown, value: unknown) => {
      if (typeof name === 'string' && name.toLowerCase() === 'content-type') {
        return originalAppendHeader(name, normalizeContentTypeValue(value));
      }
      return originalAppendHeader(name as string, value);
    };
  }
  const originalWriteHead = res.writeHead.bind(res) as (
    ...args: unknown[]
  ) => ServerResponse;
  mutableRes.writeHead = (
    statusCode: unknown,
    statusMessage?: unknown,
    headers?: unknown
  ) => {
    let resolvedStatusMessage = statusMessage;
    let resolvedHeaders = headers;
    if (
      resolvedHeaders === undefined &&
      (isRecord(resolvedStatusMessage) || Array.isArray(resolvedStatusMessage))
    ) {
      resolvedHeaders = resolvedStatusMessage;
      resolvedStatusMessage = undefined;
    }
    if (Array.isArray(resolvedHeaders)) {
      resolvedHeaders = normalizeRawHeaders(resolvedHeaders);
    } else if (isRecord(resolvedHeaders)) {
      for (const key of Object.keys(resolvedHeaders)) {
        if (key.toLowerCase() !== 'content-type') {
          continue;
        }
        resolvedHeaders[key] = normalizeContentTypeValue(resolvedHeaders[key]);
      }
    }
    if (resolvedStatusMessage === undefined) {
      return originalWriteHead(statusCode as number, resolvedHeaders);
    }
    return originalWriteHead(
      statusCode as number,
      resolvedStatusMessage,
      resolvedHeaders
    );
  };
}
function getNormalizedHostHeader(
  value: string | string[] | undefined
): string | undefined {
  const host = Array.isArray(value) ? value[0] : value;
  if (!host || typeof host !== 'string') {
    return undefined;
  }
  const normalizedHost = host.split(',')[0]?.trim();
  return normalizedHost && normalizedHost.length > 0 ? normalizedHost : undefined;
}
function resolveRequestOrigin(
  headers: Record<string, string | string[] | undefined>,
  fallbackOrigin: string
): string {
  let fallbackHost = '127.0.0.1';
  let fallbackProtocol = 'http';
  try {
    const fallbackUrl = new URL(fallbackOrigin);
    fallbackHost = fallbackUrl.host;
    fallbackProtocol = fallbackUrl.protocol.replace(/:$/, '') || 'http';
  } catch {}
  const host =
    getNormalizedHostHeader(headers['x-forwarded-host']) ??
    getNormalizedHostHeader(headers.host) ??
    fallbackHost;
  const forwardedProtoHeader = Array.isArray(headers['x-forwarded-proto'])
    ? headers['x-forwarded-proto'][0]
    : headers['x-forwarded-proto'];
  const normalizedForwardedProto =
    typeof forwardedProtoHeader === 'string'
      ? forwardedProtoHeader.split(',')[0]?.trim().toLowerCase()
      : undefined;
  const forwardedProto =
    normalizedForwardedProto === 'http' || normalizedForwardedProto === 'https'
      ? normalizedForwardedProto
      : undefined;
  const forwardedHeader = Array.isArray(headers.forwarded)
    ? headers.forwarded[0]
    : headers.forwarded;
  const normalizedForwardedHeader =
    typeof forwardedHeader === 'string'
      ? forwardedHeader.split(',')[0]?.trim() ?? ''
      : '';
  const forwardedMatch = normalizedForwardedHeader.match(/(?:^|;)\\s*proto=([^;\\s]+)/i);
  const forwardedProtoFromHeader = forwardedMatch?.[1]
    ?.replace(/^"|"$/g, '')
    .toLowerCase();
  const protocol =
    forwardedProto ??
    (forwardedProtoFromHeader === 'http' || forwardedProtoFromHeader === 'https'
      ? forwardedProtoFromHeader
      : undefined) ??
    fallbackProtocol;
  return `${protocol}://${host}`;
}
function toRequestUrl(req: IncomingMessage, fallbackOrigin: string): URL {
  const origin = resolveRequestOrigin(req.headers, fallbackOrigin);
  try {
    return new URL(req.url || '/', origin);
  } catch {
    return new URL('/', origin);
  }
}
function canRequestHaveBody(method: string | undefined): boolean {
  return method !== 'GET' && method !== 'HEAD';
}
function installReplayStream(req: IncomingMessage, body: Uint8Array): void {
  const replayStream = Readable.from(body);
  // Preserve request metadata for consumers (for example `request` package)
  // that infer outbound method/headers from the stream source during `pipe()`.
  (replayStream as Readable & {
    method?: string;
    headers?: IncomingHttpHeaders;
    url?: string;
  }).method = req.method;
  (replayStream as Readable & { headers?: IncomingHttpHeaders }).headers = req.headers;
  (replayStream as Readable & { url?: string }).url = req.url;
  const mutableReq = req as any;
  const originalOn = req.on.bind(req);
  const originalOnce = req.once.bind(req);
  const originalRemoveListener = req.removeListener.bind(req);
  mutableReq.on = (event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'data' || event === 'end' || event === 'error' || event === 'readable') {
      replayStream.on(event, listener);
      return req;
    }
    return originalOn(event, listener);
  };
  mutableReq.once = (event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'data' || event === 'end' || event === 'error' || event === 'readable') {
      replayStream.once(event, listener);
      return req;
    }
    return originalOnce(event, listener);
  };
  mutableReq.removeListener = (
    event: string,
    listener: (...args: unknown[]) => void
  ) => {
    if (event === 'data' || event === 'end' || event === 'error' || event === 'readable') {
      replayStream.removeListener(event, listener);
      return req;
    }
    return originalRemoveListener(event, listener);
  };
  mutableReq.pipe = replayStream.pipe.bind(replayStream);
  mutableReq.read = replayStream.read.bind(replayStream);
  mutableReq.pause = replayStream.pause.bind(replayStream);
  mutableReq.resume = replayStream.resume.bind(replayStream);
  mutableReq.setEncoding = replayStream.setEncoding.bind(replayStream);
  mutableReq.unshift = replayStream.unshift.bind(replayStream);
  mutableReq[Symbol.asyncIterator] = replayStream[Symbol.asyncIterator].bind(replayStream);
}
async function getBufferedRequestBody(req: IncomingMessage): Promise<Uint8Array> {
  const existing = (req as any)[REQUEST_BODY_BYTES_SYMBOL] as Uint8Array | undefined;
  if (existing) {
    return existing;
  }
  if (!canRequestHaveBody(req.method)) {
    const empty = new Uint8Array(0);
    (req as any)[REQUEST_BODY_BYTES_SYMBOL] = empty;
    return empty;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<unknown>) {
    if (chunk === undefined || chunk === null) {
      continue;
    }
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
      continue;
    }
    if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    }
  }
  const body = Buffer.concat(chunks);
  req.headers['content-length'] = String(body.byteLength);
  delete req.headers['transfer-encoding'];
  installReplayStream(req, body);
  const bytes = new Uint8Array(body);
  (req as any)[REQUEST_BODY_BYTES_SYMBOL] = bytes;
  return bytes;
}
function createBodyStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
}
function toRequestHeaders(headers: IncomingHttpHeaders): Headers {
  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        requestHeaders.append(key, item);
      }
      continue;
    }
    requestHeaders.append(key, value);
  }
  return requestHeaders;
}
function appendMutableHeader(
  headers: IncomingHttpHeaders,
  key: string,
  value: string
): void {
  const current = headers[key];
  if (current === undefined) {
    headers[key] = value;
    return;
  }
  if (Array.isArray(current)) {
    current.push(value);
    return;
  }
  headers[key] = [current, value];
}
function replaceRequestHeaders(req: IncomingMessage, headers: Headers): void {
  const nextHeaders: IncomingHttpHeaders = {};
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    for (const cookie of getSetCookie.call(headers)) {
      appendMutableHeader(nextHeaders, 'set-cookie', cookie);
    }
  }
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      return;
    }
    appendMutableHeader(nextHeaders, key, value);
  });
  (req as IncomingMessage & { headers: IncomingHttpHeaders }).headers = nextHeaders;
}
function applyResponseHeaders(res: ServerResponse, headers: Headers): void {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    const cookies = getSetCookie.call(headers);
    if (cookies.length > 0) {
      res.setHeader('set-cookie', cookies);
    }
  }
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      return;
    }
    res.setHeader(key, value);
  });
}
function removePathnameTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}
function applyConfiguredTrailingSlash(pathname: string): string {
  if (!trailingSlash || pathname === '/' || pathname.endsWith('/')) {
    return pathname;
  }
  const lastSegment = pathname.split('/').pop() ?? '';
  if (lastSegment.includes('.')) {
    return pathname;
  }
  return `${pathname}/`;
}
function toRoutingI18n(
  value: RuntimeI18nConfig | null | undefined
):
  | {
      defaultLocale: string;
      domains?: Array<{
        defaultLocale: string;
        domain: string;
        http?: true;
        locales?: string[];
      }>;
      localeDetection?: false;
      locales: string[];
    }
  | undefined {
  if (!value) {
    return undefined;
  }
  return {
    defaultLocale: value.defaultLocale,
    locales: [...value.locales],
    ...(value.localeDetection === false ? { localeDetection: false } : {}),
    ...(value.domains
      ? {
          domains: value.domains.map((domain) => ({
            defaultLocale: domain.defaultLocale,
            domain: domain.domain,
            ...(domain.http ? { http: true } : {}),
            ...(domain.locales ? { locales: [...domain.locales] } : {}),
          })),
        }
      : {}),
  };
}
function getPathnameWithoutBasePath(pathname: string, basePath: string): string {
  const withoutBasePath =
    basePath && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length) || '/'
      : pathname;
  return withoutBasePath.length > 0 ? withoutBasePath : '/';
}
function getLocaleFromPathname(
  pathname: string,
  basePath: string,
  i18n: ReturnType<typeof toRoutingI18n>
): string | undefined {
  if (!i18n) {
    return undefined;
  }
  const withoutBasePath = getPathnameWithoutBasePath(pathname, basePath);
  const firstSegment = withoutBasePath.split('/').filter(Boolean)[0];
  if (firstSegment && i18n.locales.includes(firstSegment)) {
    return firstSegment;
  }
  return undefined;
}
async function writeFetchResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
  options?: {
    statusOverride?: number;
    headerOverride?: Headers;
  }
): Promise<void> {
  res.statusCode = options?.statusOverride ?? response.status;
  if (options?.headerOverride) {
    applyResponseHeaders(res, options.headerOverride);
  } else {
    applyResponseHeaders(res, response.headers);
  }
  if (req.method === 'HEAD' || response.body === null) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value && value.byteLength > 0) {
      res.write(Buffer.from(value));
    }
  }
  res.end();
}
async function serveStaticAsset(
  req: IncomingMessage,
  res: ServerResponse,
  adapterDir: string,
  asset: StaticAsset
): Promise<boolean> {
  const absolutePath = path.join(adapterDir, asset.stagedPath);
  const file = Bun.file(absolutePath);
  let body: Buffer;
  try {
    const bytes = await file.arrayBuffer();
    body = Buffer.from(bytes);
  } catch {
    return false;
  }
  if (asset.contentType) {
    res.setHeader('content-type', asset.contentType);
  } else if (file.type) {
    res.setHeader('content-type', file.type);
  }
  if (asset.cacheControl) {
    res.setHeader('cache-control', asset.cacheControl);
  } else if (
    asset.pathname.endsWith('/robots.txt') ||
    asset.pathname.endsWith('/manifest.webmanifest') ||
    asset.pathname.endsWith('/sitemap.xml')
  ) {
    res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
  }
  res.setHeader('content-length', String(body.byteLength));
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  res.end(body);
  return true;
}
type ResolveRoutesResultLegacyShape = Partial<ResolveRoutesResult> & {
  matchedPathname?: unknown;
};
function toResolveRoutesQueryFromRouteMatches(
  routeMatches: Record<string, string> | undefined,
  _matchedPathname: string
): ResolveRoutesQuery | undefined {
  if (!routeMatches) {
    return undefined;
  }
  const query: ResolveRoutesQuery = {};
  for (const [key, value] of Object.entries(routeMatches)) {
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }
    if (/^[0-9]+$/.test(key)) {
      continue;
    }
    query[key] = value;
  }
  return Object.keys(query).length > 0 ? query : undefined;
}
function normalizeResolveRoutesResultShape(
  result: ResolveRoutesResult,
  resolveUrl: URL
): ResolveRoutesResult {
  if (typeof result.resolvedPathname === 'string') {
    return result;
  }
  const legacyResult = result as ResolveRoutesResultLegacyShape;
  const matchedPathname =
    typeof legacyResult.matchedPathname === 'string'
      ? legacyResult.matchedPathname
      : undefined;
  if (!matchedPathname) {
    return result;
  }
  const routeMatches =
    legacyResult.routeMatches && isRecord(legacyResult.routeMatches)
      ? (legacyResult.routeMatches as Record<string, string>)
      : undefined;
  const routeQuery = toResolveRoutesQueryFromRouteMatches(
    routeMatches,
    matchedPathname
  );
  const searchQuery: ResolveRoutesQuery = {};
  for (const [key, value] of resolveUrl.searchParams.entries()) {
    const existing = searchQuery[key];
    if (existing === undefined) {
      searchQuery[key] = value;
      continue;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      continue;
    }
    searchQuery[key] = [existing, value];
  }
  const hasSearchQuery = Object.keys(searchQuery).length > 0;
  const resolvedQuery =
    hasSearchQuery || routeQuery
      ? {
          ...(hasSearchQuery ? searchQuery : {}),
          ...(routeQuery ?? {}),
        }
      : undefined;
  return {
    ...result,
    resolvedPathname: matchedPathname,
    ...(resolvedQuery ? { resolvedQuery } : {}),
    invocationTarget: {
      pathname: resolveUrl.pathname,
      query: resolvedQuery ?? {},
    },
  };
}
function toRequestMeta({
  requestUrl,
  requestHeaders,
  revalidate,
}: {
  requestUrl: URL;
  requestHeaders: IncomingHttpHeaders;
  revalidate?: RuntimeInternalRevalidate;
}): RuntimeRequestMeta {
  const rscHeaderValue = getSingleHeaderValue(requestHeaders[RSC_HEADER]);
  const prefetchHeaderValue = getSingleHeaderValue(
    requestHeaders[NEXT_ROUTER_PREFETCH_HEADER]
  );
  const segmentPrefetchHeaderValue = getSingleHeaderValue(
    requestHeaders[NEXT_ROUTER_SEGMENT_PREFETCH_HEADER]
  );
  const meta: RuntimeRequestMeta = {
    initURL: requestUrl.toString(),
    initProtocol: requestUrl.protocol.replace(/:$/, '') || 'http',
    hostname: requestUrl.hostname,
    ...(revalidate ? { revalidate } : {}),
    ...(rscHeaderValue === '1' ? { isRSCRequest: true } : {}),
    ...(rscHeaderValue === '1' && prefetchHeaderValue === '1'
      ? { isPrefetchRSCRequest: true }
      : {}),
    ...(rscHeaderValue === '1' &&
    prefetchHeaderValue === '1' &&
    typeof segmentPrefetchHeaderValue === 'string' &&
    segmentPrefetchHeaderValue.length > 0
      ? {
          segmentPrefetchRSCRequest: segmentPrefetchHeaderValue,
        }
      : {}),
  };
  return meta;
}
function createEmptyPrerenderManifest(): RuntimePrerenderManifest {
  return {
    version: 4,
    routes: {},
    dynamicRoutes: {},
    notFoundRoutes: [],
    preview: {
      previewModeId: '',
      previewModeSigningKey: '',
      previewModeEncryptionKey: '',
    },
  };
}
async function loadPrerenderManifest(
  distDir: string | undefined
): Promise<RuntimePrerenderManifest> {
  if (!distDir) {
    return createEmptyPrerenderManifest();
  }
  const prerenderManifestPath = path.join(distDir, 'prerender-manifest.json');
  const prerenderManifestFile = Bun.file(prerenderManifestPath);
  if (!(await prerenderManifestFile.exists())) {
    return createEmptyPrerenderManifest();
  }
  try {
    const prerenderManifestValue = (await prerenderManifestFile.json()) as unknown;
    if (isRecord(prerenderManifestValue)) {
      return prerenderManifestValue as RuntimePrerenderManifest;
    }
  } catch {}
  return createEmptyPrerenderManifest();
}
const adapterDir = import.meta.dirname;
const manifestPath = path.join(adapterDir, 'deployment-manifest.json');
const manifest = (await Bun.file(manifestPath).json()) as DeploymentManifest;
const buildId = typeof manifest.build?.buildId === 'string' ? manifest.build.buildId : '';
const basePath = typeof manifest.build?.basePath === 'string' ? manifest.build.basePath : '';
const trailingSlash = Boolean(manifest.build?.trailingSlash);
const manifestDistDir =
  typeof manifest.build?.distDir === 'string' ? manifest.build.distDir : undefined;
const runtimeNextConfigPath = path.join(adapterDir, 'runtime-next-config.json');
let runtimeNextConfig: RuntimeNextConfig = {};
try {
  const runtimeNextConfigValue = (await Bun.file(runtimeNextConfigPath).json()) as unknown;
  if (isRecord(runtimeNextConfigValue)) {
    runtimeNextConfig = runtimeNextConfigValue as RuntimeNextConfig;
  }
} catch {
  runtimeNextConfig = {};
}
const requiredServerFilesPath = manifestDistDir
  ? path.join(manifestDistDir, 'required-server-files.json')
  : null;
let requiredServerFilesConfig: RuntimeRequiredServerFilesConfig = {};
if (requiredServerFilesPath) {
  try {
    const requiredServerFilesValue = (await Bun.file(requiredServerFilesPath).json()) as unknown;
    if (isRecord(requiredServerFilesValue)) {
      const configValue = (requiredServerFilesValue as RuntimeRequiredServerFilesManifest)
        .config;
      if (isRecord(configValue)) {
        requiredServerFilesConfig = configValue as RuntimeRequiredServerFilesConfig;
      }
    }
  } catch {
    requiredServerFilesConfig = {};
  }
}
const prerenderManifest = await loadPrerenderManifest(manifestDistDir);
// NEXT_ADAPTER_PATH is required at build-time to activate adapter hooks, but
// keeping it at runtime changes Next.js request handling branches in ways that
// conflict with this standalone server entry.
delete process.env.NEXT_ADAPTER_PATH;
// Tell the cache handler where to find cache.db.
process.env.BUN_ADAPTER_CACHE_DB_PATH = path.join(adapterDir, 'cache.db');
const requestedPort = Number.parseInt(process.env.PORT || '', 10);
const manifestPortCandidate = manifest.server?.port;
const port =
  Number.isFinite(requestedPort) && requestedPort > 0
    ? requestedPort
    : (typeof manifestPortCandidate === 'number' &&
      Number.isFinite(manifestPortCandidate) &&
      manifestPortCandidate > 0
        ? manifestPortCandidate
        : DEFAULT_PORT);
const manifestHostnameCandidate = manifest.server?.hostname;
const listenHostname =
  typeof manifestHostnameCandidate === 'string' && manifestHostnameCandidate.length > 0
    ? manifestHostnameCandidate
    : DEFAULT_HOSTNAME;
const defaultInternalOrigin = `http://127.0.0.1:${port}`;
if (buildId) {
  process.env.BUN_ADAPTER_BUILD_ID = buildId;
}
const internalRevalidate: RuntimeInternalRevalidate = async ({
  urlPath,
  headers,
  opts,
}) => {
  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        requestHeaders.append(key, item);
      }
      continue;
    }
    requestHeaders.set(key, value);
  }
  const targetUrl = new URL(
    urlPath,
    resolveRequestOrigin(headers, defaultInternalOrigin)
  );
  const response = await fetch(targetUrl, {
    method: 'HEAD',
    headers: requestHeaders,
  });
  const cacheHeader =
    response.headers.get('x-vercel-cache') ??
    response.headers.get('x-nextjs-cache');
  if (
    cacheHeader?.toUpperCase() !== 'REVALIDATED' &&
    response.status !== 200 &&
    !(response.status === 404 && opts.unstable_onlyGenerated)
  ) {
    throw new Error(`Invalid response ${response.status}`);
  }
};
const cacheConfig = manifest.runtime?.cache;
const cacheRuntime: {
  handlerMode: CacheHandlerMode;
  endpointPath: string;
  authToken: string;
} = {
  handlerMode: cacheConfig?.handlerMode === 'sqlite' ? 'sqlite' : DEFAULT_CACHE_HANDLER_MODE,
  endpointPath:
    typeof cacheConfig?.endpointPath === 'string' && cacheConfig.endpointPath.length > 0
      ? cacheConfig.endpointPath
      : DEFAULT_CACHE_ENDPOINT_PATH,
  authToken: typeof cacheConfig?.authToken === 'string' ? cacheConfig.authToken : '',
};
if (cacheRuntime.handlerMode === 'http') {
  const cacheAuthToken =
    process.env.BUN_ADAPTER_CACHE_HTTP_TOKEN ||
    cacheRuntime.authToken ||
    crypto.randomUUID();
  process.env.BUN_ADAPTER_CACHE_HTTP_TOKEN = cacheAuthToken;
  process.env.BUN_ADAPTER_CACHE_HTTP_URL = new URL(
    cacheRuntime.endpointPath,
    defaultInternalOrigin
  ).toString();
}
const runtimeRoutingConfig = manifest.runtime?.routing ?? null;
const runtimeRouting = runtimeRoutingConfig;
const runtimeI18n = toRoutingI18n(runtimeRoutingConfig?.i18n);
const runtimeMiddleware = manifest.runtime?.middleware ?? null;
const runtimeLookup = manifest.runtime?.lookup ?? null;
const runtimeLookupPathnameAliasToCanonical = isRecord(runtimeLookup?.pathnameAliasToCanonical)
  ? (runtimeLookup.pathnameAliasToCanonical as Record<string, string>)
  : {};
const runtimeLookupFunctionPathnameToOutputPathname = isRecord(
  runtimeLookup?.functionPathnameToOutputPathname
)
  ? (runtimeLookup.functionPathnameToOutputPathname as Record<string, string>)
  : {};
const runtimeLookupRscFunctionPathnameToOutputPathname = isRecord(
  runtimeLookup?.rscFunctionPathnameToOutputPathname
)
  ? (runtimeLookup.rscFunctionPathnameToOutputPathname as Record<string, string>)
  : {};
const runtimeLookupSourcePageByPathname = isRecord(runtimeLookup?.sourcePageByPathname)
  ? (runtimeLookup.sourcePageByPathname as Record<string, string>)
  : {};
const runtimeLookupOutputPathnamesBySourcePage = isRecord(
  runtimeLookup?.outputPathnamesBySourcePage
)
  ? (runtimeLookup.outputPathnamesBySourcePage as Record<string, string[]>)
  : {};
const runtimeLookupStaticAssetPathnameToAssetPathname = isRecord(
  runtimeLookup?.staticAssetPathnameToAssetPathname
)
  ? (runtimeLookup.staticAssetPathnameToAssetPathname as Record<string, string>)
  : {};
const runtimeLookupRoutingPathnames = Array.isArray(runtimeLookup?.routingPathnames)
  ? runtimeLookup.routingPathnames.filter(
      (pathname): pathname is string =>
        typeof pathname === 'string' && pathname.length > 0
    )
  : [];
const runtimeLookupDynamicMatchers = Array.isArray(runtimeLookup?.dynamicMatchers)
  ? runtimeLookup.dynamicMatchers
  : [];
const runtimeLookupMiddlewareMatchers = Array.isArray(runtimeLookup?.middlewareMatchers)
  ? runtimeLookup.middlewareMatchers
  : null;
const runtimeRoutingMiddlewareMatchers =
  runtimeLookupMiddlewareMatchers && runtimeLookupMiddlewareMatchers.length > 0
    ? runtimeLookupMiddlewareMatchers
        .map((matcher) => {
          if (typeof matcher.regexp !== 'string' || matcher.regexp.length === 0) {
            return null;
          }
          const toRouteHas = (
            value: RuntimeMiddlewareRouteMatcherHas
          ): RouteHas | null => {
            if (value.type === 'host') {
              if (typeof value.value !== 'string' || value.value.length === 0) {
                return null;
              }
              return {
                type: 'host',
                value: value.value,
              };
            }
            if (typeof value.key !== 'string' || value.key.length === 0) {
              return null;
            }
            return {
              type: value.type,
              key: value.key,
              ...(typeof value.value === 'string' ? { value: value.value } : {}),
            };
          };
          const has = Array.isArray(matcher.has)
            ? matcher.has
                .map((entry) => toRouteHas(entry))
                .filter((entry): entry is RouteHas => Boolean(entry))
            : [];
          const missing = Array.isArray(matcher.missing)
            ? matcher.missing
                .map((entry) => toRouteHas(entry))
                .filter((entry): entry is RouteHas => Boolean(entry))
            : [];
          return {
            sourceRegex: matcher.regexp,
            ...(has.length > 0 ? { has } : {}),
            ...(missing.length > 0 ? { missing } : {}),
          };
        })
        .filter((matcher): matcher is Route => Boolean(matcher))
    : undefined;
const runtimeFunctionOutputs = manifest.runtime?.functions ?? [];
const runtimeResolvedPathnameToSourcePage =
  manifest.runtime?.resolvedPathnameToSourcePage ?? {};
const functionOutputByPathname = new Map<string, RuntimeFunctionOutput>();
for (const output of runtimeFunctionOutputs) {
  functionOutputByPathname.set(output.pathname, output);
}
const functionOutputsBySourcePage = new Map<string, RuntimeFunctionOutput[]>();
if (isRecord(runtimeLookupOutputPathnamesBySourcePage)) {
  for (const [sourcePage, outputPathnames] of Object.entries(
    runtimeLookupOutputPathnamesBySourcePage
  )) {
    if (!Array.isArray(outputPathnames) || outputPathnames.length === 0) {
      continue;
    }
    const outputs: RuntimeFunctionOutput[] = [];
    for (const outputPathname of outputPathnames) {
      if (typeof outputPathname !== 'string' || outputPathname.length === 0) {
        continue;
      }
      const output = functionOutputByPathname.get(outputPathname);
      if (!output) {
        continue;
      }
      outputs.push(output);
    }
    if (outputs.length > 0) {
      functionOutputsBySourcePage.set(sourcePage, outputs);
    }
  }
}
if (functionOutputsBySourcePage.size === 0) {
  for (const output of runtimeFunctionOutputs) {
    const existing = functionOutputsBySourcePage.get(output.sourcePage);
    if (existing) {
      existing.push(output);
    } else {
      functionOutputsBySourcePage.set(output.sourcePage, [output]);
    }
  }
}
const sourcePageByResolvedPathname = new Map<string, string>();
if (isRecord(runtimeLookupSourcePageByPathname)) {
  for (const [pathname, sourcePage] of Object.entries(runtimeLookupSourcePageByPathname)) {
    if (typeof pathname !== 'string' || pathname.length === 0) {
      continue;
    }
    if (typeof sourcePage !== 'string' || sourcePage.length === 0) {
      continue;
    }
    sourcePageByResolvedPathname.set(pathname, sourcePage);
  }
}
if (sourcePageByResolvedPathname.size === 0 && isRecord(runtimeResolvedPathnameToSourcePage)) {
  for (const [pathname, sourcePage] of Object.entries(
    runtimeResolvedPathnameToSourcePage
  )) {
    if (typeof pathname !== 'string' || pathname.length === 0) {
      continue;
    }
    if (typeof sourcePage !== 'string' || sourcePage.length === 0) {
      continue;
    }
    sourcePageByResolvedPathname.set(pathname, sourcePage);
  }
}
const dynamicOutputMatchers = runtimeLookupDynamicMatchers;
function toInvokeOutputPathname(output: RuntimeFunctionOutput | undefined): string {
  if (!output) {
    return '';
  }
  const pathname = output.pathname.endsWith('.rsc')
    ? output.pathname.slice(0, -'.rsc'.length)
    : output.pathname;
  if (pathname === '/index') {
    return '/';
  }
  if (pathname.endsWith('/index')) {
    const withoutIndex = pathname.slice(0, -'/index'.length);
    return withoutIndex.length > 0 ? withoutIndex : '/';
  }
  return pathname;
}
function withOptionalSuffix(pathname: string, suffix?: string): string {
  if (!suffix || pathname.endsWith(suffix)) {
    return pathname;
  }
  return `${pathname}${suffix}`;
}
function getIndexAlias(pathname: string): string | null {
  const normalizedPathname =
    pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (normalizedPathname === '/') {
    return '/index';
  }
  const lastSlashIndex = normalizedPathname.lastIndexOf('/');
  if (lastSlashIndex < 0) {
    return null;
  }
  const lastSegment = normalizedPathname.slice(lastSlashIndex + 1);
  if (lastSegment.includes('.')) {
    return null;
  }
  if (normalizedPathname.endsWith('/index')) {
    const withoutIndex = normalizedPathname.slice(0, -'/index'.length);
    return withoutIndex.length > 0 ? withoutIndex : '/';
  }
  return `${normalizedPathname}/index`;
}
function decodePathnameSegmentPreservingEncodedSlashes(segment: string): string {
  const parts = segment.split(/%2F/gi);
  const decodedParts = parts.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  return decodedParts.join('%2F');
}
function addPathnameEncodingVariants(candidates: Set<string>, pathname: string): void {
  candidates.add(pathname);
  const segments = pathname.split('/');
  candidates.add(
    segments
      .map((segment) =>
        segment.length === 0 ? segment : decodePathnameSegmentPreservingEncodedSlashes(segment)
      )
      .join('/')
  );
  candidates.add(
    segments
      .map((segment) => {
        if (segment.length === 0) {
          return segment;
        }
        const parts = segment.split(/%2F/gi);
        const encodedParts = parts.map((part) => {
          const decodedPart = decodePathnameSegmentPreservingEncodedSlashes(part);
          return encodeURIComponent(decodedPart);
        });
        return encodedParts.join('%2F');
      })
      .join('/')
  );
}
function addManifestPathnameCandidates(candidates: Set<string>, pathname: string): void {
  addPathnameEncodingVariants(candidates, pathname);
  const indexAlias = getIndexAlias(pathname);
  if (indexAlias) {
    addPathnameEncodingVariants(candidates, indexAlias);
  }
}
const baseRoutingPathnames =
  runtimeLookupRoutingPathnames.length > 0
    ? runtimeLookupRoutingPathnames
    : [...new Set([
        ...manifest.pathnames,
        ...manifest.staticAssets.map((asset) => asset.pathname),
        ...runtimeFunctionOutputs.map((output) => output.pathname),
      ])];
const routingPathnames = [...new Set([
  ...baseRoutingPathnames,
  ...Object.keys(runtimeLookupPathnameAliasToCanonical),
])];
function getFunctionOutputByPathname(pathname: string): RuntimeFunctionOutput | undefined {
  const lookupPathnameAlias =
    runtimeLookupPathnameAliasToCanonical[pathname] ?? pathname;
  const lookupOutputPathname =
    runtimeLookupFunctionPathnameToOutputPathname[pathname] ??
    runtimeLookupFunctionPathnameToOutputPathname[lookupPathnameAlias];
  if (typeof lookupOutputPathname === 'string' && lookupOutputPathname.length > 0) {
    const lookupOutput = functionOutputByPathname.get(lookupOutputPathname);
    if (lookupOutput) {
      return lookupOutput;
    }
  }
  const candidates = new Set<string>();
  addManifestPathnameCandidates(candidates, pathname);
  for (const candidate of candidates) {
    const output = functionOutputByPathname.get(candidate);
    if (output) {
      return output;
    }
  }
  return undefined;
}
function getSourcePageForResolvedPathname(pathname: string): string | undefined {
  const lookupPathnameAlias =
    runtimeLookupPathnameAliasToCanonical[pathname] ?? pathname;
  const sourcePageFromLookup =
    runtimeLookupSourcePageByPathname[pathname] ??
    runtimeLookupSourcePageByPathname[lookupPathnameAlias];
  if (typeof sourcePageFromLookup === 'string' && sourcePageFromLookup.length > 0) {
    return sourcePageFromLookup;
  }
  const candidates = new Set<string>();
  addManifestPathnameCandidates(candidates, pathname);
  if (runtimeI18n) {
    const withoutBasePath = getPathnameWithoutBasePath(pathname, basePath);
    let withoutLocalePrefix = pathname;
    for (const locale of runtimeI18n.locales) {
      const localePrefix = `/${locale}`;
      if (withoutBasePath === localePrefix) {
        withoutLocalePrefix = basePath || '/';
        break;
      }
      if (withoutBasePath.startsWith(`${localePrefix}/`)) {
        const strippedPathname = withoutBasePath.slice(localePrefix.length);
        const normalizedStrippedPathname =
          strippedPathname.length > 0 ? strippedPathname : '/';
        withoutLocalePrefix = basePath
          ? `${basePath}${normalizedStrippedPathname}`
          : normalizedStrippedPathname;
        break;
      }
    }
    if (withoutLocalePrefix !== pathname) {
      addManifestPathnameCandidates(candidates, withoutLocalePrefix);
    }
  }
  for (const candidate of candidates) {
    const sourcePage = sourcePageByResolvedPathname.get(candidate);
    if (sourcePage) {
      return sourcePage;
    }
  }
  return undefined;
}
function getSourcePageOutputByPathname(
  sourcePage: string,
  pathname: string
): RuntimeFunctionOutput | undefined {
  const outputs = functionOutputsBySourcePage.get(sourcePage);
  if (!outputs || outputs.length === 0) {
    return undefined;
  }
  const candidatePathnames = new Set<string>([
    pathname,
    runtimeLookupPathnameAliasToCanonical[pathname] ?? pathname,
  ]);
  addManifestPathnameCandidates(candidatePathnames, pathname);
  for (const candidatePathname of candidatePathnames) {
    for (const output of outputs) {
      if (
        output.pathname === candidatePathname ||
        (runtimeLookupPathnameAliasToCanonical[output.pathname] ?? output.pathname) ===
          candidatePathname
      ) {
        return output;
      }
    }
  }
  return undefined;
}
function stripRscPathnameSuffix(pathname: string): string {
  return pathname.endsWith('.rsc')
    ? pathname.slice(0, -'.rsc'.length)
    : pathname;
}
function toDecodedPathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function matchDynamicOutputPathname(
  pathname: string,
  matcher: DynamicOutputMatcher
): RuntimeRequestMetaParams | undefined {
  const normalizedPathname = removePathnameTrailingSlash(
    normalizePathnameForRouteMatching(stripRscPathnameSuffix(pathname))
  );
  const pathSegments = normalizedPathname.split('/').filter((segment) => segment.length > 0);
  const params: RuntimeRequestMetaParams = {};
  let pathIndex = 0;
  for (const routeSegment of matcher.segments) {
    if (routeSegment.type === 'optionalCatchall') {
      const values = pathSegments
        .slice(pathIndex)
        .map((segment) => toDecodedPathSegment(segment))
        .filter((value) => value.length > 0);
      if (values.length > 0) {
        params[routeSegment.key] = values;
      }
      pathIndex = pathSegments.length;
      continue;
    }
    if (routeSegment.type === 'catchall') {
      const values = pathSegments
        .slice(pathIndex)
        .map((segment) => toDecodedPathSegment(segment))
        .filter((value) => value.length > 0);
      if (values.length === 0) {
        return undefined;
      }
      params[routeSegment.key] = values;
      pathIndex = pathSegments.length;
      continue;
    }
    const pathSegment = pathSegments[pathIndex];
    if (typeof pathSegment !== 'string') {
      return undefined;
    }
    if (routeSegment.type === 'dynamic') {
      params[routeSegment.key] = toDecodedPathSegment(pathSegment);
      pathIndex += 1;
      continue;
    }
    if (
      pathSegment !== routeSegment.value &&
      toDecodedPathSegment(pathSegment) !== routeSegment.value
    ) {
      return undefined;
    }
    pathIndex += 1;
  }
  if (pathIndex !== pathSegments.length) {
    return undefined;
  }
  return Object.keys(params).length > 0 ? params : {};
}
function preferRscFunctionOutput(
  output: RuntimeFunctionOutput,
  preferRscOutput: boolean
): RuntimeFunctionOutput {
  if (!preferRscOutput || output.pathname.endsWith('.rsc')) {
    return output;
  }
  const canonicalOutputPathname =
    runtimeLookupPathnameAliasToCanonical[output.pathname] ?? output.pathname;
  const lookupRscOutputPathname =
    runtimeLookupRscFunctionPathnameToOutputPathname[`${output.pathname}.rsc`] ??
    runtimeLookupRscFunctionPathnameToOutputPathname[
      `${canonicalOutputPathname}.rsc`
    ];
  if (typeof lookupRscOutputPathname === 'string' && lookupRscOutputPathname.length > 0) {
    const lookupRscOutput = functionOutputByPathname.get(lookupRscOutputPathname);
    if (lookupRscOutput) {
      return lookupRscOutput;
    }
  }
  const rscCandidates = new Set<string>([`${output.pathname}.rsc`]);
  const indexAlias = getIndexAlias(output.pathname);
  if (indexAlias) {
    rscCandidates.add(`${indexAlias}.rsc`);
  }
  for (const candidatePathname of rscCandidates) {
    const rscVariant = functionOutputByPathname.get(candidatePathname);
    if (rscVariant) {
      return rscVariant;
    }
  }
  return output;
}
function resolveFunctionOutputBySourcePage({
  sourcePage,
  matchedPathname,
  requestPathname,
  rscSuffix,
  preferRscOutput,
}: {
  sourcePage: string;
  matchedPathname: string;
  requestPathname: string;
  rscSuffix?: string;
  preferRscOutput: boolean;
}): ResolvedFunctionOutput | null {
  const sourcePageOutputs = functionOutputsBySourcePage.get(sourcePage);
  if (!sourcePageOutputs || sourcePageOutputs.length === 0) {
    return null;
  }
  const candidatePathnames = [
    withOptionalSuffix(matchedPathname, rscSuffix),
    matchedPathname,
    withOptionalSuffix(requestPathname, rscSuffix),
    requestPathname,
  ];
  for (const candidatePathname of candidatePathnames) {
    const output = getSourcePageOutputByPathname(sourcePage, candidatePathname);
    if (output) {
      return { output: preferRscFunctionOutput(output, preferRscOutput) };
    }
  }
  const fallbackOutput =
    sourcePageOutputs.find((output) =>
      preferRscOutput ? output.pathname.endsWith('.rsc') : !output.pathname.endsWith('.rsc')
    ) ?? sourcePageOutputs[0];
  return fallbackOutput
    ? { output: preferRscFunctionOutput(fallbackOutput, preferRscOutput) }
    : null;
}
function resolveFunctionOutput(
  matchedPathname: string,
  requestPathname: string,
  rscSuffix?: string,
  preferRscOutput: boolean = false
): ResolvedFunctionOutput | null {
  const candidatePathnames = [
    withOptionalSuffix(matchedPathname, rscSuffix),
    matchedPathname,
    withOptionalSuffix(requestPathname, rscSuffix),
    requestPathname,
  ];
  for (const candidatePathname of candidatePathnames) {
    const exactOutput = getFunctionOutputByPathname(candidatePathname);
    if (exactOutput) {
      const mappedByExactOutput = resolveFunctionOutputBySourcePage({
        sourcePage: exactOutput.sourcePage,
        matchedPathname: candidatePathname,
        requestPathname,
        rscSuffix,
        preferRscOutput,
      });
      return (
        mappedByExactOutput ?? {
          output: preferRscFunctionOutput(exactOutput, preferRscOutput),
        }
      );
    }
    const sourcePage = getSourcePageForResolvedPathname(candidatePathname);
    if (!sourcePage) {
      continue;
    }
    const mappedOutput = resolveFunctionOutputBySourcePage({
      sourcePage,
      matchedPathname: candidatePathname,
      requestPathname,
      rscSuffix,
      preferRscOutput,
    });
    if (mappedOutput) {
      return mappedOutput;
    }
  }
  for (const candidatePathname of candidatePathnames) {
    if (!isApiRoutePathname(candidatePathname)) {
      continue;
    }
    for (const matcher of dynamicOutputMatchers) {
      const dynamicParams = matchDynamicOutputPathname(
        candidatePathname,
        matcher
      );
      if (!dynamicParams) {
        continue;
      }
      const mappedOutput = resolveFunctionOutputBySourcePage({
        sourcePage: matcher.sourcePage,
        matchedPathname: matcher.pathname,
        requestPathname: candidatePathname,
        rscSuffix,
        preferRscOutput,
      });
      if (!mappedOutput) {
        continue;
      }
      return Object.keys(dynamicParams).length > 0
        ? {
            ...mappedOutput,
            params: dynamicParams,
          }
        : mappedOutput;
    }
  }
  return null;
}
const staticAssetByPathname = new Map<string, StaticAsset>();
for (const asset of manifest.staticAssets) {
  staticAssetByPathname.set(asset.pathname, asset);
}
function resolveStaticAsset(pathname: string, rscSuffix?: string): StaticAsset | undefined {
  const lookupCandidatePathnames = [
    withOptionalSuffix(pathname, rscSuffix),
    pathname,
  ];
  for (const lookupCandidatePathname of lookupCandidatePathnames) {
    if (!lookupCandidatePathname) {
      continue;
    }
    const lookupAlias =
      runtimeLookupPathnameAliasToCanonical[lookupCandidatePathname] ??
      lookupCandidatePathname;
    const lookupAssetPathname =
      runtimeLookupStaticAssetPathnameToAssetPathname[lookupCandidatePathname] ??
      runtimeLookupStaticAssetPathnameToAssetPathname[lookupAlias];
    if (typeof lookupAssetPathname === 'string' && lookupAssetPathname.length > 0) {
      const lookupAsset = staticAssetByPathname.get(lookupAssetPathname);
      if (lookupAsset) {
        return lookupAsset;
      }
    }
  }
  return undefined;
}
function resolveStaticAssetFromCandidates(
  pathnames: Array<string | null | undefined>,
  rscSuffix?: string
): StaticAsset | undefined {
  for (const pathname of pathnames) {
    if (!pathname) {
      continue;
    }
    const asset = resolveStaticAsset(pathname, rscSuffix);
    if (asset) {
      return asset;
    }
  }
  return undefined;
}
function resolveErrorOutputFromCandidates(
  pathnames: Array<string | null | undefined>
): RuntimeFunctionOutput | undefined {
  for (const pathname of pathnames) {
    if (!pathname) {
      continue;
    }
    const output = getFunctionOutputByPathname(pathname);
    if (output) {
      return output;
    }
  }
  return undefined;
}
function isReadMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD';
}
function writeMethodNotAllowedResponse(res: ServerResponse): void {
  res.statusCode = 405;
  res.setHeader('allow', 'GET, HEAD');
  if (!res.hasHeader('content-type')) {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
  }
  res.end('Method Not Allowed');
}
function isApiRoutePathname(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}
function isNextStaticAssetPathname(pathname: string): boolean {
  return pathname.includes('/_next/static/');
}
function isPossibleServerActionRequest(req: IncomingMessage): boolean {
  if (req.method !== 'POST') {
    return false;
  }
  const contentType = getSingleHeaderValue(req.headers['content-type']);
  const actionId = getSingleHeaderValue(req.headers[ACTION_HEADER]);
  const isFetchAction = typeof actionId === 'string' && actionId.length > 0;
  const isURLEncodedAction = contentType === 'application/x-www-form-urlencoded';
  const isMultipartAction = contentType?.startsWith('multipart/form-data') ?? false;
  return isFetchAction || isURLEncodedAction || isMultipartAction;
}
const require = createRequire(import.meta.url);
type RuntimeImageParamsResultError = { errorMessage: string };
type RuntimeImageParamsResultSuccess = {
  href: string;
  isAbsolute: boolean;
  isStatic: boolean;
  [key: string]: unknown;
};
type RuntimeImageParamsResult =
  | RuntimeImageParamsResultError
  | RuntimeImageParamsResultSuccess;
type RuntimeImageUpstream = {
  buffer: Buffer;
  contentType: string | null;
  cacheControl: string | null;
  etag: string;
};
interface RuntimeImageOptimizerModule {
  ImageError: new (...args: any[]) => Error & { statusCode: number };
  ImageOptimizerCache: {
    validateParams: (
      req: IncomingMessage,
      query: Record<string, string | string[]>,
      nextConfig: unknown,
      isDev: boolean
    ) => RuntimeImageParamsResult;
  };
  extractEtag: (etag: string | null, buffer: Buffer) => string;
  fetchExternalImage: (
    href: string,
    dangerouslyAllowLocalIP: boolean,
    maximumResponseBody: number
  ) => Promise<RuntimeImageUpstream>;
  imageOptimizer: (
    imageUpstream: RuntimeImageUpstream,
    paramsResult: RuntimeImageParamsResultSuccess,
    nextConfig: unknown,
    options: { isDev: boolean }
  ) => Promise<{
    buffer: Buffer;
    contentType: string;
    etag: string;
    maxAge: number;
  }>;
  sendResponse: (
    req: IncomingMessage,
    res: ServerResponse,
    href: string,
    extension: string,
    buffer: Buffer,
    etag: string,
    isStatic: boolean,
    xCache: string,
    imagesConfig: unknown,
    maxAge: number,
    isDev: boolean
  ) => void;
}
interface RuntimeServeStaticModule {
  getExtension: (contentType: string) => string | undefined;
}
type RuntimeCreateAtomicTimerGroup = (
  delayMs?: number
) => (callback: () => void) => ReturnType<typeof setTimeout>;
let runtimeImageOptimizerModule: RuntimeImageOptimizerModule | null = null;
let runtimeServeStaticModule: RuntimeServeStaticModule | null = null;
function patchNextAtomicTimerGroupForBun(): void {
  if (process.env.ADAPTER_BUN_DISABLE_ATOMIC_TIMER_PATCH === '1') {
    return;
  }
  if (typeof process.versions?.bun !== 'string') {
    return;
  }
  try {
    const schedulingModule = require(
      'next/dist/server/app-render/app-render-scheduling.js'
    ) as {
      createAtomicTimerGroup?: RuntimeCreateAtomicTimerGroup & {
        __adapterBunPatched?: boolean;
      };
    };
    const currentFactory = schedulingModule.createAtomicTimerGroup;
    if (typeof currentFactory !== 'function' || currentFactory.__adapterBunPatched) {
      return;
    }
    const patchedFactory = ((delayMs = 0) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const queue: Array<() => void> = [];
      return (callback: () => void) => {
        queue.push(callback);
        if (!timer) {
          timer = setTimeout(() => {
            const callbacks = queue.splice(0, queue.length);
            timer = null;
            for (const run of callbacks) {
              run();
            }
          }, delayMs);
        }
        return timer;
      };
    }) as RuntimeCreateAtomicTimerGroup & { __adapterBunPatched?: boolean };
    patchedFactory.__adapterBunPatched = true;
    schedulingModule.createAtomicTimerGroup = patchedFactory;
  } catch {
    // Ignore and continue with Next's default scheduling behavior.
  }
}
patchNextAtomicTimerGroupForBun();
function patchSetTimeoutForBunAtomicGroups(): void {
  if (process.env.ADAPTER_BUN_DISABLE_ATOMIC_TIMER_PATCH === '1') {
    return;
  }
  if (typeof process.versions?.bun !== 'string') {
    return;
  }
  const currentSetTimeout = globalThis.setTimeout as typeof setTimeout & {
    __adapterBunPatched?: boolean;
  };
  if (currentSetTimeout.__adapterBunPatched) {
    return;
  }
  const originalSetTimeout = currentSetTimeout.bind(globalThis);
  const isAtomicTimerGroupHandler = (
    handler: ((...cbArgs: unknown[]) => void) | string,
    stack: string
  ): boolean => {
    if (typeof handler !== 'function') {
      return false;
    }
    const handlerName = handler.name || '';
    if (
      handlerName.includes('runFirstCallback') ||
      handlerName.includes('runSubsequentCallback')
    ) {
      return true;
    }
    if (stack.includes('app-render-scheduling')) {
      return true;
    }
    try {
      const source = Function.prototype.toString.call(handler);
      return source.includes('didFirstTimerRun') || source.includes('didImmediateRun');
    } catch {
      return false;
    }
  };
  const ensureIdleStart = (timer: ReturnType<typeof setTimeout>) => {
    if (timer && typeof timer === 'object') {
      const existingIdleStart = (timer as { _idleStart?: unknown })._idleStart;
      if (typeof existingIdleStart !== 'number') {
        try {
          Object.defineProperty(timer, '_idleStart', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: Date.now(),
          });
        } catch {
          // Ignore environments where timer handles are non-extensible.
        }
      }
    }
    return timer;
  };
  let pendingAtomicBatch:
    | {
        timer: ReturnType<typeof setTimeout>;
        callbacks: Array<() => void>;
      }
    | null = null;
  const batchAllShortTimeouts = process.env.ADAPTER_BUN_BATCH_ALL_SHORT_TIMEOUTS === '1';
  const wrappedSetTimeout = ((
    handler: ((...cbArgs: unknown[]) => void) | string,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const delayMs = typeof timeout === 'number' ? timeout : Number(timeout ?? 0);
    if (typeof handler === 'function' && Number.isFinite(delayMs) && delayMs <= 1) {
      const stack = new Error().stack ?? '';
      if (batchAllShortTimeouts || isAtomicTimerGroupHandler(handler, stack)) {
        if (!pendingAtomicBatch) {
          const callbacks: Array<() => void> = [() => handler(...args)];
          const timer = originalSetTimeout(() => {
            const activeBatch = pendingAtomicBatch;
            pendingAtomicBatch = null;
            const queue = activeBatch ? activeBatch.callbacks : callbacks;
            for (const run of queue) {
              run();
            }
          }, delayMs);
          const normalizedTimer = ensureIdleStart(timer);
          pendingAtomicBatch = { timer: normalizedTimer, callbacks };
          return normalizedTimer;
        }
        pendingAtomicBatch.callbacks.push(() => handler(...args));
        return pendingAtomicBatch.timer;
      }
    }
    const timer = (originalSetTimeout as unknown as (
      ...timeoutArgs: unknown[]
    ) => ReturnType<typeof setTimeout>)(
      handler as unknown,
      timeout as unknown,
      ...args
    );
    return ensureIdleStart(timer);
  }) as typeof setTimeout & { __adapterBunPatched?: boolean };
  wrappedSetTimeout.__adapterBunPatched = true;
  globalThis.setTimeout = wrappedSetTimeout;
  try {
    const timers = require('node:timers') as {
      setTimeout?: typeof setTimeout;
    };
    if (timers && typeof timers.setTimeout === 'function') {
      timers.setTimeout = wrappedSetTimeout as typeof setTimeout;
    }
  } catch {
    // Best effort.
  }
}
patchSetTimeoutForBunAtomicGroups();
function getImageOptimizerModule(): RuntimeImageOptimizerModule {
  if (runtimeImageOptimizerModule) {
    return runtimeImageOptimizerModule;
  }
  runtimeImageOptimizerModule = require(
    'next/dist/server/image-optimizer.js'
  ) as RuntimeImageOptimizerModule;
  return runtimeImageOptimizerModule;
}
function isNextImagePathname(pathname: string): boolean {
  const imagePath = `${basePath || ''}/_next/image`;
  return removePathnameTrailingSlash(pathname) === removePathnameTrailingSlash(imagePath);
}
async function fetchInternalImageForOptimizer({
  href,
  req,
  requestOrigin,
  maximumResponseBody,
}: {
  href: string;
  req: IncomingMessage;
  requestOrigin: string;
  maximumResponseBody: number;
}): Promise<{
  buffer: Buffer;
  contentType: string | null;
  cacheControl: string | null;
  etag: string;
}> {
  const imageOptimizer = getImageOptimizerModule();
  const targetUrl = new URL(href, requestOrigin);
  const requestHeaders = new Headers();
  const acceptHeader = getSingleHeaderValue(req.headers.accept);
  if (typeof acceptHeader === 'string' && acceptHeader.length > 0) {
    requestHeaders.set('accept', acceptHeader);
  }
  const response = await fetch(targetUrl, {
    method: 'GET',
    headers: requestHeaders,
    redirect: 'manual',
  });
  if (!response.ok || !response.body) {
    throw new imageOptimizer.ImageError(
      response.status || 500,
      '"url" parameter is valid but upstream response is invalid'
    );
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.byteLength === 0) {
      continue;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maximumResponseBody) {
      throw new imageOptimizer.ImageError(
        413,
        '"url" parameter is valid but upstream response is invalid'
      );
    }
    chunks.push(Buffer.from(value));
  }
  const buffer = Buffer.concat(chunks);
  const contentType = response.headers.get('content-type');
  const cacheControl = response.headers.get('cache-control');
  const etag = imageOptimizer.extractEtag(response.headers.get('etag'), buffer);
  return {
    buffer,
    contentType,
    cacheControl,
    etag,
  };
}
async function handleNextImageRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL
): Promise<boolean> {
  if (!isNextImagePathname(requestUrl.pathname)) {
    return false;
  }
  const imagesConfig =
    runtimeNextConfig.images && isRecord(runtimeNextConfig.images)
      ? (runtimeNextConfig.images as RuntimeNextImageConfig)
      : null;
  if (!imagesConfig) {
    return false;
  }
  const nextConfigForImages = runtimeNextConfig as RuntimeNextConfig;
  const imageOptimizer = getImageOptimizerModule();
  if (runtimeNextConfig.output === 'export' || process.env.NEXT_MINIMAL) {
    res.statusCode = 400;
    if (!res.hasHeader('content-type')) {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    res.end('Bad Request');
    return true;
  }
  if (imagesConfig.loader !== 'default' || imagesConfig.unoptimized) {
    res.statusCode = 404;
    if (!res.hasHeader('content-type')) {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    res.end('Not Found');
    return true;
  }
  const parsedQuery: Record<string, string | string[]> = {};
  for (const [key, value] of requestUrl.searchParams.entries()) {
    const existing = parsedQuery[key];
    if (existing === undefined) {
      parsedQuery[key] = value;
      continue;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      continue;
    }
    parsedQuery[key] = [existing, value];
  }
  const paramsResult = imageOptimizer.ImageOptimizerCache.validateParams(
    req,
    parsedQuery,
    nextConfigForImages,
    false
  );
  if ('errorMessage' in paramsResult) {
    res.statusCode = 400;
    if (!res.hasHeader('content-type')) {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    res.end(paramsResult.errorMessage);
    return true;
  }
  try {
    const maximumResponseBody =
      typeof imagesConfig.maximumResponseBody === 'number' &&
      Number.isFinite(imagesConfig.maximumResponseBody) &&
      imagesConfig.maximumResponseBody > 0
        ? imagesConfig.maximumResponseBody
        : 50_000_000;
    const imageUpstream = paramsResult.isAbsolute
      ? await imageOptimizer.fetchExternalImage(
          paramsResult.href,
          Boolean(imagesConfig.dangerouslyAllowLocalIP),
          maximumResponseBody
        )
      : await fetchInternalImageForOptimizer({
          href: paramsResult.href,
          req,
          requestOrigin: requestUrl.origin,
          maximumResponseBody,
        });
    const hrefPathname = new URL(paramsResult.href, requestUrl.origin).pathname;
    if (isNextImagePathname(hrefPathname)) {
      throw new Error('Invariant attempted to optimize _next/image itself');
    }
    const optimizedResult = await imageOptimizer.imageOptimizer(
      imageUpstream,
      paramsResult,
      nextConfigForImages,
      {
        isDev: false,
      }
    );
    if (!runtimeServeStaticModule) {
      runtimeServeStaticModule = require(
        'next/dist/server/serve-static.js'
      ) as RuntimeServeStaticModule;
    }
    const serveStatic = runtimeServeStaticModule;
    const extension =
      serveStatic.getExtension(optimizedResult.contentType) ?? 'bin';
    imageOptimizer.sendResponse(
      req,
      res,
      paramsResult.href,
      extension,
      optimizedResult.buffer,
      optimizedResult.etag,
      paramsResult.isStatic,
      'MISS',
      nextConfigForImages.images,
      optimizedResult.maxAge,
      false
    );
    return true;
  } catch (error) {
    if (error instanceof imageOptimizer.ImageError) {
      res.statusCode = error.statusCode;
      if (!res.hasHeader('content-type')) {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
      }
      res.end(error.message);
      return true;
    }
    throw error;
  }
}
const { invokeFunctionOutput, invokeMiddleware } = createInvokeOutput({
  appendMutableHeader,
  buildId,
  canRequestHaveBody,
  getFunctionOutputByPathname,
  getSingleHeaderValue,
  isApiRoutePathname,
  isPossibleServerActionRequest,
  isReadMethod,
  manifestBuild: manifest.build,
  manifestDistDir: manifestDistDir ?? null,
  prerenderManifest,
  requiredServerFilesConfig,
  runtimeNextConfig,
  writeFetchResponse,
});
async function proxyExternalRewrite(
  req: IncomingMessage,
  res: ServerResponse,
  targetUrl: URL,
  requestBody: Uint8Array,
  routeHeaders?: Headers,
  routeStatus?: number
): Promise<void> {
  const outboundHeaders = toRequestHeaders(req.headers);
  outboundHeaders.delete('host');
  const requestInit: RequestInit & { duplex?: 'half' } = {
    method: req.method || 'GET',
    headers: outboundHeaders,
    redirect: 'manual',
  };
  if (canRequestHaveBody(req.method) && requestBody.byteLength > 0) {
    requestInit.body = createBodyStream(requestBody);
    requestInit.duplex = 'half';
  }
  const response = await fetch(targetUrl, requestInit);
  await writeFetchResponse(req, res, response, {
    statusOverride: typeof routeStatus === 'number' ? routeStatus : undefined,
    headerOverride: routeHeaders,
  });
}
const server = http.createServer(async (req, res) => {
  const requestUrlNoQuery = (req.url || '').split('?', 1)[0] ?? '';
  if (requestUrlNoQuery.match(/(\\|\/\/)/)) {
    const urlParts = (req.url || '/').split('?');
    const urlNoQuery = urlParts[0] ?? '';
    const normalizedUrl =
      urlNoQuery.replace(/\\/g, '/').replace(/\/\/+/g, '/') +
      (urlParts[1] ? `?${urlParts.slice(1).join('?')}` : '');
    res.statusCode = 308;
    res.setHeader('location', normalizedUrl);
    markConnectionClose(res);
    res.end(normalizedUrl);
    return;
  }
  // Normalize Bun's incoming headers into a plain mutable object so Next can
  // safely patch/strip headers during RSC/action flows.
  (req as IncomingMessage & { headers: IncomingHttpHeaders }).headers = {
    ...req.headers,
  };
  for (const key of Object.keys(req.headers)) {
    if (INTERNAL_REQUEST_HEADERS.has(key.toLowerCase())) {
      delete req.headers[key];
    }
  }
  // Bun can close sockets eagerly in several response paths; advertise
  // non-keepalive consistently so pooled clients won't reuse stale sockets.
  markConnectionClose(res);
  if (cacheRuntime.handlerMode === 'http') {
    const requestUrl = toRequestUrl(req, defaultInternalOrigin);
    if (requestUrl.pathname === cacheRuntime.endpointPath) {
      await handleCacheHttpRequest(req, res, getSharedPrerenderCacheStore(), {
        authToken: process.env.BUN_ADAPTER_CACHE_HTTP_TOKEN,
      });
      return;
    }
  }
  patchResponseAppendHeader(res);
  patchCacheControlHeader(req, res);
  const purposeHeader = getSingleHeaderValue(req.headers.purpose);
  const isMiddlewarePrefetchHint =
    purposeHeader === 'prefetch' ||
    getSingleHeaderValue(req.headers['x-middleware-prefetch']) === '1';
  if (isMiddlewarePrefetchHint) {
    // Prefetch probes are frequently followed by immediate data requests from
    // the same keep-alive pool. Closing explicitly avoids stale socket reuse
    // when middleware short-circuits prefetch handling.
    res.shouldKeepAlive = false;
    if (!res.headersSent) {
      res.setHeader('connection', 'close');
    }
  }
  // Some Bun/browser navigations omit Accept for Flight requests. Force the
  // expected RSC accept header so client transitions don't degrade to hard
  // navigations when `_rsc` requests are issued.
  const rscHeaderValue = getSingleHeaderValue(req.headers.rsc);
  const isRscRequest =
    rscHeaderValue === '1' ||
    (typeof req.url === 'string' && req.url.includes('_rsc='));
  if (isRscRequest) {
    const mergedVary = new Map<string, string>();
    const existingVaryValue = res.getHeader('vary');
    const rawVaryValues = Array.isArray(existingVaryValue)
      ? existingVaryValue
      : typeof existingVaryValue === 'string'
        ? [existingVaryValue]
        : typeof existingVaryValue === 'number'
          ? [String(existingVaryValue)]
          : [];
    for (const rawValue of rawVaryValues) {
      for (const part of rawValue.split(',')) {
        const trimmed = part.trim();
        if (trimmed.length === 0) {
          continue;
        }
        const key = trimmed.toLowerCase();
        if (!mergedVary.has(key)) {
          mergedVary.set(key, trimmed);
        }
      }
    }
    for (const requiredField of [
      'rsc',
      'next-router-state-tree',
      'next-router-prefetch',
      'next-router-segment-prefetch',
    ]) {
      const key = requiredField.toLowerCase();
      if (!mergedVary.has(key)) {
        mergedVary.set(key, requiredField);
      }
    }
    res.setHeader(
      'vary',
      [...mergedVary.values()].join(', ')
    );
  }
  let allowRscContentTypeRewrite = false;
  if (isRscRequest) {
    patchRscContentTypeHeader(res, () => allowRscContentTypeRewrite);
    if (rscHeaderValue !== '1') {
      req.headers.rsc = '1';
    }
    const acceptHeaderValue = getSingleHeaderValue(req.headers.accept);
    if (!acceptHeaderValue || acceptHeaderValue === '*/*') {
      req.headers.accept = 'text/x-component';
    }
    // Forwarded action redirects can inherit POST content-type on GET.
    if (req.method === 'GET' && getSingleHeaderValue(req.headers['content-type'])) {
      delete req.headers['content-type'];
    }
  }
  try {
    const requestUrl = toRequestUrl(req, defaultInternalOrigin);
    const normalizedHost = getNormalizedHostHeader(req.headers.host);
    const effectiveHost = normalizedHost ?? requestUrl.host;
    if (effectiveHost && effectiveHost.length > 0) {
      req.headers.host = effectiveHost;
      req.headers['x-forwarded-host'] = effectiveHost;
    }
    const forwardedProto = requestUrl.protocol.replace(/:$/, '') || 'http';
    req.headers['x-forwarded-proto'] = forwardedProto;
    req.headers['x-forwarded-port'] =
      requestUrl.port || (forwardedProto === 'https' ? '443' : '80');
    let routingBaseUrl = requestUrl;
    const hostHeader = req.headers.host;
    const normalizedRoutingHost = getNormalizedHostHeader(hostHeader);
    if (normalizedRoutingHost) {
      try {
        const nextUrl = new URL(requestUrl.toString());
        nextUrl.host = normalizedRoutingHost;
        routingBaseUrl = nextUrl;
      } catch {
        routingBaseUrl = requestUrl;
      }
    }
    let hasInvalidPathnameEncoding = false;
    for (const segment of requestUrl.pathname.split('/')) {
      if (!segment || !segment.includes('%')) {
        continue;
      }
      try {
        decodeURIComponent(segment);
      } catch {
        hasInvalidPathnameEncoding = true;
        break;
      }
    }
    if (hasInvalidPathnameEncoding) {
      res.statusCode = 400;
      res.shouldKeepAlive = false;
      if (!res.headersSent) {
        res.setHeader('connection', 'close');
      }
      if (!res.hasHeader('content-type')) {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
      }
      res.end('Bad Request');
      return;
    }
    const nextDataNormalizedPathname = getNextDataNormalizedPathname(
      requestUrl.pathname,
      buildId,
      basePath
    );
    const nextDataRoutingPathname =
      getNextDataNormalizedPathname(
        requestUrl.pathname,
        buildId,
        basePath,
        false
      ) ?? nextDataNormalizedPathname;
    const nextDataRoutePathname = nextDataRoutingPathname
      ? applyConfiguredTrailingSlash(nextDataRoutingPathname)
      : null;
    if (
      nextDataRoutePathname &&
      getSingleHeaderValue(req.headers['x-nextjs-data']) !== '1'
    ) {
      req.headers['x-nextjs-data'] = '1';
    }
    const routingUrl = new URL(routingBaseUrl);
    if (nextDataRoutePathname) {
      routingUrl.pathname = nextDataRoutePathname;
    }
    const requestBody = await getBufferedRequestBody(req);
    let resolvedRoutingResult: ResolveRoutesResult = {
      resolvedPathname: routingUrl.pathname,
      resolvedHeaders: new Headers(),
    };
    const routingHeaders = toRequestHeaders(req.headers);
    let resolvedRequestHeaders = new Headers(routingHeaders);
    if (nextDataRoutePathname && !routingHeaders.has('x-nextjs-data')) {
      routingHeaders.set('x-nextjs-data', '1');
      resolvedRequestHeaders.set('x-nextjs-data', '1');
    }
    let middlewareBodyResponse: Response | null = null;
    let middlewareMatchedRequest = false;
    if (runtimeRouting) {
      resolvedRoutingResult = normalizeResolveRoutesResultShape(
        await resolveRoutes({
          url: routingUrl,
          buildId,
          basePath,
          requestBody: createBodyStream(requestBody),
          headers: routingHeaders,
          pathnames: routingPathnames,
          i18n: runtimeI18n,
          routes: runtimeRoutingMiddlewareMatchers
            ? {
                ...runtimeRouting,
                middlewareMatchers: runtimeRoutingMiddlewareMatchers,
              }
            : runtimeRouting,
          invokeMiddleware: async ({ url, headers, requestBody: middlewareRequestBody }) => {
            if (!runtimeMiddleware) {
              return {};
            }
            const middlewareUrl = new URL(url.toString());
            const middlewareNextDataPathname = getNextDataNormalizedPathname(
              middlewareUrl.pathname,
              buildId,
              basePath
            );
            if (middlewareNextDataPathname) {
              middlewareUrl.pathname = applyConfiguredTrailingSlash(
                middlewareNextDataPathname
              );
            }
            middlewareMatchedRequest = true;
            const { middlewareResult, response } = await invokeMiddleware(
              runtimeMiddleware,
              middlewareUrl,
              req.method,
              headers,
              middlewareRequestBody
            );
            if (middlewareResult.requestHeaders) {
              resolvedRequestHeaders = new Headers(middlewareResult.requestHeaders);
            }
            if (middlewareResult.bodySent) {
              middlewareBodyResponse = response;
            }
            return middlewareResult;
          },
        }),
        routingUrl
      );
    }
    replaceRequestHeaders(req, resolvedRequestHeaders);
    const routeHeaders = resolvedRoutingResult.resolvedHeaders;
    let routeStatus = resolvedRoutingResult.status;
    if (middlewareMatchedRequest) {
      // Middleware responses commonly terminate sockets after write without an
      // explicit keep-alive contract. Close per-request to avoid pooled socket
      // reuse races in deploy-mode clients.
      res.shouldKeepAlive = false;
      if (!res.headersSent) {
        res.setHeader('connection', 'close');
      }
    }
    if (resolvedRoutingResult.redirect) {
      const redirectLocation = resolvedRoutingResult.redirect.url.toString();
      if (routeHeaders) {
        applyResponseHeaders(res, routeHeaders);
      }
      res.statusCode = resolvedRoutingResult.redirect.status;
      res.setHeader('location', redirectLocation);
      markConnectionClose(res);
      res.end();
      return;
    }
    if (resolvedRoutingResult.externalRewrite) {
      await proxyExternalRewrite(
        req,
        res,
        resolvedRoutingResult.externalRewrite,
        requestBody,
        routeHeaders,
        routeStatus
      );
      return;
    }
    if (resolvedRoutingResult.middlewareResponded) {
      if (!middlewareBodyResponse) {
        if (routeHeaders) {
          applyResponseHeaders(res, routeHeaders);
        }
        if (typeof routeStatus === 'number') {
          res.statusCode = routeStatus;
        }
        res.end();
        return;
      }
      await writeFetchResponse(req, res, middlewareBodyResponse, {
        statusOverride: typeof routeStatus === 'number' ? routeStatus : undefined,
        headerOverride: routeHeaders,
      });
      return;
    }
    const routeLocationHeader = routeHeaders?.get('location');
    if (
      typeof routeStatus === 'number' &&
      routeStatus >= 300 &&
      routeStatus < 400 &&
      typeof routeLocationHeader === 'string' &&
      routeLocationHeader.length > 0
    ) {
      if (routeHeaders) {
        applyResponseHeaders(res, routeHeaders);
      }
      let redirectLocation = routeLocationHeader;
      if (
        requestUrl.search.length > 0 &&
        routeLocationHeader.startsWith('/') &&
        !routeLocationHeader.includes('?')
      ) {
        const locationHashIndex = routeLocationHeader.indexOf('#');
        redirectLocation =
          locationHashIndex >= 0
            ? `${routeLocationHeader.slice(0, locationHashIndex)}${requestUrl.search}${routeLocationHeader.slice(locationHashIndex)}`
            : `${routeLocationHeader}${requestUrl.search}`;
      }
      res.setHeader('location', redirectLocation);
      const redirectStatus = routeStatus as number;
      res.statusCode = redirectStatus;
      if (redirectStatus === 308) {
        res.setHeader('refresh', `0;url=${redirectLocation}`);
      }
      markConnectionClose(res);
      res.end(redirectLocation);
      return;
    }
    let matchedPathname = resolvedRoutingResult.resolvedPathname;
    let routingFallbackFunctionOutput: ResolvedFunctionOutput | null = null;
    if (!matchedPathname) {
      if (await handleNextImageRequest(req, res, requestUrl)) {
        return;
      }
      const requestStaticAsset = resolveStaticAssetFromCandidates([
        requestUrl.pathname,
        routingUrl.pathname,
      ]);
      if (requestStaticAsset) {
        if (routeHeaders) {
          applyResponseHeaders(res, routeHeaders);
        }
        if (!isReadMethod(req.method)) {
          writeMethodNotAllowedResponse(res);
          return;
        }
      }
      if (requestStaticAsset && (await serveStaticAsset(req, res, adapterDir, requestStaticAsset))) {
        return;
      }
      // Unmatched API routes can legitimately bypass @next/routing route matches
      // in deploy mode. Restrict function-output fallback to API-like paths so
      // regular page routes still 404 when no route was matched.
      const routingPathnameWithoutBasePath = getPathnameWithoutBasePath(
        routingUrl.pathname,
        basePath
      );
      const isApiLikePathname =
        routingPathnameWithoutBasePath === '/api' ||
        routingPathnameWithoutBasePath.startsWith('/api/') ||
        (runtimeI18n
          ? runtimeI18n.locales.some(
              (locale) =>
                routingPathnameWithoutBasePath === `/${locale}/api` ||
                routingPathnameWithoutBasePath.startsWith(`/${locale}/api/`)
            )
          : false);
      if (isApiLikePathname) {
        const shouldPreferRscFallbackOutput =
          isRscRequest ||
          routingUrl.pathname.endsWith('.rsc') ||
          requestUrl.pathname.endsWith('.rsc');
        routingFallbackFunctionOutput = resolveFunctionOutput(
          routingUrl.pathname,
          routingUrl.pathname,
          undefined,
          shouldPreferRscFallbackOutput
        );
        if (routingFallbackFunctionOutput) {
          matchedPathname = routingFallbackFunctionOutput.output.pathname;
        }
      }
    }
    if (!matchedPathname) {
      if (routeHeaders) {
        applyResponseHeaders(res, routeHeaders);
      }
      res.statusCode = 404;
      const isNextStaticAssetRequest =
        isNextStaticAssetPathname(requestUrl.pathname) ||
        isNextStaticAssetPathname(routingUrl.pathname);
      if (isNextStaticAssetRequest) {
        if (!res.hasHeader('content-type')) {
          res.setHeader('content-type', 'text/plain; charset=utf-8');
        }
        res.end('Not Found');
        return;
      }
      const notFoundLocale =
        getLocaleFromPathname(requestUrl.pathname, basePath, runtimeI18n) ??
        getLocaleFromPathname(routingUrl.pathname, basePath, runtimeI18n) ??
        runtimeI18n?.defaultLocale;
      const localizedNotFoundPathname = notFoundLocale
        ? `${basePath}${basePath ? '/' : '/'}${notFoundLocale}/404`
        : null;
      const notFoundAsset = resolveStaticAssetFromCandidates([
        '/_not-found',
        basePath ? `${basePath}/_not-found` : null,
        localizedNotFoundPathname,
        '/404',
        basePath ? `${basePath}/404` : null,
      ]);
      if (notFoundAsset && (await serveStaticAsset(req, res, adapterDir, notFoundAsset))) {
        return;
      }
      const errorOutput = resolveErrorOutputFromCandidates([
        '/_not-found',
        basePath ? `${basePath}/_not-found` : null,
        '/_error',
        basePath ? `${basePath}/_error` : null,
      ]);
      if (errorOutput) {
        const errorUrl = new URL(requestUrl);
        errorUrl.pathname = errorOutput.pathname;
        req.url = `${errorUrl.pathname}${errorUrl.search}`;
        await invokeFunctionOutput(req, res, errorOutput, errorUrl, requestBody);
        return;
      }
      res.end('Not Found');
      return;
    }
    if (routeHeaders) {
      applyResponseHeaders(res, routeHeaders);
    }
    if (typeof routeStatus === 'number') {
      res.statusCode = routeStatus;
    }
    const resolvedUrl = new URL(routingUrl);
    const sourcePathname = nextDataRoutePathname ?? routingUrl.pathname;
    const resolvedRoutingQuery =
      resolvedRoutingResult.invocationTarget?.query ??
      resolvedRoutingResult.resolvedQuery;
    if (resolvedRoutingQuery && Object.keys(resolvedRoutingQuery).length > 0) {
      const resolvedRoutingSearchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(resolvedRoutingQuery)) {
        if (Array.isArray(value)) {
          for (const entry of value) {
            resolvedRoutingSearchParams.append(key, entry);
          }
          continue;
        }
        resolvedRoutingSearchParams.append(key, value);
      }
      const resolvedRoutingSearch = resolvedRoutingSearchParams.toString();
      resolvedUrl.search = resolvedRoutingSearch.length > 0 ? `?${resolvedRoutingSearch}` : '';
    }
    const middlewareRewriteHeader = routeHeaders?.get('x-middleware-rewrite');
    let middlewareRewriteUrl: URL | null = null;
    let routeMatches = resolvedRoutingResult.routeMatches;
    if (process.env.ADAPTER_BUN_CLEAR_ROUTE_MATCHES === '1') {
      routeMatches = undefined;
    }
    if (middlewareRewriteHeader) {
      middlewareRewriteUrl = new URL(
        middlewareRewriteHeader,
        requestUrl.origin
      );
      resolvedUrl.pathname = middlewareRewriteUrl.pathname;
      if (middlewareRewriteUrl.search.length > 0) {
        const mergedSearchParams = new URLSearchParams(resolvedUrl.search);
        middlewareRewriteUrl.searchParams.forEach((value, key) => {
          mergedSearchParams.delete(key);
          mergedSearchParams.append(key, value);
        });
        const mergedSearch = mergedSearchParams.toString();
        resolvedUrl.search = mergedSearch ? `?${mergedSearch}` : '';
      } else if (!resolvedRoutingQuery) {
        resolvedUrl.search = middlewareRewriteUrl.search;
      }
    }
    const routeMatchesQuery = toResolveRoutesQueryFromRouteMatches(
      routeMatches,
      matchedPathname
    );
    const rscSuffix = routeMatches?.rscSuffix;
    const invocationPathname =
      resolvedRoutingResult.invocationTarget?.pathname ??
      middlewareRewriteUrl?.pathname ??
      sourcePathname;
    const invocationUrl = new URL(requestUrl);
    invocationUrl.pathname = invocationPathname;
    invocationUrl.search = resolvedUrl.search;
    const paramsExtractionPathname = [
      middlewareRewriteUrl?.pathname,
      resolvedRoutingResult.invocationTarget?.pathname,
      sourcePathname,
      requestUrl.pathname,
      resolvedUrl.pathname,
      invocationPathname,
    ].find(
      (pathname): pathname is string =>
        typeof pathname === 'string' && pathname.length > 0
    );
    const outputRequestPathname = paramsExtractionPathname ?? invocationPathname;
    const explicitRscPath =
      isRscRequest ||
      invocationPathname.endsWith('.rsc') ||
      matchedPathname.endsWith('.rsc') ||
      (typeof rscSuffix === 'string' && rscSuffix.length > 0);
    const preferRscOutput =
      process.env.ADAPTER_BUN_DISABLE_PREFER_RSC_OUTPUT === '1'
        ? false
        : explicitRscPath;
    let resolvedFunctionOutput: ResolvedFunctionOutput | null = routingFallbackFunctionOutput;
    if (nextDataNormalizedPathname) {
      const nextDataCandidatePathnames = new Set<string>();
      const middlewareRewriteNextDataPathname =
        middlewareRewriteUrl &&
        toNextDataPathname(middlewareRewriteUrl.pathname, buildId, basePath);
      if (middlewareRewriteNextDataPathname) {
        nextDataCandidatePathnames.add(middlewareRewriteNextDataPathname);
      }
      const invocationNextDataPathname = toNextDataPathname(
        invocationPathname,
        buildId,
        basePath
      );
      if (invocationNextDataPathname) {
        nextDataCandidatePathnames.add(invocationNextDataPathname);
      }
      nextDataCandidatePathnames.add(requestUrl.pathname);
      for (const nextDataCandidatePathname of nextDataCandidatePathnames) {
        const directNextDataOutput = getFunctionOutputByPathname(nextDataCandidatePathname);
        if (directNextDataOutput?.pathname.includes('/_next/data/')) {
          resolvedFunctionOutput = {
            output: directNextDataOutput,
          };
          break;
        }
        const nextDataOutput = resolveFunctionOutput(
          nextDataCandidatePathname,
          nextDataCandidatePathname,
          undefined,
          false
        );
        if (nextDataOutput?.output.pathname.includes('/_next/data/')) {
          resolvedFunctionOutput = nextDataOutput;
          break;
        }
      }
    }
    if (!resolvedFunctionOutput) {
      const invocationPathOutput = getFunctionOutputByPathname(
        withOptionalSuffix(
          invocationPathname,
          typeof rscSuffix === 'string' ? rscSuffix : undefined
        )
      );
      if (invocationPathOutput) {
        resolvedFunctionOutput = {
          output: preferRscFunctionOutput(invocationPathOutput, preferRscOutput),
        };
      }
    }
    if (!resolvedFunctionOutput) {
      resolvedFunctionOutput = resolveFunctionOutput(
        matchedPathname,
        outputRequestPathname,
        typeof rscSuffix === 'string' ? rscSuffix : undefined,
        preferRscOutput
      );
    }
    if (middlewareRewriteUrl && !nextDataNormalizedPathname) {
      const resolvedOutputPathname = toInvokeOutputPathname(
        resolvedFunctionOutput?.output
      );
      const shouldTryRewrittenOutput =
        !resolvedFunctionOutput ||
        (pathnameEqualsWithRootAlias(resolvedOutputPathname, matchedPathname) &&
          !pathnameEqualsWithRootAlias(middlewareRewriteUrl.pathname, matchedPathname));
      if (shouldTryRewrittenOutput) {
        const rewrittenMiddlewarePathname = removePathnameTrailingSlash(
          middlewareRewriteUrl.pathname
        );
        const rewrittenOutput = resolveFunctionOutput(
          rewrittenMiddlewarePathname,
          rewrittenMiddlewarePathname,
          typeof rscSuffix === 'string' ? rscSuffix : undefined,
          preferRscOutput
        );
        if (rewrittenOutput) {
          const matchedHasInterception = hasInterceptionMarkerInPathname(matchedPathname);
          const rewrittenOutputPathname = toInvokeOutputPathname(rewrittenOutput.output);
          const rewrittenHasInterception = hasInterceptionMarkerInPathname(
            rewrittenOutputPathname
          );
          const shouldAvoidDynamicFallbackOverride =
            Boolean(resolvedFunctionOutput) &&
            !isDynamicRoute(resolvedOutputPathname) &&
            isDynamicRoute(rewrittenOutputPathname);
          if (
            !shouldAvoidDynamicFallbackOverride &&
            matchedHasInterception === rewrittenHasInterception
          ) {
            resolvedFunctionOutput = rewrittenOutput;
          }
        }
      }
    }
    const requestMeta = toRequestMeta({
      requestUrl,
      requestHeaders: req.headers,
      revalidate: internalRevalidate,
    });
    if (resolvedFunctionOutput) {
      const isApiOutput = isApiRoutePathname(resolvedFunctionOutput.output.pathname);
      const isNextDataRequest =
        getSingleHeaderValue(req.headers['x-nextjs-data']) === '1' ||
        Boolean(nextDataNormalizedPathname) ||
        requestUrl.pathname.includes('/_next/data/');
      const invocationRequestUrl = new URL(requestUrl);
      if (!isApiOutput && isNextDataRequest) {
        const rewrittenNextDataPathname = toNextDataPathname(
          invocationUrl.pathname,
          buildId,
          basePath
        );
        invocationRequestUrl.pathname = rewrittenNextDataPathname ?? requestUrl.pathname;
        invocationRequestUrl.search = invocationUrl.search;
      } else {
        invocationRequestUrl.pathname = resolvedUrl.pathname;
        invocationRequestUrl.search = invocationUrl.search;
      }
      const shouldInjectDynamicParams = isDynamicRoute(
        stripRscPathnameSuffix(resolvedFunctionOutput.output.pathname),
        false
      );
      if (shouldInjectDynamicParams) {
        const invocationRequestSearchParams = new URLSearchParams(
          invocationRequestUrl.search
        );
        const didApplyRouteMatchesQuery =
          routeMatchesQuery && Object.keys(routeMatchesQuery).length > 0
            ? (() => {
                let applied = false;
                for (const [key, value] of Object.entries(routeMatchesQuery)) {
                  const values = Array.isArray(value) ? value : [value];
                  if (values.length === 0) {
                    continue;
                  }
                  invocationRequestSearchParams.delete(key);
                  for (const entry of values) {
                    invocationRequestSearchParams.append(key, entry);
                  }
                  applied = true;
                }
                return applied;
              })()
            : false;
        if (!didApplyRouteMatchesQuery && resolvedFunctionOutput.params) {
          for (const [key, value] of Object.entries(resolvedFunctionOutput.params)) {
            if (value === undefined) {
              continue;
            }
            invocationRequestSearchParams.delete(key);
            if (Array.isArray(value)) {
              for (const item of value) {
                invocationRequestSearchParams.append(key, item);
              }
            } else {
              invocationRequestSearchParams.append(key, value);
            }
          }
        }
        const invocationRequestSearch = invocationRequestSearchParams.toString();
        invocationRequestUrl.search = invocationRequestSearch
          ? `?${invocationRequestSearch}`
          : '';
      }
      req.url = `${invocationRequestUrl.pathname}${invocationRequestUrl.search}`;
      if (isRscRequest) {
        allowRscContentTypeRewrite = true;
      }
      const isMiddlewarePrefetchDataRequest =
        getSingleHeaderValue(req.headers['x-middleware-prefetch']) === '1' &&
        (Boolean(nextDataNormalizedPathname) ||
          getSingleHeaderValue(req.headers['x-nextjs-data']) === '1');
      const isErrorOutputPathname = /(?:^|\/)(?:404|500|_error)$/.test(
        resolvedFunctionOutput.output.pathname
      );
      const prerenderCacheStore = getSharedPrerenderCacheStore();
      const hasPrerenderCacheForResolvedOutput = [
        nextDataRoutePathname ?? invocationPathname,
        resolvedUrl.pathname,
        matchedPathname,
        resolvedFunctionOutput.output.pathname,
      ].some((pathname) => {
        if (!pathname) {
          return false;
        }
        const cacheCandidates = new Set<string>();
        addManifestPathnameCandidates(cacheCandidates, pathname);
        for (const candidate of cacheCandidates) {
          if (prerenderCacheStore.get(candidate)) {
            return true;
          }
        }
        return false;
      });
      if (
        isMiddlewarePrefetchDataRequest &&
        !hasPrerenderCacheForResolvedOutput &&
        !isErrorOutputPathname
      ) {
        res.statusCode = 200;
        if (!res.hasHeader('content-type')) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
        }
        res.setHeader('x-middleware-skip', '1');
        res.setHeader(
          'cache-control',
          'private, no-cache, no-store, max-age=0, must-revalidate'
        );
        res.end('{}');
        return;
      }
      if (
        !isReadMethod(req.method) &&
        !isPossibleServerActionRequest(req) &&
        !isApiRoutePathname(resolvedFunctionOutput.output.pathname) &&
        hasPrerenderCacheForResolvedOutput
      ) {
        writeMethodNotAllowedResponse(res);
        return;
      }
      await invokeFunctionOutput(
        req,
        res,
        resolvedFunctionOutput.output,
        invocationRequestUrl,
        requestBody,
        requestMeta
      );
      return;
    }
    const matchedStaticAsset = resolveStaticAssetFromCandidates(
      [
        nextDataNormalizedPathname ? requestUrl.pathname : null,
        invocationPathname,
        resolvedUrl.pathname,
        matchedPathname,
      ],
      typeof rscSuffix === 'string' ? rscSuffix : undefined
    );
    if (matchedStaticAsset) {
      if (!isReadMethod(req.method)) {
        writeMethodNotAllowedResponse(res);
        return;
      }
    }
    if (matchedStaticAsset && (await serveStaticAsset(req, res, adapterDir, matchedStaticAsset))) {
      return;
    }
    res.statusCode = 404;
    res.end('Not Found');
  } catch (err) {
    console.error('[adapter-bun] error handling request:', err);
    if (res.writableEnded || res.destroyed) {
      return;
    }
    if (!res.headersSent) {
      const requestUrl = toRequestUrl(req, defaultInternalOrigin);
      const isNextDataRequest =
        getSingleHeaderValue(req.headers['x-nextjs-data']) === '1' ||
        requestUrl.pathname.includes('/_next/data/');
      const isErrorPathname =
        requestUrl.pathname === '/500' ||
        requestUrl.pathname === '/_error' ||
        requestUrl.pathname === (basePath ? `${basePath}/500` : '/500') ||
        requestUrl.pathname === (basePath ? `${basePath}/_error` : '/_error');
      const canRenderErrorPage =
        isReadMethod(req.method) &&
        !isNextDataRequest &&
        !isErrorPathname;
      if (canRenderErrorPage) {
        const errorStaticAsset = resolveStaticAssetFromCandidates([
          '/500',
          basePath ? `${basePath}/500` : null,
        ]);
        if (errorStaticAsset) {
          res.statusCode = 500;
          if (await serveStaticAsset(req, res, adapterDir, errorStaticAsset)) {
            return;
          }
        }
        const errorOutput = resolveErrorOutputFromCandidates([
          '/500',
          basePath ? `${basePath}/500` : null,
          '/_error',
          basePath ? `${basePath}/_error` : null,
        ]);
        if (errorOutput) {
          try {
            let errorRequestBody: Uint8Array;
            try {
              errorRequestBody = await getBufferedRequestBody(req);
            } catch {
              errorRequestBody = new Uint8Array(0);
            }
            const errorUrl = new URL(errorOutput.pathname, requestUrl.origin);
            req.url = errorUrl.pathname;
            res.statusCode = 500;
            await invokeFunctionOutput(
              req,
              res,
              errorOutput,
              errorUrl,
              errorRequestBody
            );
            return;
          } catch (errorRenderErr) {
            console.error('[adapter-bun] failed to render error page:', errorRenderErr);
          }
        }
      }
      res.writeHead(500, { 'content-type': 'text/plain' });
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end('Internal Server Error');
    }
  }
});
// The deploy test runner uses a shared keep-alive node-fetch agent.
// Node's default keepAliveTimeout (5s) is too short and can reset pooled
// sockets between requests, surfacing intermittent "socket hang up" errors.
const requestedKeepAliveTimeout = Number.parseInt(
  process.env.BUN_ADAPTER_KEEP_ALIVE_TIMEOUT || '',
  10
);
const keepAliveTimeout =
  Number.isFinite(requestedKeepAliveTimeout) && requestedKeepAliveTimeout > 0
    ? requestedKeepAliveTimeout
    : DEFAULT_KEEP_ALIVE_TIMEOUT;
server.keepAliveTimeout = keepAliveTimeout;
server.headersTimeout = Math.max(server.headersTimeout, keepAliveTimeout + 1_000);
const handleListening = () => {
  const addr = server.address();
  const listenPort = typeof addr === 'object' && addr ? addr.port : port;
  const formattedHostname =
    typeof addr === 'object' && addr && typeof addr.address === 'string'
      ? addr.address
      : listenHostname;
  const nextVersion =
    typeof manifest.build?.nextVersion === 'string'
      ? manifest.build.nextVersion
      : 'unknown';
  const buildId =
    typeof manifest.build?.buildId === 'string' ? manifest.build.buildId : 'unknown';
  console.log(
    `\n  Next.js (\x1b[36m${nextVersion}\x1b[0m) \x1b[2m|\x1b[0m adapter-bun\n` +
      `  Listening on http://${formattedHostname}:${listenPort}\n` +
      `  Build ID: ${buildId}\n`
  );
};
if (listenHostname === '0.0.0.0' || listenHostname === '::') {
  // Let Node choose an unspecified address so IPv6/IPv4 dual-stack works when available.
  server.listen(port, handleListening);
} else {
  server.listen(port, listenHostname, handleListening);
}
