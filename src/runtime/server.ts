import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import './early-timers.js';
// Must run before loading @next/routing/route handlers so AsyncLocalStorage
// and other Next.js node polyfills are available in Bun runtime.
import 'next/dist/build/adapter/setup-node-env.external.js';
import {
  detectLocale,
  resolveRoutes,
  responseToMiddlewareResult,
  type Route,
  type RouteHas,
  type ResolveRoutesQuery,
  type ResolveRoutesResult,
} from '@next/routing';
import {
  ACTION_HEADER,
  computeCacheBustingSearchParam,
  getMiddlewareRouteMatcher,
  isDynamicRoute,
  NEXT_RSC_UNION_QUERY,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL,
  RSC_HEADER,
  setCacheBustingSearchParamWithHash,
} from './next-compat.js';
import { getSharedPrerenderCacheStore } from './cache-store.js';
import { handleCacheHttpRequest } from './cache-http-server.js';

const DEFAULT_CACHE_HANDLER_MODE = 'http';
const DEFAULT_CACHE_ENDPOINT_PATH = '/_adapter/cache';
const DEFAULT_PORT = 3000;
const DEFAULT_HOSTNAME = '0.0.0.0';
const DEFAULT_KEEP_ALIVE_TIMEOUT = 75_000;
const REQUEST_BODY_BYTES_SYMBOL = Symbol.for('adapter-bun.request-body-bytes');

type CacheHandlerMode = 'sqlite' | 'http';
type RuntimeConfigRecord = Record<string, unknown>;
type RuntimeFunctionRuntime = 'nodejs' | 'edge';
type RuntimeRouteHandlerContext = {
  waitUntil?: (prom: Promise<void>) => void;
  requestMeta?: unknown;
};

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
}

type NodeRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RuntimeRouteHandlerContext
) => Promise<unknown>;

type EdgeRouteHandler = (
  request: Request,
  ctx: RuntimeRouteHandlerContext & { signal?: AbortSignal }
) => Promise<Response>;

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

interface RuntimeMiddlewareManifestEntry {
  name?: string;
  page?: string;
  matchers?: RuntimeMiddlewareRouteMatcher[];
}

interface RuntimeMiddlewareManifest {
  middleware?: Record<string, RuntimeMiddlewareManifestEntry>;
  functions?: Record<string, RuntimeMiddlewareManifestEntry>;
}

interface RuntimeFunctionsConfigManifestEntry {
  runtime?: string;
  matchers?: RuntimeMiddlewareRouteMatcher[];
}

interface RuntimeFunctionsConfigManifest {
  functions?: Record<string, RuntimeFunctionsConfigManifestEntry>;
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

interface RuntimeSection {
  cache?: RuntimeCacheConfig | null;
  routing?: RuntimeRoutingConfig | null;
  middleware?: RuntimeFunctionOutput | null;
  functions?: RuntimeFunctionOutput[];
  resolvedPathnameToSourcePage?: Record<string, string>;
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

function isWildcardHostname(value: string): boolean {
  return value === '0.0.0.0' || value === '::';
}

function resolveManifestPort(manifest: DeploymentManifest): number {
  const candidate = manifest.server?.port;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : DEFAULT_PORT;
}

function resolveManifestHostname(manifest: DeploymentManifest): string {
  const candidate = manifest.server?.hostname;
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : DEFAULT_HOSTNAME;
}

function resolveCacheRuntimeConfig(manifest: DeploymentManifest): {
  handlerMode: CacheHandlerMode;
  endpointPath: string;
  authToken: string;
} {
  const cacheConfig = manifest.runtime?.cache;
  const handlerMode: CacheHandlerMode =
    cacheConfig?.handlerMode === 'sqlite' ? 'sqlite' : DEFAULT_CACHE_HANDLER_MODE;
  const endpointPath =
    typeof cacheConfig?.endpointPath === 'string' && cacheConfig.endpointPath.length > 0
      ? cacheConfig.endpointPath
      : DEFAULT_CACHE_ENDPOINT_PATH;
  const authToken = typeof cacheConfig?.authToken === 'string' ? cacheConfig.authToken : '';

  return {
    handlerMode,
    endpointPath,
    authToken,
  };
}

function getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      entries.push(item);
    }
  }
  return entries;
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

function stripInternalRequestHeaders(headers: IncomingHttpHeaders): void {
  for (const key of Object.keys(headers)) {
    if (INTERNAL_REQUEST_HEADERS.has(key.toLowerCase())) {
      delete headers[key];
    }
  }
}

function isRedirectStatusCode(value: number | undefined): boolean {
  return typeof value === 'number' && value >= 300 && value < 400;
}

function markConnectionClose(res: ServerResponse): void {
  res.shouldKeepAlive = false;
  if (!res.headersSent) {
    res.setHeader('connection', 'close');
  }
}

function isExternalDestinationUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function replaceRouteDestinationCaptures(
  destination: string,
  regexMatch: RegExpMatchArray,
  routeMatches?: Record<string, string>,
  conditionCaptures?: Record<string, string>
): string {
  let nextDestination = destination;

  for (let index = 1; index < regexMatch.length; index += 1) {
    const matchValue = regexMatch[index];
    if (matchValue === undefined) {
      continue;
    }
    nextDestination = nextDestination.replace(new RegExp(`\\$${index}`, 'g'), matchValue);
  }

  const groupedMatches = (regexMatch as RegExpMatchArray & { groups?: Record<string, string> })
    .groups;
  if (groupedMatches) {
    for (const [key, value] of Object.entries(groupedMatches)) {
      if (value === undefined) {
        continue;
      }
      nextDestination = nextDestination.replace(new RegExp(`\\$${key}`, 'g'), value);
    }
  }

  const allNamedCaptures = {
    ...(conditionCaptures ?? {}),
    ...(routeMatches ?? {}),
  };
  for (const [key, value] of Object.entries(allNamedCaptures)) {
    if (typeof value !== 'string') {
      continue;
    }
    nextDestination = nextDestination.replace(new RegExp(`\\$${key}`, 'g'), value);
  }

  return nextDestination;
}

function matchRouteConditionValue(
  actualValue: string | undefined,
  expectedValue: string | undefined
): {
  matched: boolean;
  capturedValue?: string;
  namedCaptures?: Record<string, string>;
} {
  if (actualValue === undefined) {
    return { matched: false };
  }
  if (expectedValue === undefined) {
    return {
      matched: true,
      capturedValue: actualValue,
    };
  }
  try {
    const matcher = new RegExp(expectedValue);
    const match = actualValue.match(matcher);
    if (match) {
      const namedCaptures: Record<string, string> = {};
      const groupedMatches = (
        match as RegExpMatchArray & { groups?: Record<string, string | undefined> }
      ).groups;
      if (groupedMatches) {
        for (const [key, value] of Object.entries(groupedMatches)) {
          if (typeof value === 'string' && value.length > 0) {
            namedCaptures[key] = value;
          }
        }
      }
      return {
        matched: true,
        capturedValue: match[0],
        ...(Object.keys(namedCaptures).length > 0 ? { namedCaptures } : {}),
      };
    }
  } catch {
    // Fall through to exact match for invalid regex values.
  }
  if (actualValue === expectedValue) {
    return {
      matched: true,
      capturedValue: actualValue,
    };
  }
  return { matched: false };
}

function normalizeRouteConditionCaptureKey(key: string): string {
  return key.replace(/[^a-zA-Z]/g, '');
}

function getRouteConditionValue(
  condition: RuntimeRouteHas,
  requestUrl: URL,
  requestHeaders: Headers
): string | undefined {
  switch (condition.type) {
    case 'header':
      return requestHeaders.get(condition.key) ?? undefined;
    case 'cookie': {
      const cookieHeader = requestHeaders.get('cookie');
      if (!cookieHeader) {
        return undefined;
      }
      const cookies = cookieHeader.split(';').reduce<Record<string, string>>((acc, item) => {
        const [rawKey, ...rawValueParts] = item.trim().split('=');
        if (!rawKey) {
          return acc;
        }
        acc[rawKey] = rawValueParts.join('=');
        return acc;
      }, {});
      return cookies[condition.key];
    }
    case 'query':
      return requestUrl.searchParams.get(condition.key) ?? undefined;
    case 'host':
      return requestUrl.hostname;
  }
}

function checkRouteHasConditions(
  conditions: RuntimeRouteHas[] | undefined,
  requestUrl: URL,
  requestHeaders: Headers
): {
  matched: boolean;
  captures: Record<string, string>;
} {
  if (!conditions || conditions.length === 0) {
    return {
      matched: true,
      captures: {},
    };
  }

  const captures: Record<string, string> = {};
  for (const condition of conditions) {
    const conditionValue = getRouteConditionValue(condition, requestUrl, requestHeaders);
    const match = matchRouteConditionValue(
      conditionValue,
      'value' in condition ? condition.value : undefined
    );
    if (!match.matched) {
      return {
        matched: false,
        captures: {},
      };
    }
    if (match.capturedValue !== undefined && condition.type !== 'host') {
      const captureKey = normalizeRouteConditionCaptureKey(
        'key' in condition ? condition.key : ''
      );
      if (captureKey) {
        captures[captureKey] = match.capturedValue;
      }
    }
    if (match.namedCaptures) {
      for (const [key, value] of Object.entries(match.namedCaptures)) {
        captures[key] = value;
      }
    }
  }

  return {
    matched: true,
    captures,
  };
}

function checkRouteMissingConditions(
  conditions: RuntimeRouteHas[] | undefined,
  requestUrl: URL,
  requestHeaders: Headers
): boolean {
  if (!conditions || conditions.length === 0) {
    return true;
  }

  for (const condition of conditions) {
    const conditionValue = getRouteConditionValue(condition, requestUrl, requestHeaders);
    const match = matchRouteConditionValue(
      conditionValue,
      'value' in condition ? condition.value : undefined
    );
    if (match.matched) {
      return false;
    }
  }

  return true;
}

function matchRoutingRule(
  route: RuntimeRoute,
  requestUrl: URL,
  requestHeaders: Headers,
  caseInsensitive: boolean = false
):
  | { matched: false }
  | {
      matched: true;
      regexMatch: RegExpMatchArray;
      conditionCaptures: Record<string, string>;
    } {
  const sourceRegex = caseInsensitive
    ? new RegExp(route.sourceRegex, 'i')
    : new RegExp(route.sourceRegex);
  const regexMatch = requestUrl.pathname.match(sourceRegex);
  if (!regexMatch) {
    return { matched: false };
  }

  const hasCheck = checkRouteHasConditions(route.has, requestUrl, requestHeaders);
  if (!hasCheck.matched) {
    return { matched: false };
  }
  if (!checkRouteMissingConditions(route.missing, requestUrl, requestHeaders)) {
    return { matched: false };
  }

  return {
    matched: true,
    regexMatch,
    conditionCaptures: hasCheck.captures,
  };
}

function applyInternalRouteDestination(requestUrl: URL, destination: string): URL {
  const nextUrl = new URL(requestUrl.toString());
  const destinationParts = destination.split('?');
  const destinationPathname = destinationParts[0] || '';
  const destinationSearch = destinationParts[1];
  nextUrl.pathname = destinationPathname;
  if (destinationSearch) {
    const destinationSearchParams = new URLSearchParams(destinationSearch);
    for (const [key, value] of destinationSearchParams.entries()) {
      nextUrl.searchParams.set(key, value);
    }
  }

  return nextUrl;
}

function resolveCaseInsensitiveRoutingFallback(
  requestUrl: URL,
  requestHeaders: IncomingHttpHeaders,
  routingConfig: RuntimeRoutingConfig
): ResolveRoutesResult | null {
  const routeGroups: RuntimeRoute[][] = [
    routingConfig.beforeMiddleware,
    routingConfig.beforeFiles,
    routingConfig.afterFiles,
    routingConfig.fallback,
  ];
  const routingHeaders = toRequestHeaders(requestHeaders);
  const resolvedHeaders = new Headers();
  let status: number | undefined;
  let currentUrl = new URL(requestUrl.toString());

  for (const routes of routeGroups) {
    for (const route of routes) {
      const routeMatch = matchRoutingRule(route, currentUrl, routingHeaders, true);
      if (!routeMatch.matched) {
        continue;
      }

      if (route.headers) {
        for (const [headerKey, headerValue] of Object.entries(route.headers)) {
          const resolvedHeaderKey = replaceRouteDestinationCaptures(
            headerKey,
            routeMatch.regexMatch,
            undefined,
            routeMatch.conditionCaptures
          );
          const resolvedHeaderValue = replaceRouteDestinationCaptures(
            headerValue,
            routeMatch.regexMatch,
            undefined,
            routeMatch.conditionCaptures
          );
          resolvedHeaders.set(resolvedHeaderKey, resolvedHeaderValue);
        }
      }

      if (typeof route.status === 'number') {
        status = route.status;
      }

      if (!route.destination) {
        continue;
      }

      const destination = replaceRouteDestinationCaptures(
        route.destination,
        routeMatch.regexMatch,
        undefined,
        routeMatch.conditionCaptures
      );
      if (isRedirectStatusCode(route.status)) {
        const redirectUrl = isExternalDestinationUrl(destination)
          ? new URL(destination)
          : applyInternalRouteDestination(currentUrl, destination);
        return {
          redirect: {
            url: redirectUrl,
            status: route.status as number,
          },
          resolvedHeaders,
          ...(typeof status === 'number' ? { status } : {}),
        };
      }
      if (isExternalDestinationUrl(destination)) {
        return {
          externalRewrite: new URL(destination),
          resolvedHeaders,
          ...(typeof status === 'number' ? { status } : {}),
        };
      }
      currentUrl = applyInternalRouteDestination(currentUrl, destination);
      if (currentUrl.origin !== requestUrl.origin) {
        return {
          externalRewrite: currentUrl,
          resolvedHeaders,
          ...(typeof status === 'number' ? { status } : {}),
        };
      }
    }
  }

  return null;
}

function resolveRuntimeRewritePathname(
  requestUrl: URL,
  requestHeaders: IncomingHttpHeaders,
  routingConfig: RuntimeRoutingConfig
): string | undefined {
  const routeGroups: RuntimeRoute[][] = [
    routingConfig.beforeMiddleware,
    routingConfig.beforeFiles,
    routingConfig.afterFiles,
    routingConfig.fallback,
  ];
  const routingHeaders = toRequestHeaders(requestHeaders);
  const requestOrigin = requestUrl.origin;
  let currentUrl = new URL(requestUrl.toString());
  let didRewrite = false;

  for (const routes of routeGroups) {
    for (const route of routes) {
      const routeMatch = matchRoutingRule(route, currentUrl, routingHeaders, false);
      if (!routeMatch.matched || !route.destination) {
        continue;
      }

      const destination = replaceRouteDestinationCaptures(
        route.destination,
        routeMatch.regexMatch,
        undefined,
        routeMatch.conditionCaptures
      );

      if (isRedirectStatusCode(route.status) || isExternalDestinationUrl(destination)) {
        return didRewrite ? currentUrl.pathname : undefined;
      }

      const nextUrl = applyInternalRouteDestination(currentUrl, destination);
      if (nextUrl.origin !== requestOrigin) {
        return didRewrite ? currentUrl.pathname : undefined;
      }

      if (nextUrl.pathname !== currentUrl.pathname || nextUrl.search !== currentUrl.search) {
        didRewrite = true;
      }
      currentUrl = nextUrl;
    }
  }

  return didRewrite ? currentUrl.pathname : undefined;
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

function stripInterceptionMarkerPrefix(segment: string): string {
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
    .map((segment) => stripInterceptionMarkerPrefix(segment))
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

function normalizeRepeatedSlashes(url: string): string {
  const urlParts = url.split('?');
  const urlNoQuery = urlParts[0] ?? '';
  return (
    urlNoQuery.replace(/\\/g, '/').replace(/\/\/+/g, '/') +
    (urlParts[1] ? `?${urlParts.slice(1).join('?')}` : '')
  );
}

const ENABLE_DEBUG_ROUTING = process.env.ADAPTER_BUN_DEBUG_ROUTING === '1';
const ENABLE_DEBUG_CONNECTIONS = process.env.ADAPTER_BUN_DEBUG_CONNECTIONS === '1';
const ENABLE_DEBUG_TIMERS = process.env.ADAPTER_BUN_DEBUG_TIMERS === '1';
let nextDebugSocketId = 1;
const debugSocketIds = new WeakMap<IncomingMessage['socket'], number>();

function getDebugSocketId(socket: IncomingMessage['socket'] | undefined): number {
  if (!socket) {
    return 0;
  }
  const existing = debugSocketIds.get(socket);
  if (existing) {
    return existing;
  }
  const id = nextDebugSocketId;
  nextDebugSocketId += 1;
  debugSocketIds.set(socket, id);
  return id;
}

function shouldDebugRequest(url: string | undefined): boolean {
  if (!ENABLE_DEBUG_ROUTING || !url) {
    return false;
  }

  if (process.env.ADAPTER_BUN_DEBUG_ROUTING_ALL === '1') {
    return true;
  }

  return (
    url.includes('/blog/') ||
    url.includes('/blog-post-') ||
    url.includes('_rsc=') ||
    url.includes('/_next/data/')
  );
}

function debugRoutingLog(...args: unknown[]): void {
  if (ENABLE_DEBUG_ROUTING) {
    console.log('[adapter-bun][debug]', ...args);
  }
}

function debugHeadersToJson(headers: Headers | undefined): string {
  if (!headers) {
    return '{}';
  }

  const entries: Record<string, string> = {};
  headers.forEach((value, key) => {
    entries[key] = value;
  });
  return JSON.stringify(entries);
}

function normalizeRouterPrefetchHeader(
  value: string | undefined
): '1' | '2' | undefined {
  if (value === '1' || value === '2') {
    return value;
  }
  return undefined;
}

function getCanonicalRscUrl(
  requestUrl: URL,
  headers: IncomingHttpHeaders
): URL | null {
  const expectedHash = computeCacheBustingSearchParam(
    normalizeRouterPrefetchHeader(
      getSingleHeaderValue(headers[NEXT_ROUTER_PREFETCH_HEADER])
    ),
    getSingleHeaderValue(headers[NEXT_ROUTER_SEGMENT_PREFETCH_HEADER]),
    getSingleHeaderValue(headers[NEXT_ROUTER_STATE_TREE_HEADER]),
    getSingleHeaderValue(headers[NEXT_URL])
  );

  const actualHash = requestUrl.searchParams.get(NEXT_RSC_UNION_QUERY);
  if (expectedHash === actualHash) {
    return null;
  }

  const canonicalUrl = new URL(requestUrl);
  setCacheBustingSearchParamWithHash(canonicalUrl, expectedHash);
  return canonicalUrl;
}

function getHeaderValue(
  headers: Record<string, unknown> | undefined,
  name: string
): unknown {
  if (!headers) {
    return undefined;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return value;
    }
  }

  return undefined;
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
      const nextCacheHeaderValue =
        getHeaderValue(resolvedHeaders, 'x-nextjs-cache') ??
        res.getHeader('x-nextjs-cache');
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

function getNormalizedProtocolHeader(
  value: string | string[] | undefined
): string | undefined {
  const protocol = Array.isArray(value) ? value[0] : value;
  if (!protocol || typeof protocol !== 'string') {
    return undefined;
  }

  const normalized = protocol.split(',')[0]?.trim().toLowerCase();
  if (normalized === 'http' || normalized === 'https') {
    return normalized;
  }

  return undefined;
}

function getProtocolFromForwardedHeader(
  value: string | string[] | undefined
): string | undefined {
  const forwardedHeader = Array.isArray(value) ? value[0] : value;
  if (!forwardedHeader || typeof forwardedHeader !== 'string') {
    return undefined;
  }

  const normalized = forwardedHeader.split(',')[0]?.trim() ?? '';
  const match = normalized.match(/(?:^|;)\\s*proto=([^;\\s]+)/i);
  if (!match) {
    return undefined;
  }

  const protocol = match[1]?.replace(/^"|"$/g, '').toLowerCase();
  return protocol === 'http' || protocol === 'https' ? protocol : undefined;
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
  const protocol =
    getNormalizedProtocolHeader(headers['x-forwarded-proto']) ??
    getProtocolFromForwardedHeader(headers.forwarded) ??
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

function applyHostHeaderToUrl(url: URL, hostHeader: string | string[] | undefined): URL {
  const normalizedHost = getNormalizedHostHeader(hostHeader);
  if (!normalizedHost) {
    return url;
  }

  try {
    const nextUrl = new URL(url.toString());
    nextUrl.host = normalizedHost;
    return nextUrl;
  } catch {
    return url;
  }
}

function ensureForwardedRequestHeaders(
  req: IncomingMessage,
  requestUrl: URL
): void {
  const normalizedHost = getNormalizedHostHeader(req.headers.host);
  const effectiveHost = normalizedHost ?? requestUrl.host;
  if (effectiveHost && effectiveHost.length > 0) {
    req.headers.host = effectiveHost;
    req.headers['x-forwarded-host'] = effectiveHost;
  }

  const forwardedProto = requestUrl.protocol.replace(/:$/, '') || 'http';
  req.headers['x-forwarded-proto'] = forwardedProto;

  const forwardedPort =
    requestUrl.port || (forwardedProto === 'https' ? '443' : '80');
  req.headers['x-forwarded-port'] = forwardedPort;
}

async function waitForResponseFinish(
  res: ServerResponse,
  timeoutMs: number = 10_000
): Promise<void> {
  if (res.writableFinished || res.writableEnded || res.destroyed) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve();
    };

    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      res.off('finish', finish);
      resolve();
    }, timeoutMs);

    res.once('finish', finish);
  });
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

function mergeVaryHeaderValues(
  existingValue: string | string[] | number | undefined,
  requiredFields: string[]
): string {
  const merged = new Map<string, string>();

  const rawValues = Array.isArray(existingValue)
    ? existingValue
    : typeof existingValue === 'string'
      ? [existingValue]
      : typeof existingValue === 'number'
        ? [String(existingValue)]
        : [];

  for (const rawValue of rawValues) {
    for (const part of rawValue.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const key = trimmed.toLowerCase();
      if (!merged.has(key)) {
        merged.set(key, trimmed);
      }
    }
  }

  for (const requiredField of requiredFields) {
    const key = requiredField.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, requiredField);
    }
  }

  return [...merged.values()].join(', ');
}

function removePathnameTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function shouldPreservePathnameWithoutTrailingSlash(pathname: string): boolean {
  const lastSegment = pathname.split('/').pop() ?? '';
  return lastSegment.includes('.');
}

function applyConfiguredTrailingSlash(pathname: string): string {
  if (!trailingSlash || pathname === '/' || pathname.endsWith('/')) {
    return pathname;
  }
  if (shouldPreservePathnameWithoutTrailingSlash(pathname)) {
    return pathname;
  }
  return `${pathname}/`;
}

function resolveTrailingSlashPathnameFallback(
  pathname: string,
  pathnames: Set<string>
): string | null {
  if (!pathname.endsWith('/') || pathname === '/') {
    return null;
  }

  const withoutTrailingSlash = removePathnameTrailingSlash(pathname);
  return pathnames.has(withoutTrailingSlash) ? withoutTrailingSlash : null;
}

function toRoutingRouteHas(value: RuntimeRouteHas): RouteHas {
  if (value.type === 'host') {
    return {
      type: 'host',
      value: value.value,
    };
  }

  return {
    type: value.type,
    key: value.key,
    value: value.value,
  };
}

function toRoutingRoute(value: RuntimeRoute): Route {
  return {
    sourceRegex: value.sourceRegex,
    ...(typeof value.destination === 'string' ? { destination: value.destination } : {}),
    ...(value.headers ? { headers: { ...value.headers } } : {}),
    ...(value.has ? { has: value.has.map(toRoutingRouteHas) } : {}),
    ...(value.missing ? { missing: value.missing.map(toRoutingRouteHas) } : {}),
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
  };
}

function toRoutingRoutes(value: RuntimeRoutingConfig): {
  beforeMiddleware: Route[];
  beforeFiles: Route[];
  afterFiles: Route[];
  dynamicRoutes: Route[];
  onMatch: Route[];
  fallback: Route[];
  shouldNormalizeNextData: boolean;
} {
  return {
    beforeMiddleware: value.beforeMiddleware.map(toRoutingRoute),
    beforeFiles: value.beforeFiles.map(toRoutingRoute),
    afterFiles: value.afterFiles.map(toRoutingRoute),
    dynamicRoutes: value.dynamicRoutes.map(toRoutingRoute),
    onMatch: value.onMatch.map(toRoutingRoute),
    fallback: value.fallback.map(toRoutingRoute),
    shouldNormalizeNextData: Boolean(value.shouldNormalizeNextData),
  };
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

type RoutingI18nConfig = NonNullable<ReturnType<typeof toRoutingI18n>>;

function isRootPathnameForLocaleDetection(pathname: string, basePath: string): boolean {
  const withoutBasePath = getPathnameWithoutBasePath(pathname, basePath);
  return withoutBasePath === '/' || withoutBasePath.length === 0;
}

function getPathnameWithoutBasePath(pathname: string, basePath: string): string {
  const withoutBasePath =
    basePath && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length) || '/'
      : pathname;
  return withoutBasePath.length > 0 ? withoutBasePath : '/';
}

function hasLocalePrefixInPathname(
  pathname: string,
  basePath: string,
  i18n: ReturnType<typeof toRoutingI18n>
): boolean {
  if (!i18n) {
    return false;
  }
  const withoutBasePath = getPathnameWithoutBasePath(pathname, basePath);
  for (const locale of i18n.locales) {
    if (
      withoutBasePath === `/${locale}` ||
      withoutBasePath.startsWith(`/${locale}/`)
    ) {
      return true;
    }
  }
  return false;
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

function stripLocalePrefixFromPathname(
  pathname: string,
  basePath: string,
  i18n: ReturnType<typeof toRoutingI18n>
): string {
  if (!i18n) {
    return pathname;
  }

  const withoutBasePath = getPathnameWithoutBasePath(pathname, basePath);
  for (const locale of i18n.locales) {
    const localePrefix = `/${locale}`;
    if (withoutBasePath === localePrefix) {
      return basePath || '/';
    }
    if (withoutBasePath.startsWith(`${localePrefix}/`)) {
      const withoutLocalePrefix = withoutBasePath.slice(localePrefix.length);
      const normalizedWithoutLocalePrefix =
        withoutLocalePrefix.length > 0 ? withoutLocalePrefix : '/';
      return basePath
        ? `${basePath}${normalizedWithoutLocalePrefix}`
        : normalizedWithoutLocalePrefix;
    }
  }

  return pathname;
}

function isApiPathname(
  pathname: string,
  basePath: string,
  i18n: ReturnType<typeof toRoutingI18n>
): boolean {
  const withoutBasePath = getPathnameWithoutBasePath(pathname, basePath);
  if (withoutBasePath === '/api' || withoutBasePath.startsWith('/api/')) {
    return true;
  }
  if (!i18n) {
    return false;
  }

  for (const locale of i18n.locales) {
    if (
      withoutBasePath === `/${locale}/api` ||
      withoutBasePath.startsWith(`/${locale}/api/`)
    ) {
      return true;
    }
  }

  return false;
}

function maybeStripDefaultLocaleFromLocation(
  location: string,
  basePath: string,
  i18n: ReturnType<typeof toRoutingI18n>,
  requestHasLocalePrefix: boolean,
  requestOrigin: string
): string {
  if (!i18n || requestHasLocalePrefix) {
    return location;
  }

  let parsed: URL;
  try {
    parsed = new URL(location, requestOrigin);
  } catch {
    return location;
  }

  const base = basePath || '';
  const localePrefix = `${base}/${i18n.defaultLocale}`;
  if (parsed.pathname === localePrefix) {
    parsed.pathname = base || '/';
  } else if (parsed.pathname.startsWith(`${localePrefix}/`)) {
    parsed.pathname = `${base}${parsed.pathname.slice(localePrefix.length)}`;
  } else {
    return location;
  }

  return parsed.origin === requestOrigin
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : parsed.toString();
}

function getRoutingI18nForRequest(
  i18n: ReturnType<typeof toRoutingI18n>,
  pathname: string,
  basePath: string,
  headers: IncomingHttpHeaders,
  hostname: string
): ReturnType<typeof toRoutingI18n> {
  if (!i18n || i18n.localeDetection === false) {
    return i18n;
  }

  const isNextDataRequest = getSingleHeaderValue(headers['x-nextjs-data']) === '1';
  const shouldDetectLocale =
    !isNextDataRequest && isRootPathnameForLocaleDetection(pathname, basePath);

  if (shouldDetectLocale) {
    const pathnameWithoutBasePath = getPathnameWithoutBasePath(pathname, basePath);
    const detectedLocale = detectLocale({
      pathname: pathnameWithoutBasePath,
      hostname,
      cookieHeader: getSingleHeaderValue(headers.cookie),
      acceptLanguageHeader: getSingleHeaderValue(headers['accept-language']),
      i18n,
    }).locale;
    // Keep root requests unprefixed for the default locale. Enable
    // @next/routing i18n handling only when a non-default locale redirect is
    // required.
    return detectedLocale === i18n.defaultLocale ? undefined : i18n;
  }

  // Next.js locale detection only applies to root document requests. For
  // non-root paths (or data requests), unprefixed paths must stay on the
  // default locale unless an explicit locale prefix is present.
  return {
    ...i18n,
    localeDetection: false,
  };
}

function headersToIncomingHttpHeaders(headers: Headers): IncomingHttpHeaders {
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

  return incomingHeaders;
}

function searchParamsToMatcherQuery(
  searchParams: URLSearchParams
): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
      continue;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      continue;
    }
    query[key] = [existing, value];
  }
  return query;
}

function findMiddlewareManifestEntry(
  manifestValue: RuntimeMiddlewareManifest | null,
  middleware: RuntimeFunctionOutput
): RuntimeMiddlewareManifestEntry | null {
  if (!manifestValue) {
    return null;
  }

  const manifestSections = [manifestValue.middleware, manifestValue.functions];
  for (const section of manifestSections) {
    if (!section) {
      continue;
    }

    const directCandidates = [
      section[middleware.sourcePage],
      section[middleware.pathname],
      section[middleware.id],
      section['/'],
    ];
    for (const candidate of directCandidates) {
      if (candidate?.matchers && candidate.matchers.length > 0) {
        return candidate;
      }
    }

    for (const candidate of Object.values(section)) {
      if (!candidate?.matchers || candidate.matchers.length === 0) {
        continue;
      }
      if (
        candidate.name === middleware.id ||
        candidate.page === middleware.sourcePage ||
        candidate.page === middleware.pathname
      ) {
        return candidate;
      }
    }
  }

  return null;
}

function findFunctionsConfigManifestEntry(
  manifestValue: RuntimeFunctionsConfigManifest | null,
  middleware: RuntimeFunctionOutput
): RuntimeFunctionsConfigManifestEntry | null {
  if (!manifestValue?.functions) {
    return null;
  }

  const directCandidates = [
    manifestValue.functions[middleware.sourcePage],
    manifestValue.functions[middleware.pathname],
    manifestValue.functions[middleware.id],
    manifestValue.functions['/_middleware'],
    manifestValue.functions['/'],
  ];
  for (const candidate of directCandidates) {
    if (candidate?.matchers && candidate.matchers.length > 0) {
      return candidate;
    }
  }

  for (const candidate of Object.values(manifestValue.functions)) {
    if (!candidate?.matchers || candidate.matchers.length === 0) {
      continue;
    }
    return candidate;
  }

  return null;
}

async function loadMiddlewareMatcher(
  distDir: string | undefined,
  middleware: RuntimeFunctionOutput | null
): Promise<
  | ((pathname: string, req: { headers: IncomingHttpHeaders }, query: Record<string, string | string[]>) => boolean)
  | null
> {
  if (!distDir || !middleware) {
    return null;
  }

  const middlewareManifestPath = path.join(distDir, 'server', 'middleware-manifest.json');
  const middlewareManifestFile = Bun.file(middlewareManifestPath);
  if (await middlewareManifestFile.exists()) {
    let middlewareManifestValue: RuntimeMiddlewareManifest | null = null;
    try {
      middlewareManifestValue =
        (await middlewareManifestFile.json()) as RuntimeMiddlewareManifest;
    } catch {
      middlewareManifestValue = null;
    }

    const middlewareManifestEntry = findMiddlewareManifestEntry(
      middlewareManifestValue,
      middleware
    );
    if (middlewareManifestEntry?.matchers && middlewareManifestEntry.matchers.length > 0) {
      return getMiddlewareRouteMatcher(
        middlewareManifestEntry.matchers as Parameters<typeof getMiddlewareRouteMatcher>[0]
      ) as (
        pathname: string,
        req: { headers: IncomingHttpHeaders },
        query: Record<string, string | string[]>
      ) => boolean;
    }
  }

  const functionsConfigManifestPath = path.join(
    distDir,
    'server',
    'functions-config-manifest.json'
  );
  const functionsConfigManifestFile = Bun.file(functionsConfigManifestPath);
  if (!(await functionsConfigManifestFile.exists())) {
    return null;
  }

  let functionsConfigManifestValue: RuntimeFunctionsConfigManifest | null = null;
  try {
    functionsConfigManifestValue =
      (await functionsConfigManifestFile.json()) as RuntimeFunctionsConfigManifest;
  } catch {
    return null;
  }

  const functionsConfigManifestEntry = findFunctionsConfigManifestEntry(
    functionsConfigManifestValue,
    middleware
  );
  if (!functionsConfigManifestEntry?.matchers || functionsConfigManifestEntry.matchers.length === 0) {
    return null;
  }

  return getMiddlewareRouteMatcher(
    functionsConfigManifestEntry.matchers as Parameters<typeof getMiddlewareRouteMatcher>[0]
  ) as (
    pathname: string,
    req: { headers: IncomingHttpHeaders },
    query: Record<string, string | string[]>
  ) => boolean;
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

function isStaticMetadataTextAssetPathname(pathname: string): boolean {
  return (
    pathname.endsWith('/robots.txt') ||
    pathname.endsWith('/manifest.webmanifest') ||
    pathname.endsWith('/sitemap.xml')
  );
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
  } else if (isStaticMetadataTextAssetPathname(asset.pathname)) {
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

function createWaitUntilCollector(): {
  waitUntil: (prom: Promise<void>) => void;
  drain: () => Promise<void>;
} {
  const pending: Promise<void>[] = [];

  return {
    waitUntil(prom) {
      pending.push(
        Promise.resolve(prom).catch((error) => {
          console.error('[adapter-bun] waitUntil task failed:', error);
        })
      );
    },
    async drain() {
      await Promise.allSettled(pending);
    },
  };
}

function isImportableEdgeAsset(filePath: string): boolean {
  return filePath.endsWith('.js') || filePath.endsWith('.mjs');
}

type ResolveRoutesResultLegacyShape = Partial<ResolveRoutesResult> & {
  matchedPathname?: unknown;
};

function toResolveRoutesQueryFromSearchParams(
  searchParams: URLSearchParams
): ResolveRoutesQuery | undefined {
  const query: ResolveRoutesQuery = {};
  for (const [key, value] of searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
      continue;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      continue;
    }
    query[key] = [existing, value];
  }

  return Object.keys(query).length > 0 ? query : undefined;
}

function hasUnresolvedRouteMatchPlaceholder(
  routeMatches: Record<string, string> | undefined
): boolean {
  if (!routeMatches) {
    return false;
  }

  for (const value of Object.values(routeMatches)) {
    if (typeof value !== 'string' || value.length <= 1) {
      continue;
    }
    if (value.startsWith('$')) {
      return true;
    }
  }

  return false;
}

function selectPathnameForParamExtraction(
  pathnames: Array<string | null | undefined>
): string | undefined {
  for (const pathname of pathnames) {
    if (typeof pathname === 'string' && pathname.length > 0) {
      return pathname;
    }
  }

  return undefined;
}

function mergeResolveRoutesQuery(
  base: ResolveRoutesQuery | undefined,
  overrides: ResolveRoutesQuery | undefined
): ResolveRoutesQuery | undefined {
  if (!base) {
    return overrides;
  }
  if (!overrides) {
    return base;
  }
  return {
    ...base,
    ...overrides,
  };
}

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
  const searchQuery = toResolveRoutesQueryFromSearchParams(resolveUrl.searchParams);
  const routeQuery = toResolveRoutesQueryFromRouteMatches(
    routeMatches,
    matchedPathname
  );
  const resolvedQuery = mergeResolveRoutesQuery(searchQuery, routeQuery);

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

function toSearchStringFromResolveRoutesQuery(
  query: ResolveRoutesQuery | undefined
): string {
  if (!query) {
    return '';
  }

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        searchParams.append(key, entry);
      }
      continue;
    }
    searchParams.append(key, value);
  }

  const search = searchParams.toString();
  return search.length > 0 ? `?${search}` : '';
}

function isAppFunctionOutput(output: RuntimeFunctionOutput | undefined): boolean {
  if (!output) {
    return false;
  }

  const normalizedFilePath = output.filePath.replace(/\\/g, '/');
  if (normalizedFilePath.includes('/server/app/')) {
    return true;
  }
  if (normalizedFilePath.includes('/server/pages/')) {
    return false;
  }

  if (output.sourcePage.endsWith('/page')) {
    return true;
  }
  if (output.sourcePage.endsWith('/route') && !output.sourcePage.startsWith('/api/')) {
    return true;
  }

  return false;
}

function toRequestMeta({
  requestUrl,
  revalidate,
}: {
  requestUrl: URL;
  revalidate?: RuntimeInternalRevalidate;
}): RuntimeRequestMeta {
  const meta: RuntimeRequestMeta = {
    initURL: requestUrl.toString(),
    initProtocol: requestUrl.protocol.replace(/:$/, '') || 'http',
    hostname: requestUrl.hostname,
    ...(revalidate ? { revalidate } : {}),
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
const port =
  Number.isFinite(requestedPort) && requestedPort > 0
    ? requestedPort
    : resolveManifestPort(manifest);
const listenHostname = resolveManifestHostname(manifest);
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

const cacheRuntime = resolveCacheRuntimeConfig(manifest);
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
const runtimeRouting = runtimeRoutingConfig ? toRoutingRoutes(runtimeRoutingConfig) : null;
const runtimeI18n = toRoutingI18n(runtimeRoutingConfig?.i18n);
const runtimeMiddleware = manifest.runtime?.middleware ?? null;
const runtimeMiddlewareMatcher = await loadMiddlewareMatcher(
  manifestDistDir,
  runtimeMiddleware
);
const runtimeFunctionOutputs = manifest.runtime?.functions ?? [];
const runtimeResolvedPathnameToSourcePage =
  manifest.runtime?.resolvedPathnameToSourcePage ?? {};

if (ENABLE_DEBUG_ROUTING) {
  debugRoutingLog(
    'function-outputs',
    JSON.stringify(runtimeFunctionOutputs.map((output) => output.pathname))
  );
}

const functionOutputByPathname = new Map<string, RuntimeFunctionOutput>();
const functionOutputsBySourcePage = new Map<string, RuntimeFunctionOutput[]>();
for (const output of runtimeFunctionOutputs) {
  functionOutputByPathname.set(output.pathname, output);
  const existing = functionOutputsBySourcePage.get(output.sourcePage);
  if (existing) {
    existing.push(output);
  } else {
    functionOutputsBySourcePage.set(output.sourcePage, [output]);
  }
}

const sourcePageByResolvedPathname = new Map<string, string>();
if (isRecord(runtimeResolvedPathnameToSourcePage)) {
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
const appSourcePages = new Set<string>();
for (const [sourcePage, outputs] of functionOutputsBySourcePage.entries()) {
  if (outputs.some((output) => isAppFunctionOutput(output))) {
    appSourcePages.add(sourcePage);
  }
}
const dynamicOutputMatchers = createDynamicOutputMatchers(functionOutputsBySourcePage);

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

function decodePathnameSegmentsPreservingEncodedSlashes(pathname: string): string {
  const segments = pathname.split('/');
  const decodedSegments = segments.map((segment) => {
    if (segment.length === 0) {
      return segment;
    }
    return decodePathnameSegmentPreservingEncodedSlashes(segment);
  });
  return decodedSegments.join('/');
}

function encodePathnameSegmentsPreservingEncodedSlashes(pathname: string): string {
  const segments = pathname.split('/');
  const encodedSegments = segments.map((segment) => {
    if (segment.length === 0) {
      return segment;
    }

    const parts = segment.split(/%2F/gi);
    const encodedParts = parts.map((part) => {
      const decodedPart = decodePathnameSegmentPreservingEncodedSlashes(part);
      return encodeURIComponent(decodedPart);
    });
    return encodedParts.join('%2F');
  });
  return encodedSegments.join('/');
}

function addPathnameEncodingVariants(candidates: Set<string>, pathname: string): void {
  candidates.add(pathname);
  candidates.add(decodePathnameSegmentsPreservingEncodedSlashes(pathname));
  candidates.add(encodePathnameSegmentsPreservingEncodedSlashes(pathname));
}

function addManifestPathnameCandidates(candidates: Set<string>, pathname: string): void {
  addPathnameEncodingVariants(candidates, pathname);

  const indexAlias = getIndexAlias(pathname);
  if (indexAlias) {
    addPathnameEncodingVariants(candidates, indexAlias);
  }
}

function getRoutingPathnameCandidates(pathnames: string[]): string[] {
  const candidates = new Set<string>();
  for (const pathname of pathnames) {
    addManifestPathnameCandidates(candidates, pathname);
  }
  return Array.from(candidates);
}

const routingPathnames = getRoutingPathnameCandidates([
  ...manifest.pathnames,
  ...manifest.staticAssets.map((asset) => asset.pathname),
  ...runtimeFunctionOutputs.map((output) => output.pathname),
]);
const routingPathnameSet = new Set(routingPathnames);

function isNextInternalPathname(pathname: string): boolean {
  return pathname === '/_next' || pathname.startsWith('/_next/');
}

function getFunctionOutputByPathname(pathname: string): RuntimeFunctionOutput | undefined {
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
  const candidates = new Set<string>();
  addManifestPathnameCandidates(candidates, pathname);
  if (runtimeI18n) {
    const withoutLocalePrefix = stripLocalePrefixFromPathname(
      pathname,
      basePath,
      runtimeI18n
    );
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

  const outputByPathname = new Map<string, RuntimeFunctionOutput>();
  for (const output of outputs) {
    outputByPathname.set(output.pathname, output);
  }

  const candidates = new Set<string>();
  addManifestPathnameCandidates(candidates, pathname);
  for (const candidate of candidates) {
    const output = outputByPathname.get(candidate);
    if (output) {
      return output;
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

function toDynamicOutputRouteSegments(pathname: string): DynamicOutputRouteSegment[] {
  const normalizedPathname = normalizePathnameForRouteMatching(
    stripRscPathnameSuffix(pathname)
  );
  const segments = normalizedPathname.split('/').filter((segment) => segment.length > 0);
  const routeSegments: DynamicOutputRouteSegment[] = [];
  for (const segment of segments) {
    const normalizedSegment = stripInterceptionMarkerPrefix(segment);
    if (
      normalizedSegment.startsWith('[[...') &&
      normalizedSegment.endsWith(']]')
    ) {
      const key = normalizedSegment.slice('[[...'.length, -']]'.length);
      routeSegments.push({
        type: 'optionalCatchall',
        key,
      });
      continue;
    }
    if (normalizedSegment.startsWith('[...') && normalizedSegment.endsWith(']')) {
      const key = normalizedSegment.slice('[...'.length, -']'.length);
      routeSegments.push({
        type: 'catchall',
        key,
      });
      continue;
    }
    if (normalizedSegment.startsWith('[') && normalizedSegment.endsWith(']')) {
      const key = normalizedSegment.slice('['.length, -']'.length);
      routeSegments.push({
        type: 'dynamic',
        key,
      });
      continue;
    }

    routeSegments.push({
      type: 'static',
      value: normalizedSegment,
    });
  }
  return routeSegments;
}

function compareDynamicOutputMatchers(
  left: DynamicOutputMatcher,
  right: DynamicOutputMatcher
): number {
  if (left.staticSegmentCount !== right.staticSegmentCount) {
    return right.staticSegmentCount - left.staticSegmentCount;
  }
  if (left.catchAllSegmentCount !== right.catchAllSegmentCount) {
    return left.catchAllSegmentCount - right.catchAllSegmentCount;
  }
  if (
    left.optionalCatchAllSegmentCount !== right.optionalCatchAllSegmentCount
  ) {
    return left.optionalCatchAllSegmentCount - right.optionalCatchAllSegmentCount;
  }
  if (left.segments.length !== right.segments.length) {
    return right.segments.length - left.segments.length;
  }
  return left.pathname.localeCompare(right.pathname);
}

function createDynamicOutputMatchers(
  outputsBySourcePage: Map<string, RuntimeFunctionOutput[]>
): DynamicOutputMatcher[] {
  const matchers: DynamicOutputMatcher[] = [];
  const seen = new Set<string>();
  for (const [sourcePage, outputs] of outputsBySourcePage.entries()) {
    for (const output of outputs) {
      const matcherPathname = stripRscPathnameSuffix(output.pathname);
      if (!isDynamicRoute(matcherPathname)) {
        continue;
      }

      const matcherKey = `${sourcePage}:${matcherPathname}`;
      if (seen.has(matcherKey)) {
        continue;
      }
      seen.add(matcherKey);

      const segments = toDynamicOutputRouteSegments(matcherPathname);
      let staticSegmentCount = 0;
      let catchAllSegmentCount = 0;
      let optionalCatchAllSegmentCount = 0;
      for (const segment of segments) {
        if (segment.type === 'static') {
          staticSegmentCount += 1;
        } else if (segment.type === 'catchall') {
          catchAllSegmentCount += 1;
        } else if (segment.type === 'optionalCatchall') {
          optionalCatchAllSegmentCount += 1;
          catchAllSegmentCount += 1;
        }
      }

      matchers.push({
        sourcePage,
        pathname: matcherPathname,
        segments,
        staticSegmentCount,
        catchAllSegmentCount,
        optionalCatchAllSegmentCount,
      });
    }
  }

  matchers.sort(compareDynamicOutputMatchers);
  return matchers;
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

function getDynamicParamsForOutputRequestPathname(
  output: RuntimeFunctionOutput,
  requestPathname: string,
  rscSuffix?: string
): RuntimeRequestMetaParams | undefined {
  const matcherPathname = stripRscPathnameSuffix(output.pathname);
  if (!isDynamicRoute(matcherPathname)) {
    return undefined;
  }

  const matcher =
    dynamicOutputMatchers.find(
      (entry) => entry.pathname === matcherPathname && entry.sourcePage === output.sourcePage
    ) ??
    dynamicOutputMatchers.find(
      (entry) => entry.pathname === matcherPathname
    );
  if (!matcher) {
    return undefined;
  }

  const candidatePathnames = new Set<string>();
  const pushCandidatePathname = (pathname: string): void => {
    if (!pathname) {
      return;
    }
    addManifestPathnameCandidates(candidatePathnames, withOptionalSuffix(pathname, rscSuffix));
    addManifestPathnameCandidates(candidatePathnames, pathname);
    if (runtimeI18n) {
      const strippedPathname = stripLocalePrefixFromPathname(pathname, basePath, runtimeI18n);
      if (strippedPathname !== pathname) {
        addManifestPathnameCandidates(
          candidatePathnames,
          withOptionalSuffix(strippedPathname, rscSuffix)
        );
        addManifestPathnameCandidates(candidatePathnames, strippedPathname);
      }
    }
  };

  pushCandidatePathname(requestPathname);
  pushCandidatePathname(withOptionalSuffix(requestPathname, rscSuffix));

  for (const candidatePathname of candidatePathnames) {
    const params = matchDynamicOutputPathname(candidatePathname, matcher);
    if (params && Object.keys(params).length > 0) {
      return params;
    }
  }

  return undefined;
}

function preferRscFunctionOutput(
  output: RuntimeFunctionOutput,
  preferRscOutput: boolean
): RuntimeFunctionOutput {
  if (!preferRscOutput || output.pathname.endsWith('.rsc')) {
    return output;
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

  const candidatePathnames: string[] = [];
  const pushPathname = (pathname: string): void => {
    if (!pathname) {
      return;
    }
    if (!candidatePathnames.includes(pathname)) {
      candidatePathnames.push(pathname);
    }
  };

  pushPathname(withOptionalSuffix(matchedPathname, rscSuffix));
  pushPathname(matchedPathname);
  pushPathname(withOptionalSuffix(requestPathname, rscSuffix));
  pushPathname(requestPathname);

  if (runtimeI18n) {
    const strippedMatchedPathname = stripLocalePrefixFromPathname(
      matchedPathname,
      basePath,
      runtimeI18n
    );
    if (strippedMatchedPathname !== matchedPathname) {
      pushPathname(withOptionalSuffix(strippedMatchedPathname, rscSuffix));
      pushPathname(strippedMatchedPathname);
    }
    const strippedRequestPathname = stripLocalePrefixFromPathname(
      requestPathname,
      basePath,
      runtimeI18n
    );
    if (strippedRequestPathname !== requestPathname) {
      pushPathname(withOptionalSuffix(strippedRequestPathname, rscSuffix));
      pushPathname(strippedRequestPathname);
    }
  }

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

function resolveAppFunctionOutputForRequestPathname(
  requestPathname: string,
  rscSuffix?: string,
  preferRscOutput: boolean = false
): ResolvedFunctionOutput | null {
  if (appSourcePages.size === 0) {
    return null;
  }

  const candidatePathnames = new Set<string>();
  const pushCandidatePathname = (pathname: string): void => {
    if (!pathname) {
      return;
    }
    addManifestPathnameCandidates(candidatePathnames, withOptionalSuffix(pathname, rscSuffix));
    addManifestPathnameCandidates(candidatePathnames, pathname);
    if (runtimeI18n) {
      const strippedPathname = stripLocalePrefixFromPathname(pathname, basePath, runtimeI18n);
      if (strippedPathname !== pathname) {
        addManifestPathnameCandidates(
          candidatePathnames,
          withOptionalSuffix(strippedPathname, rscSuffix)
        );
        addManifestPathnameCandidates(candidatePathnames, strippedPathname);
      }
    }
  };

  pushCandidatePathname(requestPathname);
  pushCandidatePathname(withOptionalSuffix(requestPathname, rscSuffix));

  for (const candidatePathname of candidatePathnames) {
    const exactOutput = getFunctionOutputByPathname(candidatePathname);
    if (exactOutput && isAppFunctionOutput(exactOutput)) {
      return { output: preferRscFunctionOutput(exactOutput, preferRscOutput) };
    }

    const sourcePage = getSourcePageForResolvedPathname(candidatePathname);
    if (sourcePage && appSourcePages.has(sourcePage)) {
      const mappedOutput = resolveFunctionOutputBySourcePage({
        sourcePage,
        matchedPathname: candidatePathname,
        requestPathname: candidatePathname,
        rscSuffix,
        preferRscOutput,
      });
      if (mappedOutput && isAppFunctionOutput(mappedOutput.output)) {
        return mappedOutput;
      }
    }

    for (const matcher of dynamicOutputMatchers) {
      if (!appSourcePages.has(matcher.sourcePage)) {
        continue;
      }
      const dynamicParams = matchDynamicOutputPathname(candidatePathname, matcher);
      if (!dynamicParams) {
        continue;
      }
      const matchedOutput = resolveFunctionOutputBySourcePage({
        sourcePage: matcher.sourcePage,
        matchedPathname: matcher.pathname,
        requestPathname: candidatePathname,
        rscSuffix,
        preferRscOutput,
      });
      if (!matchedOutput || !isAppFunctionOutput(matchedOutput.output)) {
        continue;
      }
      return Object.keys(dynamicParams).length > 0
        ? {
            ...matchedOutput,
            params: dynamicParams,
          }
        : matchedOutput;
    }
  }

  return null;
}

function resolveFunctionOutput(
  matchedPathname: string,
  requestPathname: string,
  rscSuffix?: string,
  preferRscOutput: boolean = false
): ResolvedFunctionOutput | null {
  const preferredMatchedPathname = withOptionalSuffix(matchedPathname, rscSuffix);
  const exactOutput =
    getFunctionOutputByPathname(preferredMatchedPathname) ??
    getFunctionOutputByPathname(matchedPathname);
  if (exactOutput) {
    if (!isAppFunctionOutput(exactOutput)) {
      const appOutputForRequestPathname = resolveAppFunctionOutputForRequestPathname(
        requestPathname,
        rscSuffix,
        preferRscOutput
      );
      if (appOutputForRequestPathname) {
        return appOutputForRequestPathname;
      }
    }
    const exactDynamicParams = getDynamicParamsForOutputRequestPathname(
      exactOutput,
      requestPathname,
      rscSuffix
    );
    const mappedByExactOutput = resolveFunctionOutputBySourcePage({
      sourcePage: exactOutput.sourcePage,
      matchedPathname,
      requestPathname,
      rscSuffix,
      preferRscOutput,
    });
    if (mappedByExactOutput) {
      return exactDynamicParams
        ? {
            ...mappedByExactOutput,
            params: exactDynamicParams,
          }
        : mappedByExactOutput;
    }
    return exactDynamicParams
      ? {
          output: preferRscFunctionOutput(exactOutput, preferRscOutput),
          params: exactDynamicParams,
        }
      : { output: preferRscFunctionOutput(exactOutput, preferRscOutput) };
  }

  const matchedWithoutBasePath = getPathnameWithoutBasePath(matchedPathname, basePath);
  const requestWithoutBasePath = getPathnameWithoutBasePath(requestPathname, basePath);
  if (
    isNextInternalPathname(removePathnameTrailingSlash(matchedWithoutBasePath)) ||
    isNextInternalPathname(removePathnameTrailingSlash(requestWithoutBasePath))
  ) {
    return null;
  }

  const candidateSourcePages: string[] = [];
  const pushSourcePage = (sourcePage: string | undefined): void => {
    if (!sourcePage) {
      return;
    }
    if (!candidateSourcePages.includes(sourcePage)) {
      candidateSourcePages.push(sourcePage);
    }
  };

  pushSourcePage(getSourcePageForResolvedPathname(preferredMatchedPathname));
  pushSourcePage(getSourcePageForResolvedPathname(matchedPathname));
  pushSourcePage(getSourcePageForResolvedPathname(withOptionalSuffix(requestPathname, rscSuffix)));
  pushSourcePage(getSourcePageForResolvedPathname(requestPathname));

  for (const sourcePage of candidateSourcePages) {
    const mappedOutput = resolveFunctionOutputBySourcePage({
      sourcePage,
      matchedPathname,
      requestPathname,
      rscSuffix,
      preferRscOutput,
    });
    if (mappedOutput) {
      return mappedOutput;
    }
  }

  const shouldUseDynamicMatcherFallback =
    isApiPathname(matchedPathname, basePath, runtimeI18n) ||
    isApiPathname(requestPathname, basePath, runtimeI18n);
  if (shouldUseDynamicMatcherFallback && dynamicOutputMatchers.length > 0) {
    const candidatePathnames = new Set<string>();
    const pushCandidatePathname = (pathname: string): void => {
      if (!pathname) {
        return;
      }
      addManifestPathnameCandidates(candidatePathnames, withOptionalSuffix(pathname, rscSuffix));
      addManifestPathnameCandidates(candidatePathnames, pathname);
      if (runtimeI18n) {
        const strippedPathname = stripLocalePrefixFromPathname(pathname, basePath, runtimeI18n);
        if (strippedPathname !== pathname) {
          addManifestPathnameCandidates(
            candidatePathnames,
            withOptionalSuffix(strippedPathname, rscSuffix)
          );
          addManifestPathnameCandidates(candidatePathnames, strippedPathname);
        }
      }
    };

    pushCandidatePathname(preferredMatchedPathname);
    pushCandidatePathname(matchedPathname);
    pushCandidatePathname(withOptionalSuffix(requestPathname, rscSuffix));
    pushCandidatePathname(requestPathname);

    for (const candidatePathname of candidatePathnames) {
      for (const matcher of dynamicOutputMatchers) {
        const dynamicParams = matchDynamicOutputPathname(candidatePathname, matcher);
        if (!dynamicParams) {
          continue;
        }
        const matchedOutput = resolveFunctionOutputBySourcePage({
          sourcePage: matcher.sourcePage,
          matchedPathname: matcher.pathname,
          requestPathname,
          rscSuffix,
          preferRscOutput,
        });
        if (!matchedOutput) {
          continue;
        }
        return Object.keys(dynamicParams).length > 0
          ? {
              ...matchedOutput,
              params: dynamicParams,
            }
          : matchedOutput;
      }
    }
  }

  return null;
}

const staticAssetByPathname = new Map<string, StaticAsset>();
for (const asset of manifest.staticAssets) {
  staticAssetByPathname.set(asset.pathname, asset);
}

function resolveStaticAsset(pathname: string, rscSuffix?: string): StaticAsset | undefined {
  const candidatePathnames = new Set<string>();
  addManifestPathnameCandidates(
    candidatePathnames,
    withOptionalSuffix(pathname, rscSuffix)
  );
  addManifestPathnameCandidates(candidatePathnames, pathname);

  for (const candidatePathname of candidatePathnames) {
    const asset = staticAssetByPathname.get(candidatePathname);
    if (asset) {
      return asset;
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

function hasPrerenderCacheEntryForPathname(pathname: string): boolean {
  const store = getSharedPrerenderCacheStore();
  const candidates = new Set<string>();
  addManifestPathnameCandidates(candidates, pathname);

  for (const candidate of candidates) {
    if (store.get(candidate)) {
      return true;
    }
  }

  return false;
}

function hasPrerenderCacheEntryForPathnames(
  pathnames: Array<string | null | undefined>
): boolean {
  for (const pathname of pathnames) {
    if (!pathname) {
      continue;
    }
    if (hasPrerenderCacheEntryForPathname(pathname)) {
      return true;
    }
  }
  return false;
}

function isApiRoutePathname(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function hasInvalidPathnameEncoding(pathname: string): boolean {
  const segments = pathname.split('/');
  for (const segment of segments) {
    if (!segment || !segment.includes('%')) {
      continue;
    }
    try {
      decodeURIComponent(segment);
    } catch {
      return true;
    }
  }
  return false;
}

function isNextStaticAssetPathname(pathname: string): boolean {
  return pathname.includes('/_next/static/');
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as { name?: unknown; message?: unknown };
  const name = typeof record.name === 'string' ? record.name : '';
  if (name === 'AbortError') {
    return true;
  }
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  return message.includes('abort') || message.includes('timeout');
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
const nodeHandlerCache = new Map<string, NodeRouteHandler>();
const nodeHandlerLoadPromises = new Map<string, Promise<NodeRouteHandler>>();
const nodeMiddlewareHandlerCache = new Map<string, EdgeRouteHandler>();
const nodeMiddlewareHandlerLoadPromises = new Map<string, Promise<EdgeRouteHandler>>();
const edgeHandlerCache = new Map<string, EdgeRouteHandler>();
const edgeChunkLoadPromises = new Map<string, Promise<void>>();
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
    if (ENABLE_DEBUG_TIMERS) {
      console.log('[adapter-bun][timers] skip createAtomicTimerGroup patch: disabled');
    }
    return;
  }
  if (typeof process.versions?.bun !== 'string') {
    if (ENABLE_DEBUG_TIMERS) {
      console.log('[adapter-bun][timers] skip createAtomicTimerGroup patch: not bun');
    }
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
      if (ENABLE_DEBUG_TIMERS) {
        console.log(
          '[adapter-bun][timers] skip createAtomicTimerGroup patch: missing or already patched'
        );
      }
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
    if (ENABLE_DEBUG_TIMERS) {
      console.log('[adapter-bun][timers] patched createAtomicTimerGroup export');
    }
  } catch (error) {
    if (ENABLE_DEBUG_TIMERS) {
      console.log(
        '[adapter-bun][timers] failed createAtomicTimerGroup patch',
        error instanceof Error ? error.message : String(error)
      );
    }
    // Ignore and continue with Next's default scheduling behavior.
  }
}

patchNextAtomicTimerGroupForBun();

function patchSetTimeoutForBunAtomicGroups(): void {
  if (process.env.ADAPTER_BUN_DISABLE_ATOMIC_TIMER_PATCH === '1') {
    if (ENABLE_DEBUG_TIMERS) {
      console.log('[adapter-bun][timers] skip setTimeout atomic patch: disabled');
    }
    return;
  }
  if (typeof process.versions?.bun !== 'string') {
    if (ENABLE_DEBUG_TIMERS) {
      console.log('[adapter-bun][timers] skip setTimeout atomic patch: not bun');
    }
    return;
  }

  const currentSetTimeout = globalThis.setTimeout as typeof setTimeout & {
    __adapterBunPatched?: boolean;
  };
  if (currentSetTimeout.__adapterBunPatched) {
    if (ENABLE_DEBUG_TIMERS) {
      console.log('[adapter-bun][timers] skip setTimeout atomic patch: already patched');
    }
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
  let debugLoggedAtomicIntercept = false;
  let debugLoggedShortTimeouts = 0;
  const batchAllShortTimeouts = process.env.ADAPTER_BUN_BATCH_ALL_SHORT_TIMEOUTS === '1';

  const wrappedSetTimeout = ((
    handler: ((...cbArgs: unknown[]) => void) | string,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const delayMs = typeof timeout === 'number' ? timeout : Number(timeout ?? 0);
    if (typeof handler === 'function' && Number.isFinite(delayMs) && delayMs <= 1) {
      const stack = new Error().stack ?? '';
      if (ENABLE_DEBUG_TIMERS && debugLoggedShortTimeouts < 8) {
        debugLoggedShortTimeouts += 1;
        const firstStackLine = stack.split('\n')[1]?.trim() ?? '';
        console.log(
          '[adapter-bun][timers] short setTimeout',
          'handler=',
          handler.name || '<anonymous>',
          'stack=',
          firstStackLine
        );
      }
      if (batchAllShortTimeouts || isAtomicTimerGroupHandler(handler, stack)) {
        if (ENABLE_DEBUG_TIMERS && !debugLoggedAtomicIntercept) {
          debugLoggedAtomicIntercept = true;
          console.log(
            '[adapter-bun][timers] intercepted atomic setTimeout',
            'handler=',
            handler.name || '<anonymous>'
          );
        }
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
  if (ENABLE_DEBUG_TIMERS) {
    console.log('[adapter-bun][timers] patched global setTimeout for atomic groups');
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

function getServeStaticModule(): RuntimeServeStaticModule {
  if (runtimeServeStaticModule) {
    return runtimeServeStaticModule;
  }
  runtimeServeStaticModule = require(
    'next/dist/server/serve-static.js'
  ) as RuntimeServeStaticModule;
  return runtimeServeStaticModule;
}

function isNextImagePathname(pathname: string): boolean {
  const imagePath = `${basePath || ''}/_next/image`;
  return removePathnameTrailingSlash(pathname) === removePathnameTrailingSlash(imagePath);
}

function getRuntimeImageConfig(): RuntimeNextImageConfig | null {
  return runtimeNextConfig.images && isRecord(runtimeNextConfig.images)
    ? (runtimeNextConfig.images as RuntimeNextImageConfig)
    : null;
}

function getNextImageMaximumResponseBody(imagesConfig: RuntimeNextImageConfig): number {
  return typeof imagesConfig.maximumResponseBody === 'number' &&
    Number.isFinite(imagesConfig.maximumResponseBody) &&
    imagesConfig.maximumResponseBody > 0
    ? imagesConfig.maximumResponseBody
    : 50_000_000;
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

  const imagesConfig = getRuntimeImageConfig();
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

  const parsedQuery = searchParamsToMatcherQuery(requestUrl.searchParams);
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
    const maximumResponseBody = getNextImageMaximumResponseBody(imagesConfig);
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
    const serveStatic = getServeStaticModule();
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

async function loadNodeHandler(output: RuntimeFunctionOutput): Promise<NodeRouteHandler> {
  const normalizedPath = path.resolve(output.filePath);
  const cached = nodeHandlerCache.get(normalizedPath);
  if (cached) {
    return cached;
  }

  const pending = nodeHandlerLoadPromises.get(normalizedPath);
  if (pending) {
    return pending;
  }

  const loadPromise = (async () => {
    const loaded = (await Promise.resolve(
      require(normalizedPath)
    )) as RuntimeConfigRecord;
    const handlerCandidate =
      typeof loaded.handler === 'function'
        ? loaded.handler
        : loaded.default &&
            isRecord(loaded.default) &&
            typeof loaded.default.handler === 'function'
          ? loaded.default.handler
          : null;

    if (typeof handlerCandidate !== 'function') {
      throw new Error(`[adapter-bun] route output missing handler(): ${normalizedPath}`);
    }

    const handler = handlerCandidate as NodeRouteHandler;
    nodeHandlerCache.set(normalizedPath, handler);
    return handler;
  })();

  nodeHandlerLoadPromises.set(normalizedPath, loadPromise);
  try {
    return await loadPromise;
  } finally {
    nodeHandlerLoadPromises.delete(normalizedPath);
  }
}

async function loadNodeMiddlewareHandler(
  output: RuntimeFunctionOutput
): Promise<EdgeRouteHandler> {
  const normalizedPath = path.resolve(output.filePath);
  const cached = nodeMiddlewareHandlerCache.get(normalizedPath);
  if (cached) {
    return cached;
  }

  const pending = nodeMiddlewareHandlerLoadPromises.get(normalizedPath);
  if (pending) {
    return pending;
  }

  const loadPromise = (async () => {
    const loaded = (await Promise.resolve(
      require(normalizedPath)
    )) as RuntimeConfigRecord;
    const handlerCandidate =
      typeof loaded.handler === 'function'
        ? loaded.handler
        : loaded.default &&
            isRecord(loaded.default) &&
            typeof loaded.default.handler === 'function'
          ? loaded.default.handler
          : null;

    if (typeof handlerCandidate !== 'function') {
      throw new Error(`[adapter-bun] middleware output missing handler(): ${normalizedPath}`);
    }

    const handler = handlerCandidate as EdgeRouteHandler;
    nodeMiddlewareHandlerCache.set(normalizedPath, handler);
    return handler;
  })();

  nodeMiddlewareHandlerLoadPromises.set(normalizedPath, loadPromise);
  try {
    return await loadPromise;
  } finally {
    nodeMiddlewareHandlerLoadPromises.delete(normalizedPath);
  }
}

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

async function loadEdgeHandler(output: RuntimeFunctionOutput): Promise<EdgeRouteHandler> {
  const edgeRuntime = output.edgeRuntime;
  const resolvedEntryKey = edgeRuntime?.entryKey ?? deriveEdgeEntryKey(output);
  const resolvedHandlerExport = edgeRuntime?.handlerExport ?? 'handler';

  const cacheKey = `${resolvedEntryKey}:${resolvedHandlerExport}:${output.filePath}`;
  const cached = edgeHandlerCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  applyEdgeEnv(output.env);

  const normalizedEntrypoint = path.resolve(output.filePath);
  const importOrderCandidates = [...(output.assets ?? [])];
  if (
    !importOrderCandidates.some(
      (assetFile) => path.resolve(assetFile) === normalizedEntrypoint
    )
  ) {
    // Older manifests may omit `filePath` from edge assets; ensure it still loads.
    importOrderCandidates.unshift(output.filePath);
  }

  const loadedForOutput = new Set<string>();
  for (const assetFile of importOrderCandidates) {
    if (!isImportableEdgeAsset(assetFile)) {
      continue;
    }
    const normalizedAssetPath = path.resolve(assetFile);
    if (loadedForOutput.has(normalizedAssetPath)) {
      continue;
    }
    loadedForOutput.add(normalizedAssetPath);
    await importEdgeChunk(normalizedAssetPath);
  }

  const entries = (globalThis as { _ENTRIES?: Record<string, RuntimeConfigRecord> })._ENTRIES;
  const entry = entries?.[resolvedEntryKey];
  if (!entry) {
    throw new Error(
      `[adapter-bun] edge entry not registered: ${resolvedEntryKey} (${output.pathname})`
    );
  }

  let handlerCandidate = entry[resolvedHandlerExport];
  if (
    typeof handlerCandidate !== 'function' &&
    !edgeRuntime &&
    resolvedHandlerExport === 'handler' &&
    typeof entry.default === 'function'
  ) {
    // Older edge wrappers may only expose default.
    handlerCandidate = entry.default;
  }

  if (typeof handlerCandidate !== 'function') {
    throw new Error(
      `[adapter-bun] edge handler export missing: ${resolvedEntryKey}.${resolvedHandlerExport}`
    );
  }

  const handler = handlerCandidate as EdgeRouteHandler;
  edgeHandlerCache.set(cacheKey, handler);
  return handler;
}

const edgeRuntimeProjectDir =
  typeof manifest.build?.projectDir === 'string' && manifest.build.projectDir.length > 0
    ? manifest.build.projectDir
    : process.cwd();
const edgeRuntimeDistDir =
  typeof manifest.build?.distDir === 'string' && manifest.build.distDir.length > 0
    ? path.isAbsolute(manifest.build.distDir)
      ? manifest.build.distDir
      : path.join(edgeRuntimeProjectDir, manifest.build.distDir)
    : path.join(edgeRuntimeProjectDir, '.next');
const edgeRequestNextConfig = {
  basePath: manifest.build?.basePath,
  i18n: manifest.build?.i18n ?? null,
  trailingSlash: Boolean(manifest.build?.trailingSlash),
};
const edgeClientAssetToken =
  process.env.IMMUTABLE_ASSET_TOKEN ||
  process.env.VERCEL_IMMUTABLE_ASSET_TOKEN ||
  process.env.NEXT_DEPLOYMENT_ID ||
  '';

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
  } catch (error) {
    if (ENABLE_DEBUG_ROUTING) {
      debugRoutingLog(
        'incremental-cache-handler-load-failed',
        resolvedCacheHandlerPath,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return incrementalCacheHandlerConstructor ?? undefined;
}

function createEdgeIncrementalCache(
  requestHeaders: IncomingHttpHeaders
): RuntimeIncrementalCache | undefined {
  try {
    const IncrementalCache = getIncrementalCacheConstructor();
    const cacheHandlerConstructor = getIncrementalCacheHandlerConstructor();
    const experimentalConfig = requiredServerFilesConfig.experimental ?? runtimeNextConfig.experimental;
    const cacheMaxMemorySize =
      typeof requiredServerFilesConfig.cacheMaxMemorySize === 'number'
        ? requiredServerFilesConfig.cacheMaxMemorySize
        : typeof runtimeNextConfig.cacheMaxMemorySize === 'number'
          ? runtimeNextConfig.cacheMaxMemorySize
          : undefined;
    const allowedRevalidateHeaderKeys =
      toStringArray(experimentalConfig?.allowedRevalidateHeaderKeys) ?? undefined;
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
  } catch (error) {
    if (ENABLE_DEBUG_ROUTING) {
      debugRoutingLog(
        'incremental-cache-create-failed',
        error instanceof Error ? error.message : String(error)
      );
    }
    return undefined;
  }
}

let sandboxRun:
  | ((params: any) => Promise<{ response: Response; waitUntil: Promise<unknown> }>)
  | null = null;

function getSandboxRun() {
  if (sandboxRun) {
    return sandboxRun;
  }

  const sandboxModule = require('next/dist/server/web/sandbox') as {
    run: (params: any) => Promise<{ response: Response; waitUntil: Promise<unknown> }>;
  };
  sandboxRun = sandboxModule.run;
  return sandboxRun;
}

function toEdgeFunctionName(entryKey: string): string {
  return entryKey.startsWith('middleware_')
    ? entryKey.slice('middleware_'.length)
    : entryKey;
}

function toEdgeFunctionPaths(output: RuntimeFunctionOutput): string[] {
  const normalizedEntrypoint = path.resolve(output.filePath);
  const importOrderCandidates = [...(output.assets ?? [])];
  if (
    !importOrderCandidates.some(
      (assetFile) => path.resolve(assetFile) === normalizedEntrypoint
    )
  ) {
    importOrderCandidates.unshift(output.filePath);
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  for (const assetFile of importOrderCandidates) {
    if (!isImportableEdgeAsset(assetFile)) {
      continue;
    }
    const normalizedAssetPath = path.resolve(assetFile);
    if (seen.has(normalizedAssetPath)) {
      continue;
    }
    seen.add(normalizedAssetPath);
    paths.push(normalizedAssetPath);
  }

  return paths;
}

function createCloneableBody(bytes: Uint8Array): {
  cloneBodyStream: () => Readable;
  finalize: () => Promise<void>;
} {
  const body = Buffer.from(bytes);
  return {
    cloneBodyStream() {
      return Readable.from(body.byteLength > 0 ? [body] : []);
    },
    async finalize() {},
  };
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
  const name = toEdgeFunctionName(resolvedEntryKey);
  const run = getSandboxRun();
  const hasBody = canRequestHaveBody(method) && requestBody.byteLength > 0;
  const edgeRequestUrl = new URL(requestUrl);
  if (ENABLE_DEBUG_ROUTING && requestUrl.pathname.includes('/_next/data/')) {
    debugRoutingLog(
      'edge-next-data-invoke',
      'output=',
      output.pathname,
      'requestUrl=',
      requestUrl.toString(),
      'edgeRequestUrl=',
      edgeRequestUrl.toString()
    );
  }

  const abortController = new AbortController();
  const incrementalCache = createEdgeIncrementalCache(headers);
  const runPromise = run({
    distDir: edgeRuntimeDistDir,
    name,
    paths: toEdgeFunctionPaths(output),
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
        name: output.pathname.includes('/_next/data/')
          ? output.sourcePage
          : output.pathname,
      },
      ...(hasBody ? { body: createCloneableBody(requestBody) } : {}),
      signal: abortController.signal,
      waitUntil,
      ...(requestMeta ? { requestMeta } : {}),
    },
    useCache: true,
    ...(incrementalCache ? { incrementalCache } : {}),
    clientAssetToken: edgeClientAssetToken,
  });

  if (
    typeof timeoutMs === 'number' &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
  ) {
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

function createEdgeRequest(
  requestUrl: URL,
  method: string | undefined,
  headers: Headers,
  body: Uint8Array
): Request {
  const requestInit: RequestInit & { duplex?: 'half' } = {
    method: method || 'GET',
    headers,
  };

  if (canRequestHaveBody(method) && body.byteLength > 0) {
    requestInit.body = createBodyStream(body);
    requestInit.duplex = 'half';
  }

  return new Request(requestUrl.toString(), requestInit);
}

async function invokeFunctionOutput(
  req: IncomingMessage,
  res: ServerResponse,
  output: RuntimeFunctionOutput,
  requestUrl: URL,
  requestBody: Uint8Array,
  requestMeta?: RuntimeRequestMeta
): Promise<void> {
  const isErrorDocumentOutput = /(?:^|\/)(?:_error|404|500)$/.test(output.pathname);
  if (isErrorDocumentOutput) {
    // Next's error render path can close sockets internally without an explicit
    // connection header, which leads keep-alive clients to reuse a dead socket.
    // Mark error document responses as non-keepalive to keep client pools in sync.
    res.shouldKeepAlive = false;
    if (!res.headersSent) {
      res.setHeader('connection', 'close');
    }
  }

  if (!isReadMethod(req.method)) {
    // Non-read requests (actions/revalidation/posts) have been the primary
    // source of pooled-socket resets in deploy-mode tests. Close after write
    // so subsequent client requests open a fresh socket.
    res.shouldKeepAlive = false;
    if (!res.headersSent) {
      res.setHeader('connection', 'close');
    }
  }

  if (isApiRoutePathname(output.pathname)) {
    // API handlers can end the underlying socket without an explicit close
    // signal on some runtimes. Avoid pooled socket reuse between API calls.
    res.shouldKeepAlive = false;
    if (!res.headersSent) {
      res.setHeader('connection', 'close');
    }
  }

  if (output.runtime === 'edge') {
    // Edge handlers can terminate their underlying socket immediately after
    // writing the response, even when no explicit close header is set.
    // Advertise close so keep-alive clients do not reuse stale sockets.
    res.shouldKeepAlive = false;
    if (!res.headersSent) {
      res.setHeader('connection', 'close');
    }
  }

  if (output.runtime === 'edge') {
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
        if (attempt >= maxAttempts || !isAbortLikeError(error)) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`[adapter-bun] edge function invocation failed (${output.pathname})`);
    return;
  }

  if (
    process.env.ADAPTER_BUN_DEBUG_ACTION_PAYLOAD === '1' &&
    ENABLE_DEBUG_ROUTING &&
    shouldDebugRequest(req.url) &&
    isPossibleServerActionRequest(req)
  ) {
    const actionResponseChunks: Buffer[] = [];
    const mutableRes = res as any;
    const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
    const originalEnd = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
    const pushChunk = (chunk: unknown, encoding: unknown): void => {
      if (chunk === undefined || chunk === null) {
        return;
      }
      if (Buffer.isBuffer(chunk)) {
        actionResponseChunks.push(chunk);
        return;
      }
      if (chunk instanceof Uint8Array) {
        actionResponseChunks.push(Buffer.from(chunk));
        return;
      }
      if (typeof chunk === 'string') {
        actionResponseChunks.push(Buffer.from(chunk, encoding as BufferEncoding | undefined));
      }
    };

    mutableRes.write = (...args: unknown[]) => {
      const [chunk, encoding] = args;
      pushChunk(chunk, encoding);
      return originalWrite(...args);
    };
    mutableRes.end = (...args: unknown[]) => {
      const [chunk, encoding] = args;
      pushChunk(chunk, encoding);
      const result = originalEnd(...args);
      const payload = Buffer.concat(actionResponseChunks).toString('utf8');
      debugRoutingLog(
        'action-payload',
        req.url,
        `len=${payload.length}`,
        'head=',
        payload.slice(0, 2_000),
        'tail=',
        payload.slice(-2_000)
      );
      return result;
    };
  }

  const nodeHandler = await loadNodeHandler(output);
  const waitUntil = createWaitUntilCollector();
  const isAppOutput = isAppFunctionOutput(output);
  const isAppRouteHandlerOutput = output.sourcePage.endsWith('/route');
  const isNextDataRequest =
    getSingleHeaderValue(req.headers['x-nextjs-data']) === '1' ||
    requestUrl.pathname.includes('/_next/data/');
  const shouldFallbackToErrorPage =
    isReadMethod(req.method) &&
    !isApiRoutePathname(output.pathname) &&
    output.pathname !== '/_error' &&
    !isAppOutput &&
    !isAppRouteHandlerOutput &&
    !isNextDataRequest;
  let suppressedNotFoundResponse = false;
  let restoreNotFoundFallbackPatch: (() => void) | null = null;
  const isActionRequest = isPossibleServerActionRequest(req);
  const shouldDebugRscStream =
    process.env.ADAPTER_BUN_DEBUG_RSC_STREAM === '1' &&
    ENABLE_DEBUG_ROUTING &&
    shouldDebugRequest(req.url) &&
    getSingleHeaderValue(req.headers[RSC_HEADER]) === '1';
  let restoreDebugRscStreamPatch: (() => void) | null = null;
  if (shouldDebugRscStream) {
    const mutableRes = res as any;
    const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
    const originalEnd = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
    const payloadChunks: Buffer[] = [];
    const pushChunk = (chunk: unknown, encoding: unknown): void => {
      if (chunk === undefined || chunk === null) {
        return;
      }
      if (Buffer.isBuffer(chunk)) {
        payloadChunks.push(chunk);
        return;
      }
      if (chunk instanceof Uint8Array) {
        payloadChunks.push(Buffer.from(chunk));
        return;
      }
      if (typeof chunk === 'string') {
        payloadChunks.push(Buffer.from(chunk, encoding as BufferEncoding | undefined));
      }
    };

    mutableRes.write = (...args: unknown[]) => {
      const [chunk, encoding] = args;
      pushChunk(chunk, encoding);
      return originalWrite(...args);
    };
    mutableRes.end = (...args: unknown[]) => {
      const [chunk, encoding] = args;
      pushChunk(chunk, encoding);
      const result = originalEnd(...args);
      const payload = Buffer.concat(payloadChunks).toString('utf8');
      debugRoutingLog(
        'rsc-payload',
        req.method,
        req.url,
        'len=',
        String(payload.length),
        'head=',
        payload.slice(0, 2_000),
        'tail=',
        payload.slice(-2_000)
      );
      return result;
    };
    restoreDebugRscStreamPatch = () => {
      mutableRes.write = originalWrite;
      mutableRes.end = originalEnd;
    };
  }

  if (shouldFallbackToErrorPage) {
    const mutableRes = res as any;
    const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
    const originalEnd = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
    const shouldCaptureNotFoundResponse = (): boolean =>
      res.statusCode === 404 && !res.hasHeader('content-type');
    const consumeChunk = (chunk: unknown): void => {
      if (chunk === undefined || chunk === null) {
        return;
      }
      if (Buffer.isBuffer(chunk)) {
        return;
      }
      if (chunk instanceof Uint8Array) {
        return;
      }
      if (typeof chunk === 'string') {
        return;
      }
    };

    mutableRes.write = (...args: unknown[]) => {
      if (shouldCaptureNotFoundResponse()) {
        consumeChunk(args[0]);
        return true;
      }
      return originalWrite(...args);
    };
    mutableRes.end = (...args: unknown[]) => {
      if (shouldCaptureNotFoundResponse()) {
        consumeChunk(args[0]);
        suppressedNotFoundResponse = true;
        return res;
      }
      return originalEnd(...args);
    };
    restoreNotFoundFallbackPatch = () => {
      mutableRes.write = originalWrite;
      mutableRes.end = originalEnd;
    };
  }

  // Keep action responses streaming-capable. Buffering res.write() breaks
  // streamed server action payloads (for example ReadableStream responses).

  const shouldWaitForFinish = isActionRequest;
  await nodeHandler(req, res, {
    waitUntil: waitUntil.waitUntil,
    ...(requestMeta ? { requestMeta } : {}),
  });
  if (restoreDebugRscStreamPatch) {
    restoreDebugRscStreamPatch();
  }
  if (restoreNotFoundFallbackPatch) {
    restoreNotFoundFallbackPatch();
  }
  if (suppressedNotFoundResponse) {
    const errorOutput = getFunctionOutputByPathname('/_error');
    if (errorOutput) {
      if (!res.headersSent) {
        res.statusCode = 404;
      }
      await invokeFunctionOutput(req, res, errorOutput, requestUrl, requestBody);
      void waitUntil.drain();
      return;
    }

    if (!res.headersSent) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    res.end('Not Found');
    void waitUntil.drain();
    return;
  }
  if (shouldWaitForFinish) {
    await waitForResponseFinish(res);
  }
  void waitUntil.drain();
}

async function invokeMiddleware(
  middleware: RuntimeFunctionOutput,
  requestUrl: URL,
  method: string | undefined,
  headers: Headers,
  requestBody: ReadableStream<Uint8Array>
): Promise<{
  middlewareResult: ReturnType<typeof responseToMiddlewareResult>;
  response: Response;
}> {
  const waitUntil = createWaitUntilCollector();
  let response: Response;
  if (middleware.runtime === 'edge') {
    const requestBodyBytes = canRequestHaveBody(method)
      ? await readReadableStreamBody(requestBody)
      : new Uint8Array(0);
    response = await runEdgeFunctionOutput(
      middleware,
      method,
      headersToIncomingHttpHeaders(headers),
      requestUrl,
      requestBodyBytes,
      waitUntil.waitUntil
    );
  } else {
    const handler = await loadNodeMiddlewareHandler(middleware);
    const requestInit: RequestInit & { duplex?: 'half' } = {
      method: method || 'GET',
      headers,
    };

    if (canRequestHaveBody(method)) {
      requestInit.body = requestBody;
      requestInit.duplex = 'half';
    }

    const middlewareRequest = new Request(requestUrl.toString(), requestInit);
    response = await handler(middlewareRequest, {
      waitUntil: waitUntil.waitUntil,
    });
  }
  void waitUntil.drain();

  return {
    middlewareResult: responseToMiddlewareResult(response, headers, requestUrl),
    response,
  };
}

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
  if (ENABLE_DEBUG_CONNECTIONS) {
    const socketId = getDebugSocketId(req.socket);
    debugRoutingLog(
      'socket-request',
      `#${socketId}`,
      req.method,
      req.url,
      'destroyed=',
      String(req.socket.destroyed),
      'writableEnded=',
      String(res.writableEnded)
    );
    res.once('finish', () => {
      debugRoutingLog(
        'socket-finish',
        `#${socketId}`,
        req.method,
        req.url,
        res.statusCode,
        'shouldKeepAlive=',
        String(res.shouldKeepAlive),
        'headersSent=',
        String(res.headersSent),
        'socketDestroyed=',
        String(req.socket.destroyed)
      );
    });
    res.once('close', () => {
      debugRoutingLog(
        'socket-response-close',
        `#${socketId}`,
        req.method,
        req.url,
        res.statusCode,
        'writableEnded=',
        String(res.writableEnded),
        'socketDestroyed=',
        String(req.socket.destroyed)
      );
    });
  }

  const requestUrlNoQuery = (req.url || '').split('?', 1)[0] ?? '';
  if (requestUrlNoQuery.match(/(\\|\/\/)/)) {
    const normalizedUrl = normalizeRepeatedSlashes(req.url || '/');
    res.statusCode = 308;
    res.setHeader('location', normalizedUrl);
    markConnectionClose(res);
    res.end(normalizedUrl);
    return;
  }

  const debugRequest = shouldDebugRequest(req.url);
  if (debugRequest) {
    res.once('finish', () => {
      if (isPossibleServerActionRequest(req)) {
        debugRoutingLog(
          'action-response-headers',
          req.method,
          req.url,
          JSON.stringify(res.getHeaders())
        );
      }
      debugRoutingLog(
        'response',
        req.method,
        req.url,
        res.statusCode,
        String(res.getHeader('content-type') ?? ''),
        String(res.getHeader('x-nextjs-cache') ?? ''),
        String(res.getHeader('x-nextjs-matched-path') ?? ''),
        'action-revalidated=',
        String(res.getHeader('x-action-revalidated') ?? ''),
        'stale-time=',
        String(res.getHeader('x-nextjs-stale-time') ?? ''),
        'postponed=',
        String(res.getHeader('x-nextjs-postponed') ?? ''),
        'cache-control=',
        String(res.getHeader('cache-control') ?? ''),
        'connection=',
        String(res.getHeader('connection') ?? '')
      );
    });
  }

  // Normalize Bun's incoming headers into a plain mutable object so Next can
  // safely patch/strip headers during RSC/action flows.
  (req as IncomingMessage & { headers: IncomingHttpHeaders }).headers = {
    ...req.headers,
  };
  stripInternalRequestHeaders(req.headers);
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
    res.setHeader(
      'vary',
      mergeVaryHeaderValues(res.getHeader('vary'), [
        'rsc',
        'next-router-state-tree',
        'next-router-prefetch',
        'next-router-segment-prefetch',
      ])
    );
  }
  if (debugRequest) {
    debugRoutingLog(
      'request',
      req.method,
      req.url,
      'rsc=',
      String(getSingleHeaderValue(req.headers.rsc) ?? ''),
      'accept=',
      String(getSingleHeaderValue(req.headers.accept) ?? ''),
      'prefetch=',
      String(getSingleHeaderValue(req.headers['next-router-prefetch']) ?? ''),
      'segment-prefetch=',
      String(getSingleHeaderValue(req.headers['next-router-segment-prefetch']) ?? ''),
      'state-tree=',
      String(getSingleHeaderValue(req.headers['next-router-state-tree']) ?? ''),
      'next-url=',
      String(getSingleHeaderValue(req.headers['next-url']) ?? '')
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
    ensureForwardedRequestHeaders(req, requestUrl);
    const routingBaseUrl = applyHostHeaderToUrl(requestUrl, req.headers.host);
    if (hasInvalidPathnameEncoding(requestUrl.pathname)) {
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
    const resolveRoutesUrl = new URL(routingBaseUrl);
    if (nextDataRoutePathname) {
      routingUrl.pathname = nextDataRoutePathname;
      resolveRoutesUrl.pathname = nextDataRoutePathname;
    }
    const requestHasLocalePrefix = hasLocalePrefixInPathname(
      requestUrl.pathname,
      basePath,
      runtimeI18n
    );

    if (isRscRequest) {
      const canonicalRscUrl = getCanonicalRscUrl(requestUrl, req.headers);
      if (canonicalRscUrl) {
        if (debugRequest) {
          debugRoutingLog(
            'rsc-redirect',
            req.method,
            req.url,
            'location=',
            `${canonicalRscUrl.pathname}${canonicalRscUrl.search}`
          );
        }
        res.statusCode = 307;
        res.setHeader('location', `${canonicalRscUrl.pathname}${canonicalRscUrl.search}`);
        res.setHeader('content-length', '0');
        markConnectionClose(res);
        res.end();
        return;
      }
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
    let middlewareIssuedRedirect = false;

    if (runtimeRouting) {
      let requestRoutingI18n = getRoutingI18nForRequest(
        runtimeI18n,
        routingUrl.pathname,
        basePath,
        req.headers,
        routingUrl.hostname
      );
      if (
        !requestRoutingI18n &&
        runtimeI18n &&
        isRootPathnameForLocaleDetection(routingUrl.pathname, basePath)
      ) {
        const unprefixedRootPathname = basePath || '/';
        const defaultLocaleRootPathname = `${basePath}${basePath ? '/' : '/'}${runtimeI18n.defaultLocale}`;
        if (
          !routingPathnameSet.has(unprefixedRootPathname) &&
          routingPathnameSet.has(defaultLocaleRootPathname)
        ) {
          // Some i18n builds only emit locale-prefixed root routes. Keep i18n
          // resolution enabled so "/" maps to the default-locale page.
          requestRoutingI18n = runtimeI18n;
        }
      }
      resolvedRoutingResult = normalizeResolveRoutesResultShape(
        await resolveRoutes({
          url: resolveRoutesUrl,
          buildId,
          basePath,
          requestBody: createBodyStream(requestBody),
        headers: routingHeaders,
        pathnames: routingPathnames,
        i18n: requestRoutingI18n,
        routes: runtimeRouting,
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
          if (runtimeMiddlewareMatcher) {
            const matcherHeaders = headersToIncomingHttpHeaders(headers);
            for (const [rawKey, rawValue] of Object.entries(req.headers)) {
              const normalizedKey = rawKey.toLowerCase();
              if (matcherHeaders[normalizedKey] === undefined) {
                matcherHeaders[normalizedKey] = rawValue;
              }
            }
            const matcherQuery = searchParamsToMatcherQuery(
              middlewareUrl.searchParams
            );
            const normalizedPathname = removePathnameTrailingSlash(
              middlewareUrl.pathname
            );
            let decodedPathname = normalizedPathname;
            try {
              decodedPathname = decodeURIComponent(normalizedPathname);
            } catch {
              decodedPathname = normalizedPathname;
            }

            const matcherRequest = { headers: matcherHeaders };
            const matchedByMatcher =
              runtimeMiddlewareMatcher(normalizedPathname, matcherRequest, matcherQuery) ||
              (decodedPathname !== normalizedPathname &&
                runtimeMiddlewareMatcher(decodedPathname, matcherRequest, matcherQuery));
            if (!matchedByMatcher) {
              return {};
            }
          }

          middlewareMatchedRequest = true;
          const { middlewareResult, response } = await invokeMiddleware(
            runtimeMiddleware,
            middlewareUrl,
            req.method,
            headers,
            middlewareRequestBody
          );
          middlewareIssuedRedirect =
            middlewareIssuedRedirect ||
            (isRedirectStatusCode(response.status) &&
              typeof response.headers.get('location') === 'string');
          if (middlewareResult.requestHeaders) {
            resolvedRequestHeaders = new Headers(middlewareResult.requestHeaders);
          }
          if (middlewareResult.bodySent) {
            middlewareBodyResponse = response;
          }
          return middlewareResult;
          },
        }),
        resolveRoutesUrl
      );

      if (
        runtimeI18n &&
        !requestHasLocalePrefix &&
        isRootPathnameForLocaleDetection(routingUrl.pathname, basePath)
      ) {
        const unprefixedRootPathname = basePath || '/';
        const defaultLocaleRootPathname = `${basePath}${basePath ? '/' : '/'}${runtimeI18n.defaultLocale}`;
        const resolvedRouteHeaders = resolvedRoutingResult.resolvedHeaders ?? new Headers();
        const locationHeader = resolvedRouteHeaders.get('location');
        let isDefaultLocaleRedirect = false;
        if (
          isRedirectStatusCode(resolvedRoutingResult.status) &&
          typeof locationHeader === 'string' &&
          locationHeader.length > 0
        ) {
          try {
            isDefaultLocaleRedirect =
              removePathnameTrailingSlash(
                new URL(locationHeader, requestUrl.origin).pathname
              ) === removePathnameTrailingSlash(defaultLocaleRootPathname);
          } catch {
            isDefaultLocaleRedirect = false;
          }
        }
        if (
          isDefaultLocaleRedirect &&
          !routingPathnameSet.has(unprefixedRootPathname) &&
          routingPathnameSet.has(defaultLocaleRootPathname)
        ) {
          // Avoid redirect loops when the build only emits locale-prefixed
          // root routes (for example "/en") but requests arrive on "/".
          const adjustedHeaders = new Headers(resolvedRouteHeaders);
          adjustedHeaders.delete('location');
          const fallbackInvocationQuery =
            resolvedRoutingResult.invocationTarget?.query ??
            resolvedRoutingResult.resolvedQuery ??
            {};
          resolvedRoutingResult = {
            ...resolvedRoutingResult,
            resolvedPathname: defaultLocaleRootPathname,
            invocationTarget: {
              pathname: defaultLocaleRootPathname,
              query: fallbackInvocationQuery,
            },
            status: undefined,
            resolvedHeaders: adjustedHeaders,
          };
        }
      }

      if (
        /[A-Z]/.test(routingUrl.pathname) &&
        !resolvedRoutingResult.resolvedPathname &&
        !resolvedRoutingResult.redirect &&
        !resolvedRoutingResult.externalRewrite &&
        !resolvedRoutingResult.middlewareResponded
      ) {
        const caseInsensitiveFallback = resolveCaseInsensitiveRoutingFallback(
          routingUrl,
          req.headers,
          runtimeRoutingConfig!
        );
        if (caseInsensitiveFallback) {
          resolvedRoutingResult = caseInsensitiveFallback;
        }
      }

      if (
        trailingSlash &&
        !resolvedRoutingResult.redirect &&
        !resolvedRoutingResult.externalRewrite &&
        !resolvedRoutingResult.middlewareResponded
      ) {
        const trailingSlashFallbackPathname = resolveTrailingSlashPathnameFallback(
          routingUrl.pathname,
          routingPathnameSet
        );
        if (
          trailingSlashFallbackPathname &&
          (
            !resolvedRoutingResult.resolvedPathname ||
            isDynamicRoute(
              normalizePathnameForRouteMatching(resolvedRoutingResult.resolvedPathname)
            )
          )
        ) {
          const fallbackInvocationQuery =
            resolvedRoutingResult.invocationTarget?.query ??
            resolvedRoutingResult.resolvedQuery ??
            {};
          resolvedRoutingResult = {
            ...resolvedRoutingResult,
            resolvedPathname: trailingSlashFallbackPathname,
            invocationTarget: {
              pathname: trailingSlashFallbackPathname,
              query: fallbackInvocationQuery,
            },
            routeMatches: undefined,
          };
        }
      }
    }

    if (resolvedRoutingResult.resolvedPathname) {
      const normalizedMatchedNextDataPathname = getNextDataNormalizedPathname(
        resolvedRoutingResult.resolvedPathname,
        buildId,
        basePath
      );
      if (normalizedMatchedNextDataPathname) {
        resolvedRoutingResult = {
          ...resolvedRoutingResult,
          resolvedPathname: normalizedMatchedNextDataPathname,
        };
      }
    }

    if (debugRequest) {
      debugRoutingLog(
        'resolved-routes',
        req.method,
        req.url,
        'matched=',
        resolvedRoutingResult.resolvedPathname ?? '',
        'status=',
        typeof resolvedRoutingResult.status === 'number'
          ? String(resolvedRoutingResult.status)
          : '',
        'route-matches=',
        JSON.stringify(resolvedRoutingResult.routeMatches ?? {})
      );
    }

    replaceRequestHeaders(req, resolvedRequestHeaders);
    if (debugRequest) {
      debugRoutingLog(
        'post-route-headers',
        req.method,
        req.url,
        'rsc=',
        String(getSingleHeaderValue(req.headers.rsc) ?? ''),
        'accept=',
        String(getSingleHeaderValue(req.headers.accept) ?? ''),
        'prefetch=',
        String(getSingleHeaderValue(req.headers['next-router-prefetch']) ?? ''),
        'state-tree=',
        String(getSingleHeaderValue(req.headers['next-router-state-tree']) ?? '')
      );
    }

    const routeHeaders = resolvedRoutingResult.resolvedHeaders;
    let routeStatus = resolvedRoutingResult.status;
    if (
      nextDataRoutePathname &&
      routeHeaders &&
      isRedirectStatusCode(routeStatus)
    ) {
      const routeLocationHeader = routeHeaders.get('location');
      if (routeLocationHeader) {
        try {
          const locationUrl = new URL(
            routeLocationHeader,
            requestUrl.origin
          );
          if (
            removePathnameTrailingSlash(locationUrl.pathname) ===
            removePathnameTrailingSlash(nextDataRoutePathname)
          ) {
            routeHeaders.delete('location');
            routeStatus = undefined;
          }
        } catch {
          // Keep the original redirect when location is not a valid URL.
        }
      }
    }

    if (middlewareMatchedRequest) {
      // Middleware responses commonly terminate sockets after write without an
      // explicit keep-alive contract. Close per-request to avoid pooled socket
      // reuse races in deploy-mode clients.
      res.shouldKeepAlive = false;
      if (!res.headersSent) {
        res.setHeader('connection', 'close');
      }
    }

    if (debugRequest) {
      debugRoutingLog(
        'route-headers',
        req.method,
        req.url,
        debugHeadersToJson(routeHeaders)
      );
    }

    if (resolvedRoutingResult.redirect) {
      const redirectLocation = maybeStripDefaultLocaleFromLocation(
        resolvedRoutingResult.redirect.url.toString(),
        basePath,
        runtimeI18n,
        requestHasLocalePrefix,
        requestUrl.origin
      );
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
      isRedirectStatusCode(routeStatus) &&
      typeof routeLocationHeader === 'string' &&
      routeLocationHeader.length > 0
    ) {
      let redirectLocation = routeLocationHeader;
      if (
        requestUrl.search.length > 0 &&
        !routeLocationHeader.includes('?') &&
        !routeLocationHeader.includes('#')
      ) {
        try {
          const redirectUrl = new URL(
            routeLocationHeader,
            requestUrl.origin
          );
          const requestPathname = removePathnameTrailingSlash(requestUrl.pathname);
          const redirectPathname = removePathnameTrailingSlash(redirectUrl.pathname);
          const shouldPropagateSearch =
            !middlewareIssuedRedirect || requestPathname === redirectPathname;
          if (shouldPropagateSearch) {
            redirectUrl.search = requestUrl.search;
          }
          const shouldPreserveOrigin = redirectUrl.origin !== requestUrl.origin;
          redirectLocation = shouldPreserveOrigin
            ? redirectUrl.toString()
            : `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`;
        } catch {
          redirectLocation = routeLocationHeader;
        }
      }
      redirectLocation = maybeStripDefaultLocaleFromLocation(
        redirectLocation,
        basePath,
        runtimeI18n,
        requestHasLocalePrefix,
        requestUrl.origin
      );
      if (routeHeaders) {
        applyResponseHeaders(res, routeHeaders);
      }
      if (redirectLocation !== routeLocationHeader) {
        res.setHeader('location', redirectLocation);
      }
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
      if (isApiPathname(routingUrl.pathname, basePath, runtimeI18n)) {
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
    if (resolvedRoutingQuery) {
      resolvedUrl.search = toSearchStringFromResolveRoutesQuery(resolvedRoutingQuery);
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
      if (!resolvedRoutingQuery) {
        resolvedUrl.search = middlewareRewriteUrl.search;
      }
    }

    const runtimeRewritePathnameForParams =
      runtimeRoutingConfig && hasUnresolvedRouteMatchPlaceholder(routeMatches)
        ? resolveRuntimeRewritePathname(routingUrl, req.headers, runtimeRoutingConfig)
        : undefined;
    const rscSuffix = routeMatches?.rscSuffix;
    const invocationPathname =
      resolvedRoutingResult.invocationTarget?.pathname ??
      middlewareRewriteUrl?.pathname ??
      sourcePathname;
    const invocationUrl = new URL(requestUrl);
    invocationUrl.pathname = invocationPathname;
    invocationUrl.search = resolvedUrl.search;
    const paramsExtractionPathname = selectPathnameForParamExtraction([
      middlewareRewriteUrl?.pathname,
      resolvedRoutingResult.invocationTarget?.pathname,
      sourcePathname,
      requestUrl.pathname,
      resolvedUrl.pathname,
      invocationPathname,
      runtimeRewritePathnameForParams,
    ]);
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
        const invocationPathDynamicParams = getDynamicParamsForOutputRequestPathname(
          invocationPathOutput,
          outputRequestPathname,
          typeof rscSuffix === 'string' ? rscSuffix : undefined
        );
        resolvedFunctionOutput = invocationPathDynamicParams
          ? {
              output: preferRscFunctionOutput(invocationPathOutput, preferRscOutput),
              params: invocationPathDynamicParams,
            }
          : {
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
    if (runtimeI18n && !requestHasLocalePrefix) {
      const matchedHasLocalePrefix = hasLocalePrefixInPathname(
        matchedPathname,
        basePath,
        runtimeI18n
      );
      if (matchedHasLocalePrefix) {
        const invocationResolvedFunctionOutput = resolveFunctionOutput(
          invocationPathname,
          outputRequestPathname,
          typeof rscSuffix === 'string' ? rscSuffix : undefined,
          explicitRscPath
        );
        const shouldPreferInvocationResolvedOutput =
          Boolean(invocationResolvedFunctionOutput) &&
          (!resolvedFunctionOutput ||
            (isAppFunctionOutput(invocationResolvedFunctionOutput?.output) &&
              !isAppFunctionOutput(resolvedFunctionOutput.output)));
        if (shouldPreferInvocationResolvedOutput) {
          resolvedFunctionOutput = invocationResolvedFunctionOutput;
          if (resolvedFunctionOutput) {
            matchedPathname = resolvedFunctionOutput.output.pathname;
          }
        }
      }
    }
    if (debugRequest) {
      debugRoutingLog(
        'resolved-output',
        req.method,
        req.url,
        'matched=',
        matchedPathname,
        'pathname=',
        resolvedUrl.pathname,
        'rscSuffix=',
        typeof rscSuffix === 'string' ? rscSuffix : '',
        'isRsc=',
        String(isRscRequest),
        'output=',
        resolvedFunctionOutput?.output.pathname ?? '',
        'runtime=',
        resolvedFunctionOutput?.output.runtime ?? ''
      );
    }

    const requestMeta = toRequestMeta({
      requestUrl,
      revalidate: internalRevalidate,
    });
    if (debugRequest) {
      debugRoutingLog(
        'request-meta',
        req.method,
        req.url,
        'initURL=',
        String(requestMeta.initURL ?? ''),
        'initProtocol=',
        String(requestMeta.initProtocol ?? ''),
        'hostname=',
        String(requestMeta.hostname ?? '')
      );
    }
    if (process.env.ADAPTER_BUN_USE_ORIGINAL_REQ_URL === '1') {
      req.url = `${requestUrl.pathname}${requestUrl.search}`;
    } else {
      req.url = `${invocationUrl.pathname}${invocationUrl.search}`;
    }

    if (resolvedFunctionOutput) {
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
      const hasPrerenderCacheForResolvedOutput = hasPrerenderCacheEntryForPathnames([
        nextDataRoutePathname ?? invocationPathname,
        resolvedUrl.pathname,
        matchedPathname,
        resolvedFunctionOutput.output.pathname,
      ]);
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
        process.env.ADAPTER_BUN_USE_ORIGINAL_REQ_URL === '1'
          ? requestUrl
          : invocationUrl,
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

if (ENABLE_DEBUG_CONNECTIONS) {
  server.on('connection', (socket) => {
    const socketId = getDebugSocketId(socket);
    debugRoutingLog(
      'socket-open',
      `#${socketId}`,
      `${socket.remoteAddress ?? ''}:${socket.remotePort ?? ''}`
    );
    socket.on('end', () => {
      debugRoutingLog('socket-end', `#${socketId}`);
    });
    socket.on('close', (hadError) => {
      debugRoutingLog('socket-close', `#${socketId}`, 'hadError=', String(hadError));
    });
    socket.on('error', (error) => {
      debugRoutingLog(
        'socket-error',
        `#${socketId}`,
        error?.name ?? 'Error',
        error?.message ?? String(error)
      );
    });
  });
}

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

if (isWildcardHostname(listenHostname)) {
  // Let Node choose an unspecified address so IPv6/IPv4 dual-stack works when available.
  server.listen(port, handleListening);
} else {
  server.listen(port, listenHostname, handleListening);
}
