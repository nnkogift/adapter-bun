import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
// Must run before loading @next/routing/route handlers so AsyncLocalStorage
// and other Next.js node polyfills are available in Bun runtime.
import 'next/dist/build/adapter/setup-node-env.external.js';
import {
  resolveRoutes,
  responseToMiddlewareResult,
  type Route,
  type RouteHas,
  type ResolveRoutesResult,
} from '@next/routing';
import {
  ACTION_HEADER,
  NEXT_RSC_UNION_QUERY,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL,
  RSC_HEADER,
} from 'next/dist/client/components/app-router-headers.js';
import { normalizeNextQueryParam } from 'next/dist/server/web/utils.js';
import { setCacheBustingSearchParamWithHash } from 'next/dist/client/components/router-reducer/set-cache-busting-search-param.js';
import { computeCacheBustingSearchParam } from 'next/dist/shared/lib/router/utils/cache-busting-search-param.js';
import { isDynamicRoute } from 'next/dist/shared/lib/router/utils/is-dynamic.js';
import { getRouteMatcher } from 'next/dist/shared/lib/router/utils/route-matcher.js';
import { getNamedRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex.js';
import { getSortedRoutes } from 'next/dist/shared/lib/router/utils/sorted-routes.js';
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
type RuntimeRequestMetaQuery = Record<string, RuntimeRequestMetaValue>;
type RuntimeRequestMetaParams = Record<string, RuntimeRequestMetaValue>;
type RuntimeRevalidateHeaders = Record<string, string | string[]>;
type RuntimeInternalRevalidate = (config: {
  urlPath: string;
  headers: RuntimeRevalidateHeaders;
  opts: { unstable_onlyGenerated?: boolean };
}) => Promise<void>;
type RuntimeDynamicRouteMatcherResult = Record<string, string | string[] | undefined>;
type RuntimeDynamicRouteMatcher = (
  pathname: string
) => RuntimeDynamicRouteMatcherResult | false;

interface RuntimeRequestMeta {
  invokePath?: string;
  invokeOutput?: string;
  invokeQuery?: RuntimeRequestMetaQuery;
  invokeStatus?: number;
  middlewareInvoke?: boolean;
  query?: RuntimeRequestMetaQuery;
  params?: RuntimeRequestMetaParams;
  rewrittenPathname?: string;
  isRSCRequest?: true;
  isPrefetchRSCRequest?: true;
  segmentPrefetchRSCRequest?: string;
  cacheBustingSearchParam?: string;
  isNextDataReq?: true;
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

interface RuntimeEdgeOutput {
  modulePath: string;
  entryKey: string;
  handlerExport: string;
}

interface RuntimeFunctionOutput {
  id: string;
  pathname: string;
  sourcePage: string;
  runtime: RuntimeFunctionRuntime;
  filePath: string;
  edgeRuntime?: RuntimeEdgeOutput;
  assets?: string[];
  env?: Record<string, string>;
}

interface ResolvedFunctionOutput {
  output: RuntimeFunctionOutput;
  params?: RuntimeRequestMetaParams;
}

interface RuntimeSection {
  cache?: RuntimeCacheConfig | null;
  routing?: RuntimeRoutingConfig | null;
  middleware?: RuntimeFunctionOutput | null;
  functions?: RuntimeFunctionOutput[];
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

function isRedirectStatusCode(value: number | undefined): boolean {
  return typeof value === 'number' && value >= 300 && value < 400;
}

function isExternalDestinationUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function replaceRouteDestinationCaptures(
  destination: string,
  regexMatch: RegExpMatchArray,
  routeMatches?: Record<string, string>
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

  if (routeMatches) {
    for (const [key, value] of Object.entries(routeMatches)) {
      nextDestination = nextDestination.replace(new RegExp(`\\$${key}`, 'g'), value);
    }
  }

  return nextDestination;
}

function pathnameEqualsWithRootAlias(leftPathname: string, rightPathname: string): boolean {
  if (leftPathname === rightPathname) {
    return true;
  }
  return (
    getRootIndexAlias(leftPathname) === rightPathname ||
    getRootIndexAlias(rightPathname) === leftPathname
  );
}

function pathnameMatchesRoutePathname(
  candidatePathname: string,
  routePathname: string
): boolean {
  if (pathnameEqualsWithRootAlias(candidatePathname, routePathname)) {
    return true;
  }

  if (!isDynamicRoute(routePathname)) {
    return false;
  }

  const matcher = getRouteMatcher(
    getNamedRouteRegex(routePathname, {
      prefixRouteKeys: false,
      includeSuffix: true,
    })
  );
  return Boolean(matcher(candidatePathname));
}

function applyDestinationQueryFromRoutingRules(
  requestPathname: string,
  matchedPathname: string,
  query: URLSearchParams,
  routingConfig: RuntimeRoutingConfig | null,
  routeMatches?: Record<string, string>
): URLSearchParams {
  const nextQuery = new URLSearchParams(query);
  if (!routingConfig) {
    return nextQuery;
  }

  const routeGroups: RuntimeRoute[][] = [
    routingConfig.beforeMiddleware,
    routingConfig.beforeFiles,
    routingConfig.afterFiles,
    routingConfig.fallback,
  ];

  let currentPathname = requestPathname;
  for (const routes of routeGroups) {
    for (const route of routes) {
      if (!route.destination) {
        continue;
      }
      if (isRedirectStatusCode(route.status)) {
        continue;
      }

      const sourceRegex = new RegExp(route.sourceRegex);
      const regexMatch = currentPathname.match(sourceRegex);
      if (!regexMatch) {
        continue;
      }

      const destination = replaceRouteDestinationCaptures(
        route.destination,
        regexMatch,
        routeMatches
      );
      if (isExternalDestinationUrl(destination)) {
        continue;
      }

      const destinationUrl = new URL(destination, 'http://n');
      currentPathname = destinationUrl.pathname;
      if (
        !destination.includes('?') ||
        !pathnameMatchesRoutePathname(destinationUrl.pathname, matchedPathname) ||
        destinationUrl.searchParams.size === 0
      ) {
        continue;
      }

      const destinationQueryKeys = new Set(destinationUrl.searchParams.keys());
      for (const destinationQueryKey of destinationQueryKeys) {
        nextQuery.delete(destinationQueryKey);
      }
      for (const [destinationQueryKey, destinationQueryValue] of destinationUrl.searchParams.entries()) {
        nextQuery.append(destinationQueryKey, destinationQueryValue);
      }
      return nextQuery;
    }
  }

  return nextQuery;
}

function extractRewriteSourceParamsFromRoutingRules(
  requestPathname: string,
  matchedPathname: string,
  routingConfig: RuntimeRoutingConfig | null,
  routeMatches?: Record<string, string>
): Record<string, string> {
  if (!routingConfig) {
    return {};
  }

  const routeGroups: RuntimeRoute[][] = [
    routingConfig.beforeMiddleware,
    routingConfig.beforeFiles,
    routingConfig.afterFiles,
    routingConfig.fallback,
  ];
  const matchedRouteParams = toRequestMetaParamsFromRouteMatches(routeMatches) ?? {};
  const matchedRouteMatcher = isDynamicRoute(matchedPathname)
    ? getRouteMatcher(
        getNamedRouteRegex(matchedPathname, {
          prefixRouteKeys: false,
          includeSuffix: true,
        })
      )
    : null;

  const areParamsCompatible = (
    destinationParams: RuntimeRequestMetaParams | undefined
  ): boolean => {
    if (!destinationParams) {
      return true;
    }

    for (const [key, value] of Object.entries(destinationParams)) {
      const matchedValue = matchedRouteParams[key];
      if (matchedValue === undefined) {
        continue;
      }
      if (Array.isArray(value) && Array.isArray(matchedValue)) {
        if (value.length !== matchedValue.length) {
          return false;
        }
        for (let index = 0; index < value.length; index += 1) {
          if (value[index] !== matchedValue[index]) {
            return false;
          }
        }
        continue;
      }
      if (value !== matchedValue) {
        return false;
      }
    }

    return true;
  };

  let firstDynamicParams: Record<string, string> | null = null;
  let currentPathname = requestPathname;

  for (const routes of routeGroups) {
    for (const route of routes) {
      if (!route.destination) {
        continue;
      }
      if (isRedirectStatusCode(route.status)) {
        continue;
      }

      const sourceRegex = new RegExp(route.sourceRegex);
      const regexMatch = currentPathname.match(sourceRegex);
      if (!regexMatch) {
        continue;
      }

      const destination = replaceRouteDestinationCaptures(
        route.destination,
        regexMatch,
        routeMatches
      );
      if (isExternalDestinationUrl(destination)) {
        continue;
      }

      const destinationUrl = new URL(destination, 'http://n');
      currentPathname = destinationUrl.pathname;
      if (!pathnameMatchesRoutePathname(destinationUrl.pathname, matchedPathname)) {
        continue;
      }
      if (matchedRouteMatcher) {
        const destinationParams = toRequestMetaParamsFromMatcher(
          matchedRouteMatcher(destinationUrl.pathname) as RuntimeDynamicRouteMatcherResult | false
        );
        if (!areParamsCompatible(destinationParams)) {
          continue;
        }
      }

      const sourceParams: Record<string, string> = {};
      const groups = (
        regexMatch as RegExpMatchArray & { groups?: Record<string, string | undefined> }
      ).groups;
      if (groups) {
        for (const [key, value] of Object.entries(groups)) {
          if (typeof value !== 'string' || value.length === 0) {
            continue;
          }
          sourceParams[key] = value;
        }
      }

      if (Object.keys(sourceParams).length === 0) {
        // If any matching rewrite has no source captures, treat it as an
        // exact/static match and ignore capture params from broader patterns.
        return {};
      }

      if (!firstDynamicParams) {
        firstDynamicParams = sourceParams;
      }
    }
  }

  return firstDynamicParams ?? {};
}

function getNextDataNormalizedPathname(
  requestPathname: string,
  buildId: string,
  basePath: string
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
  // Preserve encoded slashes (%2F) for dynamic segment matching, but decode
  // encoded square brackets so static paths like /dynamic/[first] match.
  normalizedPath = normalizedPath
    .replace(/%5B/gi, '[')
    .replace(/%5D/gi, ']');
  return `${basePath}${basePath ? '/' : '/'}${normalizedPath}`;
}

const ENABLE_DEBUG_ROUTING = process.env.ADAPTER_BUN_DEBUG_ROUTING === '1';

function shouldDebugRequest(url: string | undefined): boolean {
  if (!ENABLE_DEBUG_ROUTING || !url) {
    return false;
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

function canRequestHaveBody(method: string | undefined): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

function installReplayStream(req: IncomingMessage, body: Uint8Array): void {
  const replayStream = Readable.from(body);
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

function isNumericRouteMatchKey(key: string): boolean {
  return /^[0-9]+$/.test(key);
}

function normalizeRouteMatchKey(key: string): string | null {
  if (isNumericRouteMatchKey(key) || key === 'rscSuffix') {
    return null;
  }
  return normalizeNextQueryParam(key) ?? key;
}

function getDynamicRouteParamKeys(pathname: string): Set<string> {
  const keys = new Set<string>();
  const segments = pathname.split('/');
  for (const segment of segments) {
    let key: string | null = null;
    if (segment.startsWith('[[...') && segment.endsWith(']]')) {
      key = segment.slice('[[...'.length, -']]'.length);
    } else if (segment.startsWith('[...') && segment.endsWith(']')) {
      key = segment.slice('[...'.length, -']'.length);
    } else if (segment.startsWith('[') && segment.endsWith(']')) {
      key = segment.slice('['.length, -']'.length);
    }
    if (!key) {
      continue;
    }
    const normalizedKey = normalizeNextQueryParam(key) ?? key;
    keys.add(normalizedKey);
  }
  return keys;
}

function filterRouteParamsForDynamicPathname(
  params: RuntimeRequestMetaParams,
  pathname: string
): RuntimeRequestMetaParams | undefined {
  if (!isDynamicRoute(pathname)) {
    return params;
  }

  const allowedKeys = getDynamicRouteParamKeys(pathname);
  const filtered: RuntimeRequestMetaParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (allowedKeys.has(key)) {
      filtered[key] = value;
    }
  }

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function toRequestQuery(
  searchParams: URLSearchParams
): RuntimeRequestMetaQuery {
  const query: RuntimeRequestMetaQuery = {};
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

function mergeRouteMatchesIntoQuery(
  query: RuntimeRequestMetaQuery,
  routeMatches: Record<string, string> | undefined
): RuntimeRequestMetaQuery {
  if (!routeMatches) {
    return query;
  }

  for (const [key, value] of Object.entries(routeMatches)) {
    const normalizedKey = normalizeRouteMatchKey(key);
    if (!normalizedKey || typeof value !== 'string') {
      continue;
    }

    const existing = query[normalizedKey];
    if (existing === undefined) {
      query[normalizedKey] = value;
      continue;
    }
    if (Array.isArray(existing)) {
      if (!existing.includes(value)) {
        existing.push(value);
      }
      continue;
    }
    if (existing !== value) {
      query[normalizedKey] = [existing, value];
    }
  }

  return query;
}

function toRequestMeta({
  matchedPathname,
  requestPathname,
  invokeOutput,
  routeStatus,
  query,
  params,
  revalidate,
}: {
  matchedPathname: string;
  requestPathname: string;
  invokeOutput: string;
  routeStatus?: number;
  query: RuntimeRequestMetaQuery;
  params?: RuntimeRequestMetaParams;
  revalidate?: RuntimeInternalRevalidate;
}): RuntimeRequestMeta {
  const meta: RuntimeRequestMeta = {
    // invokePath must be the concrete request pathname (not the route
    // definition pathname with dynamic placeholders) so Next's matcher can
    // recover params during render.
    invokePath: requestPathname,
    invokeOutput,
    invokeQuery: query,
    middlewareInvoke: false,
    query,
    ...(revalidate ? { revalidate } : {}),
  };

  if (typeof routeStatus === 'number') {
    meta.invokeStatus = routeStatus;
  }

  if (requestPathname !== matchedPathname) {
    meta.rewrittenPathname = matchedPathname;
  }

  if (params && Object.keys(params).length > 0) {
    meta.params = params;
  }

  return meta;
}

function applyRscRequestMeta(
  meta: RuntimeRequestMeta,
  headers: IncomingHttpHeaders,
  requestUrl: URL
): RuntimeRequestMeta {
  const rscHeaderValue = getSingleHeaderValue(headers[RSC_HEADER]);
  if (rscHeaderValue === '1') {
    meta.isRSCRequest = true;
  }

  const routerPrefetchHeader = normalizeRouterPrefetchHeader(
    getSingleHeaderValue(headers[NEXT_ROUTER_PREFETCH_HEADER])
  );
  if (routerPrefetchHeader !== undefined) {
    meta.isPrefetchRSCRequest = true;
  }

  const segmentPrefetchHeader = getSingleHeaderValue(
    headers[NEXT_ROUTER_SEGMENT_PREFETCH_HEADER]
  );
  if (typeof segmentPrefetchHeader === 'string' && segmentPrefetchHeader.length > 0) {
    meta.segmentPrefetchRSCRequest = segmentPrefetchHeader;
  } else if (meta.isPrefetchRSCRequest) {
    // Some runtime prefetches strip this header in transit; Next's client
    // still treats these as index-segment prefetches.
    meta.segmentPrefetchRSCRequest = '/_index';
  }

  const cacheBustingSearchParam = requestUrl.searchParams.get(NEXT_RSC_UNION_QUERY);
  if (typeof cacheBustingSearchParam === 'string' && cacheBustingSearchParam.length > 0) {
    meta.cacheBustingSearchParam = cacheBustingSearchParam;
  }

  return meta;
}

const adapterDir = import.meta.dirname;
const manifestPath = path.join(adapterDir, 'deployment-manifest.json');
const manifest = (await Bun.file(manifestPath).json()) as DeploymentManifest;
const buildId = typeof manifest.build?.buildId === 'string' ? manifest.build.buildId : '';
const basePath = typeof manifest.build?.basePath === 'string' ? manifest.build.basePath : '';

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

const configuredHostname = process.env.NEXT_HOSTNAME || '';
const appHostname =
  configuredHostname &&
  !isWildcardHostname(configuredHostname)
    ? configuredHostname
    : !isWildcardHostname(listenHostname)
      ? listenHostname
      : 'localhost';
const protocol = process.env.__NEXT_EXPERIMENTAL_HTTPS === '1' ? 'https' : 'http';

// Next's forwarded action/redirect fetches rely on this internal origin.
process.env.__NEXT_PRIVATE_ORIGIN = `${protocol}://${appHostname}:${port}`;
if (buildId) {
  process.env.__NEXT_BUILD_ID = buildId;
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

  const targetUrl = new URL(urlPath, process.env.__NEXT_PRIVATE_ORIGIN);
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
  process.env.BUN_ADAPTER_CACHE_HTTP_URL =
    process.env.__NEXT_PRIVATE_ORIGIN + cacheRuntime.endpointPath;
}

const runtimeRoutingConfig = manifest.runtime?.routing ?? null;
const runtimeRouting = runtimeRoutingConfig ? toRoutingRoutes(runtimeRoutingConfig) : null;
const runtimeI18n = toRoutingI18n(runtimeRoutingConfig?.i18n);
const runtimeMiddleware = manifest.runtime?.middleware ?? null;
const runtimeFunctionOutputs = manifest.runtime?.functions ?? [];

const functionOutputByPathname = new Map<string, RuntimeFunctionOutput>();
for (const output of runtimeFunctionOutputs) {
  functionOutputByPathname.set(output.pathname, output);
}

const dynamicFunctionOutputPathnames = getSortedRoutes(
  runtimeFunctionOutputs
    .map((output) => output.pathname)
    .filter((pathname) => isDynamicRoute(pathname))
);

const dynamicFunctionMatchers = new Map<string, RuntimeDynamicRouteMatcher>();
for (const pathname of dynamicFunctionOutputPathnames) {
  const routeRegex = getNamedRouteRegex(pathname, {
    prefixRouteKeys: false,
    includeSuffix: true,
  });
  dynamicFunctionMatchers.set(
    pathname,
    getRouteMatcher(routeRegex) as RuntimeDynamicRouteMatcher
  );
}

function toRequestMetaParamsFromMatcher(
  matched: RuntimeDynamicRouteMatcherResult | false
): RuntimeRequestMetaParams | undefined {
  if (!matched) {
    return undefined;
  }

  const params: RuntimeRequestMetaParams = {};
  for (const [key, value] of Object.entries(matched)) {
    if (value === undefined) {
      continue;
    }
    params[key] = value;
  }

  return Object.keys(params).length > 0 ? params : undefined;
}

function toRequestMetaParamsFromRouteMatches(
  routeMatches: Record<string, string> | undefined
): RuntimeRequestMetaParams | undefined {
  if (!routeMatches) {
    return undefined;
  }

  const params: RuntimeRequestMetaParams = {};
  for (const [key, value] of Object.entries(routeMatches)) {
    const normalizedKey = normalizeRouteMatchKey(key);
    if (!normalizedKey) {
      continue;
    }
    params[normalizedKey] = value;
  }

  return Object.keys(params).length > 0 ? params : undefined;
}

function withOptionalSuffix(pathname: string, suffix?: string): string {
  if (!suffix || pathname.endsWith(suffix)) {
    return pathname;
  }
  return `${pathname}${suffix}`;
}

function getRootIndexAlias(pathname: string): string | null {
  if (pathname === '/') {
    return '/index';
  }

  if (pathname.startsWith('/.') && pathname.length > 2) {
    return `/index${pathname.slice(1)}`;
  }

  return null;
}

function addManifestPathnameCandidates(candidates: Set<string>, pathname: string): void {
  candidates.add(pathname);

  const rootIndexAlias = getRootIndexAlias(pathname);
  if (rootIndexAlias) {
    candidates.add(rootIndexAlias);
  }
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

function preferRscFunctionOutput(
  output: RuntimeFunctionOutput,
  preferRscOutput: boolean
): RuntimeFunctionOutput {
  if (!preferRscOutput || output.pathname.endsWith('.rsc')) {
    return output;
  }
  const rscVariant = functionOutputByPathname.get(`${output.pathname}.rsc`);
  return rscVariant ?? output;
}

function resolveFunctionOutput(
  matchedPathname: string,
  requestPathname: string,
  rscSuffix?: string,
  preferRscOutput: boolean = false,
  routeMatches?: Record<string, string>
): ResolvedFunctionOutput | null {
  const preferredMatchedPathname = withOptionalSuffix(matchedPathname, rscSuffix);
  const exactOutput =
    getFunctionOutputByPathname(preferredMatchedPathname) ??
    getFunctionOutputByPathname(matchedPathname);
  if (exactOutput) {
    const exactMatcher = dynamicFunctionMatchers.get(exactOutput.pathname);
    if (!exactMatcher) {
      return { output: preferRscFunctionOutput(exactOutput, preferRscOutput) };
    }

    const preferredRequestPathname = withOptionalSuffix(requestPathname, rscSuffix);
    const exactParams =
      toRequestMetaParamsFromMatcher(exactMatcher(preferredRequestPathname)) ??
      toRequestMetaParamsFromMatcher(exactMatcher(requestPathname));
    if (exactParams) {
      return { output: preferRscFunctionOutput(exactOutput, preferRscOutput), params: exactParams };
    }

    const routeMatchedParams = toRequestMetaParamsFromRouteMatches(routeMatches);
    const filteredRouteMatchedParams = routeMatchedParams
      ? filterRouteParamsForDynamicPathname(routeMatchedParams, exactOutput.pathname)
      : undefined;
    if (filteredRouteMatchedParams) {
      return {
        output: preferRscFunctionOutput(exactOutput, preferRscOutput),
        params: filteredRouteMatchedParams,
      };
    }

    return { output: preferRscFunctionOutput(exactOutput, preferRscOutput) };
  }

  const candidatePathnames = new Set<string>();
  addManifestPathnameCandidates(candidatePathnames, preferredMatchedPathname);
  addManifestPathnameCandidates(candidatePathnames, matchedPathname);
  addManifestPathnameCandidates(
    candidatePathnames,
    withOptionalSuffix(requestPathname, rscSuffix)
  );
  addManifestPathnameCandidates(candidatePathnames, requestPathname);

  for (const candidatePathname of candidatePathnames) {
    for (const dynamicPathname of dynamicFunctionOutputPathnames) {
      const matcher = dynamicFunctionMatchers.get(dynamicPathname);
      if (!matcher) {
        continue;
      }

      const matchedParams = matcher(candidatePathname);
      if (!matchedParams) {
        continue;
      }

      const output = functionOutputByPathname.get(dynamicPathname);
      if (!output) {
        continue;
      }

      const params = toRequestMetaParamsFromMatcher(matchedParams);
      const resolvedOutput = preferRscFunctionOutput(output, preferRscOutput);
      return params ? { output: resolvedOutput, params } : { output: resolvedOutput };
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
const edgeHandlerCache = new Map<string, EdgeRouteHandler>();
const edgeChunkLoadPromises = new Map<string, Promise<void>>();

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
  applyEdgeEnv(output.env);

  const resolvedEntryKey = output.edgeRuntime?.entryKey ?? deriveEdgeEntryKey(output);
  const name = toEdgeFunctionName(resolvedEntryKey);
  const run = getSandboxRun();
  const hasBody = canRequestHaveBody(method) && requestBody.byteLength > 0;

  const abortController = new AbortController();
  const runPromise = run({
    distDir: edgeRuntimeDistDir,
    name,
    paths: toEdgeFunctionPaths(output),
    edgeFunctionEntry: {
      env: output.env ?? {},
      wasm: [],
    },
    request: {
      headers,
      method: method || 'GET',
      nextConfig: edgeRequestNextConfig,
      url: requestUrl.toString(),
      page: {
        name: output.pathname,
        ...(requestMeta?.params ? { params: requestMeta.params } : {}),
      },
      ...(hasBody ? { body: createCloneableBody(requestBody) } : {}),
      signal: abortController.signal,
      waitUntil,
      ...(requestMeta ? { requestMeta } : {}),
    },
    useCache: true,
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

  const nodeHandler = await loadNodeHandler(output);
  const waitUntil = createWaitUntilCollector();
  await nodeHandler(req, res, {
    waitUntil: waitUntil.waitUntil,
    ...(requestMeta ? { requestMeta } : {}),
  });
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
  if (middleware.runtime !== 'edge') {
    throw new Error(
      `[adapter-bun] nodejs middleware runtime is not supported in standalone mode (${middleware.pathname})`
    );
  }

  const handler = await loadEdgeHandler(middleware);
  const waitUntil = createWaitUntilCollector();
  const requestInit: RequestInit & { duplex?: 'half' } = {
    method: method || 'GET',
    headers,
  };

  if (canRequestHaveBody(method)) {
    requestInit.body = requestBody;
    requestInit.duplex = 'half';
  }

  const middlewareRequest = new Request(requestUrl.toString(), requestInit);
  const response = await handler(middlewareRequest, {
    waitUntil: waitUntil.waitUntil,
  });
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
  const debugRequest = shouldDebugRequest(req.url);
  if (debugRequest) {
    res.once('finish', () => {
      debugRoutingLog(
        'response',
        req.method,
        req.url,
        res.statusCode,
        String(res.getHeader('content-type') ?? ''),
        String(res.getHeader('x-nextjs-cache') ?? ''),
        String(res.getHeader('x-nextjs-matched-path') ?? '')
      );
    });
  }

  // Normalize Bun's incoming headers into a plain mutable object so Next can
  // safely patch/strip headers during RSC/action flows.
  (req as IncomingMessage & { headers: IncomingHttpHeaders }).headers = {
    ...req.headers,
  };

  if (cacheRuntime.handlerMode === 'http') {
    const requestUrl = new URL(req.url || '/', process.env.__NEXT_PRIVATE_ORIGIN);
    if (requestUrl.pathname === cacheRuntime.endpointPath) {
      await handleCacheHttpRequest(req, res, getSharedPrerenderCacheStore(), {
        authToken: process.env.BUN_ADAPTER_CACHE_HTTP_TOKEN,
      });
      return;
    }
  }

  patchCacheControlHeader(req, res);

  req.headers.connection = 'close';
  res.setHeader('connection', 'close');

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
  if (isRscRequest) {
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
    const requestUrl = new URL(req.url || '/', process.env.__NEXT_PRIVATE_ORIGIN);
    const nextDataNormalizedPathname = getNextDataNormalizedPathname(
      requestUrl.pathname,
      buildId,
      basePath
    );
    if (
      nextDataNormalizedPathname &&
      getSingleHeaderValue(req.headers['x-nextjs-data']) !== '1'
    ) {
      req.headers['x-nextjs-data'] = '1';
    }

    const routingUrl = new URL(requestUrl);
    if (nextDataNormalizedPathname) {
      routingUrl.pathname = nextDataNormalizedPathname;
    }

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
        res.end();
        return;
      }
    }

    const requestBody = await getBufferedRequestBody(req);

    let resolvedRoutingResult: ResolveRoutesResult = {
      matchedPathname: routingUrl.pathname,
      resolvedHeaders: new Headers(),
    };
    const routingHeaders = toRequestHeaders(req.headers);
    let resolvedRequestHeaders = new Headers(routingHeaders);
    if (nextDataNormalizedPathname && !routingHeaders.has('x-nextjs-data')) {
      routingHeaders.set('x-nextjs-data', '1');
      resolvedRequestHeaders.set('x-nextjs-data', '1');
    }
    let middlewareBodyResponse: Response | null = null;

    if (runtimeRouting) {
      resolvedRoutingResult = await resolveRoutes({
        url: routingUrl,
        buildId,
        basePath,
        requestBody: createBodyStream(requestBody),
        headers: routingHeaders,
        pathnames: manifest.pathnames,
        i18n: runtimeI18n,
        routes: runtimeRouting,
        invokeMiddleware: async ({ url, headers, requestBody: middlewareRequestBody }) => {
          if (!runtimeMiddleware) {
            return {};
          }

          const { middlewareResult, response } = await invokeMiddleware(
            runtimeMiddleware,
            url,
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
      });
    }

    if (debugRequest) {
      debugRoutingLog(
        'resolved-routes',
        req.method,
        req.url,
        'matched=',
        resolvedRoutingResult.matchedPathname ?? '',
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
    const routeStatus = resolvedRoutingResult.status;
    if (debugRequest) {
      debugRoutingLog(
        'route-headers',
        req.method,
        req.url,
        debugHeadersToJson(routeHeaders)
      );
    }

    if (resolvedRoutingResult.redirect) {
      if (routeHeaders) {
        applyResponseHeaders(res, routeHeaders);
      }
      res.statusCode = resolvedRoutingResult.redirect.status;
      res.setHeader('location', resolvedRoutingResult.redirect.url.toString());
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
      if (routeHeaders) {
        applyResponseHeaders(res, routeHeaders);
      }
      const redirectStatus = routeStatus as number;
      res.statusCode = redirectStatus;
      if (redirectStatus === 308) {
        res.setHeader('refresh', `0;url=${routeLocationHeader}`);
      }
      res.end(routeLocationHeader);
      return;
    }

    const matchedPathname = resolvedRoutingResult.matchedPathname;
    if (!matchedPathname) {
      if (routeHeaders) {
        applyResponseHeaders(res, routeHeaders);
      }

      const requestStaticAsset = resolveStaticAssetFromCandidates([
        requestUrl.pathname,
        routingUrl.pathname,
      ]);
      if (requestStaticAsset) {
        if (!isReadMethod(req.method)) {
          writeMethodNotAllowedResponse(res);
          return;
        }
      }
      if (requestStaticAsset && (await serveStaticAsset(req, res, adapterDir, requestStaticAsset))) {
        return;
      }

      res.statusCode = 404;

      const notFoundAsset = staticAssetByPathname.get('/404');
      if (notFoundAsset && (await serveStaticAsset(req, res, adapterDir, notFoundAsset))) {
        return;
      }

      const errorOutput = functionOutputByPathname.get('/_error');
      if (errorOutput) {
        const errorUrl = new URL(requestUrl);
        errorUrl.pathname = '/_error';
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

    const middlewareRewriteHeader = routeHeaders?.get('x-middleware-rewrite');
    let middlewareRewriteUrl: URL | null = null;
    if (middlewareRewriteHeader) {
      middlewareRewriteUrl = new URL(
        middlewareRewriteHeader,
        process.env.__NEXT_PRIVATE_ORIGIN
      );
      resolvedUrl.pathname = middlewareRewriteUrl.pathname;
      resolvedUrl.search = middlewareRewriteUrl.search;
    }

    const routeMatches = resolvedRoutingResult.routeMatches;
    const rewrittenQuery = applyDestinationQueryFromRoutingRules(
      routingUrl.pathname,
      matchedPathname,
      resolvedUrl.searchParams,
      runtimeRoutingConfig,
      routeMatches
    );
    resolvedUrl.search = rewrittenQuery.size > 0 ? `?${rewrittenQuery.toString()}` : '';

    const rscSuffix = routeMatches?.rscSuffix;
    const invocationPathname = middlewareRewriteUrl?.pathname ?? routingUrl.pathname;
    const resolvedFunctionOutput = resolveFunctionOutput(
      matchedPathname,
      invocationPathname,
      typeof rscSuffix === 'string' ? rscSuffix : undefined,
      isRscRequest,
      routeMatches
    );
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
    const rewriteSourceParams = extractRewriteSourceParamsFromRoutingRules(
      routingUrl.pathname,
      matchedPathname,
      runtimeRoutingConfig,
      routeMatches
    );
    const requestQuery = mergeRouteMatchesIntoQuery(
      toRequestQuery(resolvedUrl.searchParams),
      rewriteSourceParams
    );
    const requestMeta = applyRscRequestMeta(
      toRequestMeta({
        matchedPathname,
        requestPathname: nextDataNormalizedPathname ?? invocationPathname,
        invokeOutput: resolvedFunctionOutput?.output.pathname ?? matchedPathname,
        routeStatus,
        query: requestQuery,
        params: resolvedFunctionOutput?.params,
        revalidate: internalRevalidate,
      }),
      req.headers,
      resolvedUrl
    );
    if (debugRequest) {
      debugRoutingLog(
        'request-meta',
        req.method,
        req.url,
        'query=',
        JSON.stringify(requestMeta.query ?? {}),
        'params=',
        JSON.stringify(requestMeta.params ?? {})
      );
    }
    if (nextDataNormalizedPathname) {
      requestMeta.isNextDataReq = true;
      req.url = `${requestUrl.pathname}${requestUrl.search}`;
    } else {
      req.url = `${resolvedUrl.pathname}${resolvedUrl.search}`;
    }

    if (resolvedFunctionOutput) {
      if (
        !isReadMethod(req.method) &&
        !isPossibleServerActionRequest(req) &&
        !isApiRoutePathname(resolvedFunctionOutput.output.pathname) &&
        hasPrerenderCacheEntryForPathnames([
          nextDataNormalizedPathname ?? invocationPathname,
          resolvedUrl.pathname,
          matchedPathname,
        ])
      ) {
        writeMethodNotAllowedResponse(res);
        return;
      }

      await invokeFunctionOutput(
        req,
        res,
        resolvedFunctionOutput.output,
        resolvedUrl,
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
      const requestUrl = new URL(req.url || '/', process.env.__NEXT_PRIVATE_ORIGIN);
      const isNextDataRequest =
        getSingleHeaderValue(req.headers['x-nextjs-data']) === '1' ||
        requestUrl.pathname.includes('/_next/data/');
      const canRenderErrorPage =
        isReadMethod(req.method) &&
        !isNextDataRequest &&
        requestUrl.pathname !== '/500' &&
        requestUrl.pathname !== '/_error';

      if (canRenderErrorPage) {
        const errorOutput =
          functionOutputByPathname.get('/500') ??
          functionOutputByPathname.get('/_error');
        if (errorOutput) {
          try {
            let errorRequestBody: Uint8Array;
            try {
              errorRequestBody = await getBufferedRequestBody(req);
            } catch {
              errorRequestBody = new Uint8Array(0);
            }
            const errorUrl = new URL(
              errorOutput.pathname === '/500' ? '/500' : '/_error',
              process.env.__NEXT_PRIVATE_ORIGIN
            );
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

if (isWildcardHostname(listenHostname)) {
  // Let Node choose an unspecified address so IPv6/IPv4 dual-stack works when available.
  server.listen(port, handleListening);
} else {
  server.listen(port, listenHostname, handleListening);
}
