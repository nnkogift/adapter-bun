import type { MiddlewareResult } from '@next/routing';
import { resolveRoutes } from './next-routing.ts';
import type {
  BunDeploymentManifest,
  BunFunctionArtifact,
  BunPrerenderSeed,
  BunStaticAsset,
} from '../types.ts';
import {
  createImageCacheKey,
  defaultShouldCacheImageResponse,
  evaluateImageCacheEntry,
  imageCacheEntryToResponse,
  isImageOptimizationPath,
  responseToImageCacheEntry,
  shouldBypassImageCache,
  toImageRoutePath,
} from './image.ts';
import {
  NEXT_CACHE_TAGS_HEADER,
  applyPrerenderResumeHeaders,
  createPrerenderCacheKey,
  evaluatePrerenderTagManifestState,
  evaluatePrerenderCacheEntry,
  isPrerenderResumeRequest,
  filterPrerenderRequestByAllowLists,
  parseCacheTagsHeader,
  prerenderCacheEntryToResponse,
  responseToPrerenderCacheEntry,
  resolvePrerenderResumePath,
  shouldBypassPrerenderCache,
  toImplicitPathTags,
  type PrerenderCacheState,
  type PrerenderRevalidateReason,
  type PrerenderRevalidateTask,
  type PrerenderRevalidateTarget,
} from './isr.ts';
import type {
  RouterRouteKind,
  RouterRuntime,
  RouterRuntimeOptions,
  RouteResolutionResult,
  RouterMiddlewareResult,
} from './types.ts';

const IMPLICIT_IMMUTABLE_CACHE_CONTROL = 'public,max-age=31536000,immutable';
const DOCUMENT_RESPONSE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const DEFAULT_RSC_VARY_HEADER =
  'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch';
const INTERNAL_MIDDLEWARE_REQUEST_HEADERS = new Set([
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-hmr-refresh',
  'next-router-segment-prefetch',
]);
const STATIC_FILE_EXTENSION_PATTERN =
  /\.(?:avif|bmp|css|gif|ico|jpe?g|js|json|map|mjs|png|svg|txt|webmanifest|webp|woff2?|xml)$/i;

function normalizeCacheControlValue(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function normalizeContentType(value: string | null): string {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function withDefaultRscVaryHeader(existingValue: string | null): string {
  const requiredValues = DEFAULT_RSC_VARY_HEADER
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!existingValue || existingValue.length === 0) {
    return requiredValues.join(', ');
  }

  const existingValues = existingValue
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const existingLowercase = new Set(existingValues.map((item) => item.toLowerCase()));

  const mergedValues = [...existingValues];
  for (const required of requiredValues) {
    const normalizedRequired = required.toLowerCase();
    if (existingLowercase.has(normalizedRequired)) {
      continue;
    }
    mergedValues.push(required);
    existingLowercase.add(normalizedRequired);
  }

  return mergedValues.join(', ');
}

function isRscPathname(value: string): boolean {
  return value.endsWith('.rsc') || value.endsWith('.segment.rsc');
}

function isNextDataPathname(value: string): boolean {
  return value.startsWith('/_next/data/') && value.endsWith('.json');
}

function maybeResolveNextDataFallbackPathname({
  requestPathname,
  basePath,
  buildId,
  indexes,
}: {
  requestPathname: string;
  basePath: string;
  buildId: string;
  indexes: ReturnType<typeof buildRouteIndexes>;
}): string | null {
  const pathnameWithoutBasePath =
    basePath && requestPathname.startsWith(`${basePath}/`)
      ? requestPathname.slice(basePath.length)
      : requestPathname;
  const prefix = `/_next/data/${buildId}/`;
  if (
    !pathnameWithoutBasePath.startsWith(prefix) ||
    !pathnameWithoutBasePath.endsWith('.json')
  ) {
    return null;
  }

  const encodedPath = pathnameWithoutBasePath
    .slice(prefix.length, -'.json'.length)
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '');
  const normalizedPath = encodedPath.length > 0 ? `/${encodedPath}` : '/';
  const candidatePathnames = new Set<string>([normalizedPath]);

  if (normalizedPath !== '/' && normalizedPath.endsWith('/index')) {
    const withoutIndex = normalizedPath.slice(0, -'/index'.length);
    candidatePathnames.add(withoutIndex.length > 0 ? withoutIndex : '/');
  }
  if (normalizedPath === '/') {
    candidatePathnames.add('/index');
  }

  for (const candidatePathname of candidatePathnames) {
    if (
      indexes.staticByPathname.has(candidatePathname) ||
      indexes.prerenderByPathname.has(candidatePathname) ||
      indexes.functionByPathname.has(candidatePathname)
    ) {
      return candidatePathname;
    }
  }

  return null;
}

function maybeResolveDirectPathnameFallback({
  requestPathname,
  indexes,
}: {
  requestPathname: string;
  indexes: ReturnType<typeof buildRouteIndexes>;
}): string | null {
  const candidatePathnames = new Set<string>([requestPathname]);
  if (requestPathname === '/') {
    candidatePathnames.add('/index');
  }

  for (const candidatePathname of candidatePathnames) {
    if (
      indexes.staticByPathname.has(candidatePathname) ||
      indexes.prerenderByPathname.has(candidatePathname) ||
      indexes.functionByPathname.has(candidatePathname)
    ) {
      return candidatePathname;
    }
  }

  return null;
}

function shouldForceDocumentResponseCacheControl({
  response,
  route,
}: {
  response: Response;
  route: {
    kind: RouterRouteKind;
    id?: string;
  };
}): boolean {
  if (route.kind === 'prerender') {
    return true;
  }

  if (route.kind === 'not-found') {
    return true;
  }

  if (route.kind === 'function') {
    return true;
  }

  if (typeof route.id === 'string' && route.id.length > 0) {
    if (isRscPathname(route.id) || isNextDataPathname(route.id)) {
      return true;
    }
  }

  const contentType = normalizeContentType(response.headers.get('content-type'));
  return contentType === 'text/html' || contentType === 'text/x-component';
}

function createEmptyBodyStream(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function withMiddlewareRequestMutations({
  request,
  rewriteUrl,
  requestHeaders,
}: {
  request: Request;
  rewriteUrl: URL | null;
  requestHeaders: Headers | null;
}): Request {
  if (!rewriteUrl && !requestHeaders) {
    return request;
  }

  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : request.clone().body;

  return new Request((rewriteUrl ?? new URL(request.url)).toString(), {
    method: request.method,
    headers: requestHeaders ?? request.headers,
    body,
  });
}

function resolveNextDataRewriteHeader({
  request,
  rewriteUrl,
  basePath,
  buildId,
}: {
  request: Request;
  rewriteUrl: URL | null;
  basePath: string;
  buildId: string;
}): string | null {
  if (!rewriteUrl || request.headers.get('x-nextjs-data') !== '1') {
    return null;
  }

  const requestUrl = new URL(request.url);
  const requestPathnameWithoutBasePath =
    basePath && requestUrl.pathname.startsWith(`${basePath}/`)
      ? requestUrl.pathname.slice(basePath.length)
      : requestUrl.pathname;
  const nextDataPrefix = `/_next/data/${buildId}/`;
  if (
    !requestPathnameWithoutBasePath.startsWith(nextDataPrefix) ||
    !requestPathnameWithoutBasePath.endsWith('.json')
  ) {
    return null;
  }

  if (rewriteUrl.origin !== requestUrl.origin) {
    return null;
  }

  let rewritePathname = rewriteUrl.pathname;
  if (basePath && rewritePathname.startsWith(`${basePath}/`)) {
    rewritePathname = rewritePathname.slice(basePath.length);
  }

  if (rewritePathname.startsWith(`/_next/data/${buildId}/`)) {
    return `${rewritePathname}${rewriteUrl.search}`;
  }

  if (!rewritePathname.startsWith('/')) {
    rewritePathname = `/${rewritePathname}`;
  }

  const normalizedPathname = rewritePathname === '/' ? '/index' : rewritePathname;
  const rewrittenNextDataPathname = `${nextDataPrefix}${normalizedPathname.slice(1)}.json`;
  const nextDataPathnameWithBasePath = basePath
    ? `${basePath}${rewrittenNextDataPathname}`
    : rewrittenNextDataPathname;
  return `${nextDataPathnameWithBasePath}${rewriteUrl.search}`;
}

function withResolvedHeader(
  resolution: RouteResolutionResult,
  key: string,
  value: string
): RouteResolutionResult {
  const headers = new Headers(resolution.resolvedHeaders);
  headers.set(key, value);
  return {
    ...resolution,
    resolvedHeaders: headers,
  };
}

function shouldAttemptAppNotFoundFunction({
  requestPathname,
  basePath,
}: {
  requestPathname: string;
  basePath: string;
}): boolean {
  const pathnameWithoutBasePath =
    basePath && requestPathname.startsWith(`${basePath}/`)
      ? requestPathname.slice(basePath.length)
      : requestPathname;

  if (
    pathnameWithoutBasePath.startsWith('/_next/') ||
    pathnameWithoutBasePath.startsWith('/api/')
  ) {
    return false;
  }

  const lastSegment = pathnameWithoutBasePath.split('/').pop() ?? '';
  return !STATIC_FILE_EXTENSION_PATTERN.test(lastSegment);
}

function stripMiddlewareResponse(
  result: RouterMiddlewareResult | {}
): MiddlewareResult {
  if (!('response' in result)) {
    return result;
  }

  const { response: _response, ...middlewareResult } = result;
  return middlewareResult;
}

function stripRequestHeaderEchoes({
  resolution,
  requestHeaders,
}: {
  resolution: RouteResolutionResult;
  requestHeaders: Headers;
}): RouteResolutionResult {
  if (!resolution.resolvedHeaders) {
    return resolution;
  }

  const filtered = new Headers();
  for (const [key, value] of resolution.resolvedHeaders.entries()) {
    const requestValue = requestHeaders.get(key);
    if (requestValue !== null && requestValue === value) {
      continue;
    }
    filtered.set(key, value);
  }

  return {
    ...resolution,
    resolvedHeaders: filtered,
  };
}

function stripInternalResponseHeaders(response: Response): Response {
  if (
    !response.headers.has(NEXT_CACHE_TAGS_HEADER)
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(NEXT_CACHE_TAGS_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function applyResolutionToResponse(
  response: Response,
  resolution: RouteResolutionResult,
  explicitStatus?: number
): Response {
  const headers = new Headers(response.headers);
  const hasExplicitCacheControl = headers.has('cache-control');
  if (resolution.resolvedHeaders) {
    for (const [key, value] of resolution.resolvedHeaders.entries()) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'x-middleware-set-cookie') {
        headers.append('set-cookie', value);
        continue;
      }
      if (normalizedKey === 'cache-control' && hasExplicitCacheControl) {
        continue;
      }
      if (
        normalizedKey === 'cache-control' &&
        !hasExplicitCacheControl &&
        normalizeCacheControlValue(value) === IMPLICIT_IMMUTABLE_CACHE_CONTROL
      ) {
        continue;
      }
      headers.set(key, value);
    }
  }

  const contentType = normalizeContentType(headers.get('content-type'));
  if (contentType === 'text/html' || contentType === 'text/x-component') {
    headers.set('vary', withDefaultRscVaryHeader(headers.get('vary')));
  }

  return new Response(response.body, {
    status: explicitStatus ?? resolution.status ?? response.status,
    statusText: response.statusText,
    headers,
  });
}

function withHeader(response: Response, key: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withCacheState(
  response: Response,
  cacheState: PrerenderCacheState
): Response {
  return withHeader(response, 'x-bun-cache', cacheState);
}

function withRouteMetadata(
  response: Response,
  route: {
    kind: RouterRouteKind;
    id?: string;
  }
): Response {
  response = stripInternalResponseHeaders(response);
  const headers = new Headers(response.headers);
  headers.set('x-bun-route-kind', route.kind);
  if (route.id) {
    headers.set('x-bun-route-id', route.id);
  } else {
    headers.delete('x-bun-route-id');
  }

  if (
    shouldForceDocumentResponseCacheControl({ response, route }) &&
    headers.get('cache-control') !== DOCUMENT_RESPONSE_CACHE_CONTROL
  ) {
    headers.set('cache-control', DOCUMENT_RESPONSE_CACHE_CONTROL);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function notFoundResponse(status = 404): Response {
  return new Response('This page could not be found', {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function toResolutionRoutes(manifest: BunDeploymentManifest) {
  return {
    beforeMiddleware: manifest.routeGraph.beforeMiddleware,
    beforeFiles: manifest.routeGraph.beforeFiles,
    afterFiles: manifest.routeGraph.afterFiles,
    dynamicRoutes: manifest.routeGraph.dynamicRoutes,
    onMatch: manifest.routeGraph.onMatch,
    fallback: manifest.routeGraph.fallback,
    shouldNormalizeNextData: manifest.routeGraph.shouldNormalizeNextData,
    rsc: manifest.routeGraph.rsc,
  };
}

function normalizeRscBasePathname(pathname: string): string {
  if (pathname === '/') {
    return '/index';
  }
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function maybeResolveRscMatchedPathname({
  request,
  matchedPathname,
  manifest,
  indexes,
}: {
  request: Request;
  matchedPathname: string;
  manifest: BunDeploymentManifest;
  indexes: ReturnType<typeof buildRouteIndexes>;
}): string {
  const rsc = manifest.routeGraph.rsc;
  const isRscRequest = request.headers.get(rsc.header) === '1';
  if (!isRscRequest) {
    return matchedPathname;
  }

  const hasOutputPathname = (pathname: string): boolean =>
    indexes.staticByPathname.has(pathname) ||
    indexes.prerenderByPathname.has(pathname) ||
    indexes.functionByPathname.has(pathname);

  const basePathname = normalizeRscBasePathname(matchedPathname);
  const segmentPrefetchPath = request.headers.get(rsc.prefetchSegmentHeader);
  if (segmentPrefetchPath && segmentPrefetchPath.length > 0) {
    const normalizedSegmentPath = segmentPrefetchPath.replace(/^\/+/, '');
    const segmentCandidatePathname = `${basePathname}${rsc.prefetchSegmentDirSuffix}/${normalizedSegmentPath}${rsc.prefetchSegmentSuffix}`;
    if (hasOutputPathname(segmentCandidatePathname)) {
      return segmentCandidatePathname;
    }
  }

  if (hasOutputPathname(matchedPathname)) {
    return matchedPathname;
  }
  if (basePathname !== matchedPathname && hasOutputPathname(basePathname)) {
    return basePathname;
  }

  const rscCandidatePathname = `${basePathname}${rsc.suffix}`;
  if (
    hasOutputPathname(rscCandidatePathname) &&
    indexes.functionByPathname.get(rscCandidatePathname)?.runtime !== 'edge'
  ) {
    return rscCandidatePathname;
  }

  return matchedPathname;
}

function toResolutionI18nConfig(manifest: BunDeploymentManifest) {
  const i18n = manifest.build.i18n;
  if (!i18n) return undefined;

  return {
    defaultLocale: i18n.defaultLocale,
    locales: [...i18n.locales],
    localeDetection: i18n.localeDetection,
    domains: i18n.domains?.map((domain) => ({
      defaultLocale: domain.defaultLocale,
      domain: domain.domain,
      http: domain.http,
      locales: domain.locales ? [...domain.locales] : undefined,
    })),
  };
}

function normalizePathname(value: string): string {
  if (!value.startsWith('/')) {
    return `/${value}`;
  }
  return value;
}

function toRevalidateEndpointPath(
  basePath: string,
  endpointPath: string | undefined
): string {
  const normalizedEndpoint = normalizePathname(endpointPath ?? '/_next/revalidate');
  if (!basePath) {
    return normalizedEndpoint;
  }
  const normalizedBasePath = basePath.endsWith('/')
    ? basePath.slice(0, -1)
    : basePath;
  return `${normalizedBasePath}${normalizedEndpoint}`;
}

const PRERENDER_REVALIDATE_HEADER = 'x-prerender-revalidate';
const PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER =
  'x-prerender-revalidate-if-generated';
const NEXT_CACHE_REVALIDATED_TAGS_HEADER = 'x-next-revalidated-tags';
const NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER = 'x-next-revalidate-tag-token';

const PRERENDER_CONTROL_HEADERS = [
  PRERENDER_REVALIDATE_HEADER,
  PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER,
  NEXT_CACHE_REVALIDATED_TAGS_HEADER,
  NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER,
];

function toPrerenderCacheKeyRequest(request: Request): Request {
  let needsStrip = false;
  for (const header of PRERENDER_CONTROL_HEADERS) {
    if (request.headers.has(header)) {
      needsStrip = true;
      break;
    }
  }
  if (!needsStrip) {
    return request;
  }
  const headers = new Headers(request.headers);
  for (const header of PRERENDER_CONTROL_HEADERS) {
    headers.delete(header);
  }
  return new Request(request.url, { method: request.method, headers });
}

function readSeedBypassToken(seed: BunPrerenderSeed): string | null {
  const config = seed.config as Record<string, unknown>;
  if (
    typeof config.bypassToken === 'string' &&
    config.bypassToken.length > 0
  ) {
    return config.bypassToken;
  }
  return null;
}

function collectBypassTokens(manifest: BunDeploymentManifest): Set<string> {
  const tokens = new Set<string>();
  for (const seed of manifest.prerenderSeeds) {
    const token = readSeedBypassToken(seed);
    if (token) {
      tokens.add(token);
    }
  }
  return tokens;
}

type OnDemandRevalidateRequest =
  | { kind: 'none' }
  | { kind: 'valid'; onlyGenerated: boolean };

function parseOnDemandRevalidateRequest({
  request,
  revalidateAuthToken,
  bypassTokens,
}: {
  request: Request;
  revalidateAuthToken: string | undefined;
  bypassTokens: Set<string>;
}): OnDemandRevalidateRequest {
  const token = request.headers.get(PRERENDER_REVALIDATE_HEADER);
  if (!token) {
    return { kind: 'none' };
  }

  const valid =
    (revalidateAuthToken && token === revalidateAuthToken) ||
    bypassTokens.has(token);
  if (!valid) {
    return { kind: 'none' };
  }

  return {
    kind: 'valid',
    onlyGenerated: request.headers.has(PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER),
  };
}

function parsePreviouslyRevalidatedTags({
  request,
  bypassTokens,
}: {
  request: Request;
  bypassTokens: Set<string>;
}): string[] {
  const token = request.headers.get(NEXT_CACHE_REVALIDATE_TAG_TOKEN_HEADER);
  if (!token || !bypassTokens.has(token)) {
    return [];
  }

  return parseCacheTagsHeader(
    request.headers.get(NEXT_CACHE_REVALIDATED_TAGS_HEADER)
  );
}

function parseRevalidateRequestBody(payload: unknown): {
  paths: string[];
  tags: string[];
  token: string | null;
  pathType: 'layout' | 'page' | null;
  tagMode: 'stale' | 'expire';
  tagProfile: string | null;
  tagExpireSeconds: number | undefined;
} | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const body = payload as Record<string, unknown>;
  const paths = new Set<string>();
  const tags = new Set<string>();

  const singlePath = body.path;
  if (typeof singlePath === 'string' && singlePath.length > 0) {
    paths.add(normalizePathname(singlePath));
  }
  const multiPath = body.paths;
  if (Array.isArray(multiPath)) {
    for (const item of multiPath) {
      if (typeof item === 'string' && item.length > 0) {
        paths.add(normalizePathname(item));
      }
    }
  }

  const singleTag = body.tag;
  if (typeof singleTag === 'string' && singleTag.length > 0) {
    tags.add(singleTag);
  }
  const multiTags = body.tags;
  if (Array.isArray(multiTags)) {
    for (const item of multiTags) {
      if (typeof item === 'string' && item.length > 0) {
        tags.add(item);
      }
    }
  }

  if (paths.size === 0 && tags.size === 0) {
    return null;
  }

  const typeValue = body.type;
  const pathType =
    typeValue === 'layout' || typeValue === 'page' ? typeValue : null;

  const profileValue = body.profile;
  const expireValue = body.expire;
  let tagMode: 'stale' | 'expire' = 'expire';
  let tagExpireSeconds: number | undefined;

  if (
    (typeof profileValue === 'string' && profileValue.length > 0) ||
    (profileValue && typeof profileValue === 'object')
  ) {
    tagMode = 'stale';
  }

  if (
    profileValue &&
    typeof profileValue === 'object' &&
    'expire' in profileValue &&
    typeof (profileValue as { expire?: unknown }).expire === 'number'
  ) {
    tagExpireSeconds = Number((profileValue as { expire: number }).expire);
  } else if (typeof expireValue === 'number') {
    tagExpireSeconds = Number(expireValue);
  }

  const tagProfile =
    typeof profileValue === 'string' && profileValue.length > 0
      ? profileValue
      : null;

  return {
    paths: [...paths],
    tags: [...tags],
    token: typeof body.token === 'string' && body.token.length > 0 ? body.token : null,
    pathType,
    tagMode,
    tagProfile,
    tagExpireSeconds,
  };
}

function resolveProfileExpireSeconds(profile: string | null): number | undefined {
  if (!profile) {
    return undefined;
  }
  switch (profile) {
    case 'max':
      return 31536000;
    default:
      return 3600;
  }
}

function collectSeedTags(seed: BunPrerenderSeed): string[] {
  const tags = new Set<string>(seed.tags);
  const headerValue = seed.fallback?.initialHeaders?.[NEXT_CACHE_TAGS_HEADER];

  if (typeof headerValue === 'string') {
    for (const tag of parseCacheTagsHeader(headerValue)) {
      tags.add(tag);
    }
  } else if (Array.isArray(headerValue)) {
    for (const value of headerValue) {
      if (typeof value !== 'string') {
        continue;
      }
      for (const tag of parseCacheTagsHeader(value)) {
        tags.add(tag);
      }
    }
  }

  return [...tags];
}

function createManualRevalidateTasksFromManifest({
  manifest,
  request,
  pathnames,
  tags,
  pathTags,
}: {
  manifest: BunDeploymentManifest;
  request: Request;
  pathnames: string[];
  tags: string[];
  pathTags: string[];
}): {
  tasks: PrerenderRevalidateTask[];
  directMatchedPathnames: string[];
  expandedGroupPathnames: string[];
} {
  const pathSet = new Set(pathnames);
  const tagSet = new Set(tags);
  const pathTagSet = new Set(pathTags);
  const selected = new Map<string, PrerenderRevalidateReason>();

  for (const seed of manifest.prerenderSeeds) {
    if (pathSet.has(seed.pathname)) {
      selected.set(seed.pathname, 'MANUAL_PATH');
      continue;
    }
    if (tagSet.size > 0) {
      const seedTags = collectSeedTags(seed);
      for (const seedTag of seedTags) {
        if (!tagSet.has(seedTag)) {
          continue;
        }
        selected.set(
          seed.pathname,
          pathTagSet.has(seedTag) ? 'MANUAL_PATH' : 'MANUAL_TAG'
        );
        break;
      }
    }
  }

  const directMatchedPathnames = [...selected.keys()];
  const selectedGroupIds = new Set<number>();
  for (const seed of manifest.prerenderSeeds) {
    if (selected.has(seed.pathname)) {
      selectedGroupIds.add(seed.groupId);
    }
  }

  const expandedGroupPathnames: string[] = [];
  const defaultReason: PrerenderRevalidateReason =
    pathSet.size > 0 ? 'MANUAL_PATH' : 'MANUAL_TAG';
  for (const seed of manifest.prerenderSeeds) {
    if (selected.has(seed.pathname)) {
      continue;
    }
    if (selectedGroupIds.has(seed.groupId)) {
      selected.set(seed.pathname, defaultReason);
      expandedGroupPathnames.push(seed.pathname);
    }
  }

  const tasks: PrerenderRevalidateTask[] = [];
  for (const seed of manifest.prerenderSeeds) {
    const reason = selected.get(seed.pathname);
    if (!reason) {
      continue;
    }
    const seedRequest = new Request(new URL(seed.pathname, request.url).toString(), {
      method: 'GET',
    });
    const cacheKey = createPrerenderCacheKey(seed, seedRequest);
    tasks.push({
      cacheKey: cacheKey.key,
      pathname: seed.pathname,
      groupId: seed.groupId,
      reason,
    });
  }

  return {
    tasks,
    directMatchedPathnames,
    expandedGroupPathnames,
  };
}

function createManualRevalidateTasksFromTargets({
  targets,
  pathnames,
}: {
  targets: PrerenderRevalidateTarget[];
  pathnames: string[];
}): {
  tasks: PrerenderRevalidateTask[];
  directMatchedPathnames: string[];
} {
  const pathSet = new Set(pathnames);
  const defaultReason: PrerenderRevalidateReason =
    pathSet.size > 0 ? 'MANUAL_PATH' : 'MANUAL_TAG';
  const tasks = targets.map((target) => ({
    cacheKey: target.cacheKey,
    pathname: target.pathname,
    groupId: target.groupId,
    reason: pathSet.has(target.pathname) ? ('MANUAL_PATH' as const) : defaultReason,
  }));

  return {
    tasks,
    directMatchedPathnames: [...new Set(targets.map((target) => target.pathname))],
  };
}

async function maybeHandleManualRevalidateRequest({
  options,
  request,
}: {
  options: RouterRuntimeOptions;
  request: Request;
}): Promise<Response | null> {
  const requestUrl = new URL(request.url);
  const endpointPath = toRevalidateEndpointPath(
    options.manifest.build.basePath,
    options.revalidateEndpointPath
  );
  if (requestUrl.pathname !== endpointPath) {
    return null;
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        allow: 'POST',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  if (!options.revalidateAuthToken) {
    return new Response(
      'Revalidation endpoint is disabled because no auth token is configured.',
      {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }
    );
  }

  if (!options.prerenderCache?.store) {
    return new Response(
      'Prerender cache store is not configured for this runtime.',
      {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }
    );
  }

  const parsedBody = await request
    .clone()
    .json()
    .catch(() => null);
  const payload = parseRevalidateRequestBody(parsedBody);
  if (!payload) {
    return new Response(
      'Invalid revalidate payload. Expected { path|paths|tag|tags }.',
      {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }
    );
  }

  const authToken =
    request.headers.get('x-bun-revalidate-token') ??
    requestUrl.searchParams.get('token') ??
    payload.token;
  if (authToken !== options.revalidateAuthToken) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const pathTags = payload.paths.flatMap((pathname) =>
    toImplicitPathTags(pathname, payload.pathType ?? undefined)
  );
  const allTags = [...new Set([...payload.tags, ...pathTags])];
  const now = options.prerenderCache.now?.() ?? Date.now();
  const tagManifestSupported = Boolean(options.prerenderCache.store.updateTagManifest);
  const resolvedTagExpireSeconds =
    payload.tagExpireSeconds ?? resolveProfileExpireSeconds(payload.tagProfile);

  if (options.prerenderCache.store.updateTagManifest) {
    if (pathTags.length > 0) {
      await options.prerenderCache.store.updateTagManifest(pathTags, {
        mode: 'expire',
        now,
      });
    }

    if (payload.tags.length > 0) {
      await options.prerenderCache.store.updateTagManifest(payload.tags, {
        mode: payload.tagMode,
        now,
        ...(payload.tagMode === 'stale' &&
        typeof resolvedTagExpireSeconds === 'number'
          ? { expireSeconds: resolvedTagExpireSeconds }
          : {}),
      });
    }
  }

  const storeTaskResult = options.prerenderCache.store.findRevalidateTargets
    ? createManualRevalidateTasksFromTargets({
        targets: await options.prerenderCache.store.findRevalidateTargets({
          pathnames: payload.paths,
          tags: allTags,
        }),
        pathnames: payload.paths,
      })
    : {
        tasks: [] as PrerenderRevalidateTask[],
        directMatchedPathnames: [] as string[],
      };

  const manifestTaskResult = createManualRevalidateTasksFromManifest({
    manifest: options.manifest,
    request,
    pathnames: payload.paths,
    tags: allTags,
    pathTags,
  });

  const tasksByCacheKey = new Map<string, PrerenderRevalidateTask>();
  for (const task of [...storeTaskResult.tasks, ...manifestTaskResult.tasks]) {
    const existing = tasksByCacheKey.get(task.cacheKey);
    if (!existing) {
      tasksByCacheKey.set(task.cacheKey, task);
      continue;
    }
    if (existing.reason === 'MANUAL_TAG' && task.reason === 'MANUAL_PATH') {
      tasksByCacheKey.set(task.cacheKey, task);
    }
  }

  let dispatched = 0;
  for (const task of tasksByCacheKey.values()) {
    if (!options.prerenderCache.revalidateQueue) {
      break;
    }
    await options.prerenderCache.revalidateQueue.enqueue(task);
    dispatched += 1;
  }

  return new Response(
    JSON.stringify({
      accepted: true,
      tagManifestUpdated: tagManifestSupported,
      tagMode: payload.tagMode,
      tagProfile: payload.tagProfile ?? undefined,
      tagExpireSeconds: resolvedTagExpireSeconds,
      derivedPathTags: pathTags,
      dispatched,
      directMatches: [
        ...new Set([
          ...storeTaskResult.directMatchedPathnames,
          ...manifestTaskResult.directMatchedPathnames,
        ]),
      ],
      groupFanout: manifestTaskResult.expandedGroupPathnames,
    }),
    {
      status: 202,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }
  );
}

function indexByPathname<T extends { pathname: string; id: string }>(
  items: T[],
  label: string
): Map<string, T> {
  const byPathname = new Map<string, T>();

  for (const item of items) {
    const existing = byPathname.get(item.pathname);
    if (existing && existing.id !== item.id) {
      throw new Error(
        `Duplicate ${label} pathname "${item.pathname}" for "${existing.id}" and "${item.id}"`
      );
    }
    byPathname.set(item.pathname, item);
  }

  return byPathname;
}

type RouteIndexes = {
  staticByPathname: Map<string, BunStaticAsset>;
  functionByPathname: Map<string, BunFunctionArtifact>;
  functionById: Map<string, BunFunctionArtifact>;
  prerenderByPathname: Map<string, BunPrerenderSeed>;
};

function buildRouteIndexes(manifest: BunDeploymentManifest): RouteIndexes {
  const staticByPathname = indexByPathname(manifest.staticAssets, 'static asset');
  const functionByPathname = indexByPathname(manifest.functionMap, 'function output');
  const prerenderByPathname = indexByPathname(
    manifest.prerenderSeeds,
    'prerender seed'
  );

  const functionById = new Map<string, BunFunctionArtifact>();
  for (const output of manifest.functionMap) {
    const existing = functionById.get(output.id);
    if (existing && existing.bundleId !== output.bundleId) {
      throw new Error(
        `Duplicate function id "${output.id}" for "${existing.bundleId}" and "${output.bundleId}"`
      );
    }
    functionById.set(output.id, output);
  }

  return {
    staticByPathname,
    functionByPathname,
    functionById,
    prerenderByPathname,
  };
}

function isRedirectResolution(resolution: RouteResolutionResult): boolean {
  if (!resolution.status) return false;
  if (resolution.status < 300 || resolution.status >= 400) return false;
  return Boolean(resolution.resolvedHeaders?.get('location'));
}

async function enqueueRevalidate({
  options,
  cacheKey,
  seed,
  reason,
}: {
  options: RouterRuntimeOptions;
  cacheKey: string;
  seed: BunPrerenderSeed;
  reason: PrerenderRevalidateReason;
}): Promise<void> {
  const cacheConfig = options.prerenderCache;
  if (!cacheConfig?.revalidateQueue) {
    return;
  }

  await cacheConfig.revalidateQueue.enqueue({
    cacheKey,
    pathname: seed.pathname,
    groupId: seed.groupId,
    reason,
  });
}

function applySeedFallbackHeaders(
  response: Response,
  seed: BunPrerenderSeed
): Response {
  const fallback = seed.fallback;
  if (!fallback) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(fallback.initialHeaders ?? {})) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
      continue;
    }
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: fallback.initialStatus ?? response.status,
    statusText: response.statusText,
    headers,
  });
}

function toPrerenderParentRequest({
  request,
  seed,
}: {
  request: Request;
  seed: BunPrerenderSeed;
}): Request {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return request;
  }

  const rawPostponedStatePath = seed.fallback?.postponedStatePath;
  if (
    typeof rawPostponedStatePath !== 'string' ||
    rawPostponedStatePath.length === 0
  ) {
    return request;
  }

  const shouldTreatAsResumePath =
    rawPostponedStatePath.startsWith('/') ||
    rawPostponedStatePath.startsWith('http://') ||
    rawPostponedStatePath.startsWith('https://');
  if (!shouldTreatAsResumePath) {
    if (request.method !== 'GET') {
      return request;
    }
    const headers = new Headers(request.headers);
    applyPrerenderResumeHeaders(headers, seed);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'text/plain; charset=utf-8');
    }
    return new Request(request.url, {
      method: 'POST',
      headers,
      body: rawPostponedStatePath,
    });
  }

  const resumePath = resolvePrerenderResumePath(seed);
  if (!resumePath) {
    return request;
  }

  const url = new URL(request.url);
  url.pathname = resumePath.pathname;
  url.search = resumePath.search;

  const headers = new Headers(request.headers);
  applyPrerenderResumeHeaders(headers, seed);
  return new Request(url.toString(), {
    method: request.method,
    headers,
  });
}

function createFallbackBodyConcatenatedResponse({
  fallbackResponse,
  resumeResponse,
  resumeResponsePromise,
}: {
  fallbackResponse: Response;
  resumeResponse?: Response | null;
  resumeResponsePromise?: Promise<Response | null>;
}): Response {
  if (typeof resumeResponse === 'undefined' && !resumeResponsePromise) {
    return fallbackResponse;
  }

  const directResumeResponse = resumeResponse ?? null;
  const pendingResumePromise =
    resumeResponsePromise ??
    (typeof resumeResponse === 'undefined'
      ? undefined
      : Promise.resolve(directResumeResponse));

  const headers = new Headers(fallbackResponse.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');

  if (directResumeResponse) {
    for (const [key, value] of directResumeResponse.headers.entries()) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey === 'content-length' ||
        normalizedKey === 'content-encoding' ||
        normalizedKey === 'transfer-encoding'
      ) {
        continue;
      }
      if (normalizedKey === 'set-cookie') {
        headers.append(key, value);
        continue;
      }
      headers.set(key, value);
    }
  } else if (pendingResumePromise) {
    headers.set(
      'cache-control',
      'private, no-cache, no-store, max-age=0, must-revalidate'
    );
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const pump = async (response: Response | null) => {
        if (!response?.body) {
          return;
        }
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (value) {
              controller.enqueue(value);
            }
          }
        } finally {
          reader.releaseLock();
        }
      };

      try {
        await pump(fallbackResponse);
        if (directResumeResponse) {
          await pump(directResumeResponse);
        } else if (pendingResumePromise) {
          const resolvedResumeResponse = await pendingResumePromise.catch(() => null);
          await pump(resolvedResumeResponse);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(body, {
    status: fallbackResponse.status,
    statusText: fallbackResponse.statusText,
    headers,
  });
}

function isGetOrHeadRequest(request: Request): boolean {
  return request.method === 'GET' || request.method === 'HEAD';
}

function stripInternalMiddlewareRequestHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  for (const header of INTERNAL_MIDDLEWARE_REQUEST_HEADERS) {
    sanitized.delete(header);
  }
  return sanitized;
}

function collectInternalMiddlewareRequestHeaders(headers: Headers): Headers {
  const internal = new Headers();
  for (const header of INTERNAL_MIDDLEWARE_REQUEST_HEADERS) {
    const value = headers.get(header);
    if (value !== null) {
      internal.set(header, value);
    }
  }
  return internal;
}

function restoreInternalMiddlewareRequestHeaders({
  requestHeaders,
  internalHeaders,
}: {
  requestHeaders: Headers;
  internalHeaders: Headers;
}): Headers {
  const restored = new Headers(requestHeaders);
  for (const header of INTERNAL_MIDDLEWARE_REQUEST_HEADERS) {
    const value = internalHeaders.get(header);
    if (value !== null) {
      restored.set(header, value);
    }
  }
  return restored;
}

async function refreshImageCache({
  options,
  request,
  resolution,
}: {
  options: RouterRuntimeOptions;
  request: Request;
  resolution: RouteResolutionResult;
}): Promise<void> {
  const cacheConfig = options.imageCache;
  if (!cacheConfig || !options.invokeImageFunction) {
    return;
  }

  const now = cacheConfig.now?.() ?? Date.now();
  const cacheKey = createImageCacheKey(request, options.manifest.build.basePath);
  const generatedResponse = await options.invokeImageFunction({
    request,
    matchedPathname: toImageRoutePath(options.manifest.build.basePath),
    routeMatches: resolution.routeMatches,
    resolution,
    source: 'image',
    cacheState: 'MISS',
  });
  const shouldCache =
    cacheConfig.shouldCacheResponse?.(generatedResponse, cacheKey) ??
    defaultShouldCacheImageResponse(generatedResponse);
  if (!shouldCache) {
    return;
  }

  const cacheEntry = await responseToImageCacheEntry({
    cacheKey: cacheKey.key,
    pathname: cacheKey.pathname,
    response: generatedResponse,
    now,
    ttlSeconds: cacheConfig.ttlSeconds,
    staleTtlSeconds: cacheConfig.staleTtlSeconds,
  });
  await cacheConfig.store.set(cacheKey.key, cacheEntry);
}

export function createRouterRuntime(options: RouterRuntimeOptions): RouterRuntime {
  const { manifest } = options;
  const indexes = buildRouteIndexes(manifest);
  const bypassTokens = collectBypassTokens(manifest);

  return {
    manifest,
    async handleRequest(request: Request): Promise<Response> {
      const onDemandRevalidate = parseOnDemandRevalidateRequest({
        request,
        revalidateAuthToken: options.revalidateAuthToken,
        bypassTokens,
      });
      const previouslyRevalidatedTagSet = new Set(
        parsePreviouslyRevalidatedTags({ request, bypassTokens })
      );

      const manualRevalidateResponse = await maybeHandleManualRevalidateRequest({
        options,
        request,
      });
      if (manualRevalidateResponse) {
        return withRouteMetadata(manualRevalidateResponse, {
          kind: 'function',
          id: 'revalidate-endpoint',
        });
      }

      let middlewareResponse: Response | null = null;
      let middlewareRewriteUrl: URL | null = null;
      let middlewareRequestHeaders: Headers | null = null;
      const internalMiddlewareRequestHeaders =
        collectInternalMiddlewareRequestHeaders(request.headers);

      const unresolvedResolution = await resolveRoutes({
        url: new URL(request.url),
        buildId: manifest.build.buildId,
        basePath: manifest.build.basePath,
        requestBody: request.body ?? createEmptyBodyStream(),
        headers: new Headers(request.headers),
        pathnames: manifest.pathnames,
        i18n: toResolutionI18nConfig(manifest),
        routes: toResolutionRoutes(manifest),
        invokeMiddleware: async (ctx) => {
          const middlewareCtx = {
            ...ctx,
            headers: stripInternalMiddlewareRequestHeaders(ctx.headers),
          };
          const result: RouterMiddlewareResult | {} =
            (await options.invokeMiddleware?.(middlewareCtx)) ?? {};

          if ('rewrite' in result && result.rewrite instanceof URL) {
            middlewareRewriteUrl = result.rewrite;
          }
          if ('requestHeaders' in result && result.requestHeaders instanceof Headers) {
            middlewareRequestHeaders = restoreInternalMiddlewareRequestHeaders({
              requestHeaders: result.requestHeaders,
              internalHeaders: internalMiddlewareRequestHeaders,
            });
          }
          if ('response' in result && result.response) {
            middlewareResponse = result.response;
          }
          return stripMiddlewareResponse(result);
        },
      });

      let resolution = stripRequestHeaderEchoes({
        resolution: unresolvedResolution,
        requestHeaders: request.headers,
      });
      const nextDataRewriteHeader = resolveNextDataRewriteHeader({
        request,
        rewriteUrl: middlewareRewriteUrl,
        basePath: manifest.build.basePath,
        buildId: manifest.build.buildId,
      });
      if (
        nextDataRewriteHeader &&
        resolution.resolvedHeaders?.has('x-nextjs-rewrite') !== true
      ) {
        resolution = withResolvedHeader(
          resolution,
          'x-nextjs-rewrite',
          nextDataRewriteHeader
        );
      }
      const requestWithMiddlewareMutations = withMiddlewareRequestMutations({
        request,
        rewriteUrl: middlewareRewriteUrl,
        requestHeaders: middlewareRequestHeaders,
      });

      if (resolution.redirect) {
        const response = new Response(null, {
          status: resolution.redirect.status,
          headers: { location: resolution.redirect.url.toString() },
        });
        return withRouteMetadata(
          applyResolutionToResponse(response, resolution, resolution.redirect.status),
          { kind: 'redirect' }
        );
      }

      if (resolution.externalRewrite) {
        if (options.handleExternalRewrite) {
          const response = await options.handleExternalRewrite({
            request,
            resolution,
            targetUrl: resolution.externalRewrite,
          });
          return withRouteMetadata(applyResolutionToResponse(response, resolution), {
            kind: 'external-rewrite',
          });
        }

        return withRouteMetadata(
          applyResolutionToResponse(
            new Response('External rewrite handling is not configured', {
              status: 502,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            }),
            resolution,
            502
          ),
          { kind: 'external-rewrite' }
        );
      }

      if (resolution.middlewareResponded) {
        const response =
          middlewareResponse ??
          new Response('Middleware response payload was not provided', {
            status: 500,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        return withRouteMetadata(applyResolutionToResponse(response, resolution), {
          kind: 'middleware',
        });
      }

      if (isRedirectResolution(resolution)) {
        return withRouteMetadata(
          applyResolutionToResponse(
            new Response(null, { status: resolution.status }),
            resolution,
            resolution.status
          ),
          { kind: 'redirect' }
        );
      }

      const requestUrl = new URL(requestWithMiddlewareMutations.url);
      if (isImageOptimizationPath(requestUrl.pathname, manifest.build.basePath)) {
        if (!options.invokeImageFunction) {
          return withRouteMetadata(
            applyResolutionToResponse(
              new Response('Image optimization handling is not configured', {
                status: 502,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              }),
              resolution,
              502
            ),
            { kind: 'image', id: 'image-optimizer' }
          );
        }

        const imageContext = {
          request,
          matchedPathname: toImageRoutePath(manifest.build.basePath),
          routeMatches: resolution.routeMatches,
          resolution,
          source: 'image' as const,
        };
        const cacheConfig = options.imageCache;

        if (!cacheConfig) {
          const response = await options.invokeImageFunction({
            ...imageContext,
            cacheState: undefined,
          });
          return withRouteMetadata(
            applyResolutionToResponse(response, resolution, response.status),
            { kind: 'image', id: 'image-optimizer' }
          );
        }

        const now = cacheConfig.now?.() ?? Date.now();
        const cacheKey = createImageCacheKey(request, manifest.build.basePath);
        const bypass = shouldBypassImageCache(
          request,
          cacheKey,
          cacheConfig.shouldBypassCache
        );

        if (!bypass) {
          const cachedEntry = await cacheConfig.store.get(cacheKey.key);
          const cacheResult = evaluateImageCacheEntry({ entry: cachedEntry, now });

          if (cacheResult.kind === 'fresh') {
            const cachedResponse = imageCacheEntryToResponse(cacheResult.entry);
            return withRouteMetadata(
              withCacheState(
                applyResolutionToResponse(cachedResponse, resolution, cachedResponse.status),
                'HIT'
              ),
              { kind: 'image', id: 'image-optimizer' }
            );
          }

          if (cacheResult.kind === 'stale') {
            void refreshImageCache({
              options,
              request: new Request(request),
              resolution,
            }).catch(() => undefined);
            const cachedResponse = imageCacheEntryToResponse(cacheResult.entry);
            return withRouteMetadata(
              withCacheState(
                applyResolutionToResponse(cachedResponse, resolution, cachedResponse.status),
                'STALE'
              ),
              { kind: 'image', id: 'image-optimizer' }
            );
          }
        }

        const generatedResponse = await options.invokeImageFunction({
          ...imageContext,
          cacheState: bypass ? 'BYPASS' : 'MISS',
        });

        if (!bypass) {
          const shouldCache =
            cacheConfig.shouldCacheResponse?.(generatedResponse, cacheKey) ??
            defaultShouldCacheImageResponse(generatedResponse);
          if (shouldCache) {
            const cacheEntry = await responseToImageCacheEntry({
              cacheKey: cacheKey.key,
              pathname: cacheKey.pathname,
              response: generatedResponse.clone(),
              now,
              ttlSeconds: cacheConfig.ttlSeconds,
              staleTtlSeconds: cacheConfig.staleTtlSeconds,
            });
            await cacheConfig.store.set(cacheKey.key, cacheEntry);
          }
        }

        const resolvedResponse = applyResolutionToResponse(
          generatedResponse,
          resolution,
          generatedResponse.status
        );
        return withRouteMetadata(
          withCacheState(resolvedResponse, bypass ? 'BYPASS' : 'MISS'),
          { kind: 'image', id: 'image-optimizer' }
        );
      }

      let matchedPathname = resolution.matchedPathname;
      if (!matchedPathname) {
        matchedPathname = maybeResolveDirectPathnameFallback({
          requestPathname: requestUrl.pathname,
          indexes,
        }) ?? undefined;
      }
      if (!matchedPathname) {
        matchedPathname = maybeResolveNextDataFallbackPathname({
          requestPathname: requestUrl.pathname,
          basePath: manifest.build.basePath,
          buildId: manifest.build.buildId,
          indexes,
        }) ?? undefined;
      }
      if (!matchedPathname) {
        const appNotFoundOutput = indexes.functionByPathname.get('/_not-found');
        if (
          appNotFoundOutput &&
          shouldAttemptAppNotFoundFunction({
            requestPathname: requestUrl.pathname,
            basePath: manifest.build.basePath,
          })
        ) {
          const appNotFoundResponse = await options.invokeFunction({
            request: requestWithMiddlewareMutations,
            matchedPathname: '/_not-found',
            routeMatches: resolution.routeMatches,
            resolution,
            output: appNotFoundOutput,
            source: 'function',
            prerenderSeed: null,
            cacheState: undefined,
          });
          return withRouteMetadata(
            applyResolutionToResponse(appNotFoundResponse, resolution, 404),
            {
              kind: 'not-found',
              id: appNotFoundOutput.id,
            }
          );
        }

        const response = options.handleNotFound
          ? await options.handleNotFound({
            request: requestWithMiddlewareMutations,
            resolution,
          })
          : notFoundResponse(resolution.status ?? 404);
        return withRouteMetadata(applyResolutionToResponse(response, resolution), {
          kind: 'not-found',
        });
      }

      // Normalize "/" to "/index" — Pages Router emits the root page as
      // "/index" in the static assets and function maps.
      const normalizedMatchedPathname =
        matchedPathname === '/' ? '/index' : matchedPathname;

      const resolvedMatchedPathname = maybeResolveRscMatchedPathname({
        request,
        matchedPathname: normalizedMatchedPathname,
        manifest,
        indexes,
      });

      const staticAsset = indexes.staticByPathname.get(resolvedMatchedPathname);
      if (staticAsset) {
        const response = await options.serveStatic({
          request,
          matchedPathname: resolvedMatchedPathname,
          routeMatches: resolution.routeMatches,
          resolution,
          asset: staticAsset,
          source: 'static',
        });
        return withRouteMetadata(applyResolutionToResponse(response, resolution), {
          kind: 'static',
          id: staticAsset.id,
        });
      }

      const prerenderSeed = indexes.prerenderByPathname.get(resolvedMatchedPathname);
      if (prerenderSeed) {
        const cacheConfig = options.prerenderCache;
        const bypass = shouldBypassPrerenderCache(
          prerenderSeed,
          request,
          cacheConfig?.bypassTokenResolver
        );
        const supportsPrerenderCacheMethod = isGetOrHeadRequest(request);
        if (!supportsPrerenderCacheMethod && !bypass) {
          return withRouteMetadata(
            applyResolutionToResponse(
              new Response('Method Not Allowed', {
                status: 405,
                headers: {
                  allow: 'GET, HEAD',
                  'content-type': 'text/plain; charset=utf-8',
                },
              }),
              resolution,
              405
            ),
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        if (onDemandRevalidate.kind === 'valid') {
          if (!cacheConfig) {
            return withRouteMetadata(
              new Response('Prerender cache is not configured for revalidation', {
                status: 503,
                headers: {
                  'content-type': 'text/plain; charset=utf-8',
                  'x-nextjs-cache': 'REVALIDATED',
                },
              }),
              { kind: 'prerender', id: prerenderSeed.id }
            );
          }

          const now = cacheConfig.now?.() ?? Date.now();
          const cacheKeyRequest = toPrerenderCacheKeyRequest(request);
          const cacheKey = createPrerenderCacheKey(prerenderSeed, cacheKeyRequest);
          const existingEntry = await cacheConfig.store.get(cacheKey.key);
          if (onDemandRevalidate.onlyGenerated && !existingEntry) {
            return withRouteMetadata(
              applyResolutionToResponse(
                new Response('This page could not be found', {
                  status: 404,
                  headers: {
                    'content-type': 'text/plain; charset=utf-8',
                    'x-nextjs-cache': 'REVALIDATED',
                  },
                }),
                resolution,
                404
              ),
              { kind: 'prerender', id: prerenderSeed.id }
            );
          }

          const pathTags = toImplicitPathTags(prerenderSeed.pathname);
          if (cacheConfig.store.updateTagManifest) {
            await cacheConfig.store.updateTagManifest(pathTags, {
              mode: 'expire',
              now,
            });

            if (existingEntry) {
              const existingTags = parseCacheTagsHeader(
                existingEntry.headers[NEXT_CACHE_TAGS_HEADER]
              );
              if (existingTags.length > 0) {
                await cacheConfig.store.updateTagManifest(existingTags, {
                  mode: 'expire',
                  now,
                });
              }
            }
          }

          const parentOutput = indexes.functionById.get(prerenderSeed.parentOutputId);
          if (!parentOutput) {
            return withRouteMetadata(
              applyResolutionToResponse(
                new Response('Prerender parent function is missing', {
                  status: 500,
                  headers: {
                    'content-type': 'text/plain; charset=utf-8',
                    'x-nextjs-cache': 'REVALIDATED',
                  },
                }),
                resolution,
                500
              ),
              { kind: 'prerender', id: prerenderSeed.id }
            );
          }

          const invocationRequest = filterPrerenderRequestByAllowLists(
            prerenderSeed,
            requestWithMiddlewareMutations
          );
          const generatedResponse = await options.invokeFunction({
            request: invocationRequest,
            matchedPathname: resolvedMatchedPathname,
            routeMatches: resolution.routeMatches,
            resolution,
            output: parentOutput,
            source: 'prerender-parent',
            prerenderSeed,
            cacheState: 'MISS',
          });

          const shouldCache =
            cacheConfig.shouldCacheResponse?.(generatedResponse, prerenderSeed) ??
            generatedResponse.status < 500;
          if (shouldCache && !isPrerenderResumeRequest(prerenderSeed, invocationRequest)) {
            const cacheEntry = await responseToPrerenderCacheEntry({
              seed: prerenderSeed,
              cacheKey: cacheKey.key,
              pathname: cacheKey.pathname,
              cacheQuery: cacheKey.query,
              cacheHeaders: cacheKey.headers,
              response: generatedResponse.clone(),
              now,
            });
            await cacheConfig.store.set(cacheKey.key, cacheEntry);
          }

          return withRouteMetadata(
            withHeader(
              applyResolutionToResponse(generatedResponse, resolution),
              'x-nextjs-cache',
              'REVALIDATED'
            ),
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        if (options.handlePrerender) {
          const response = await options.handlePrerender({
            request,
            matchedPathname: resolvedMatchedPathname,
            routeMatches: resolution.routeMatches,
            resolution,
            seed: prerenderSeed,
            parentOutput:
              indexes.functionById.get(prerenderSeed.parentOutputId) ?? null,
            source: 'prerender',
            cacheState: cacheConfig ? 'MISS' : undefined,
          });
          const resolvedResponse = applyResolutionToResponse(response, resolution);
          return withRouteMetadata(
            cacheConfig ? withCacheState(resolvedResponse, 'MISS') : resolvedResponse,
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        if (cacheConfig) {
          const now = cacheConfig.now?.() ?? Date.now();
          const cacheKeyRequest = toPrerenderCacheKeyRequest(request);
          const cacheKey = createPrerenderCacheKey(prerenderSeed, cacheKeyRequest);

          if (!bypass) {
            const cachedEntry = await cacheConfig.store.get(cacheKey.key);
            const hadExistingEntry = Boolean(cachedEntry);
            const cacheResultBase = evaluatePrerenderCacheEntry({
              entry: cachedEntry,
              now,
            });
            let cacheResult = cacheResultBase;
            const cacheTags = cacheResultBase.entry
              ? parseCacheTagsHeader(
                  cacheResultBase.entry.headers[NEXT_CACHE_TAGS_HEADER]
                )
              : [];
            if (
              cacheResultBase.entry &&
              cacheTags.length > 0 &&
              cacheTags.some((tag) => previouslyRevalidatedTagSet.has(tag))
            ) {
              cacheResult = { kind: 'miss', entry: null };
            } else if (
              cacheResultBase.entry &&
              cacheConfig.store.getTagManifestEntries &&
              cacheTags.length > 0
            ) {
              const tagManifestEntries =
                await cacheConfig.store.getTagManifestEntries(cacheTags);
              const tagState = evaluatePrerenderTagManifestState({
                entryCreatedAt: cacheResultBase.entry.createdAt,
                tags: cacheTags,
                tagManifestEntries,
                now,
              });

              if (tagState === 'expired') {
                cacheResult = { kind: 'miss', entry: null };
              } else if (
                tagState === 'stale' &&
                cacheResultBase.kind === 'fresh'
              ) {
                cacheResult = { kind: 'stale', entry: cacheResultBase.entry };
              }
            }

            if (cacheResult.kind === 'fresh') {
              const cachedResponse = prerenderCacheEntryToResponse(cacheResult.entry);
              return withRouteMetadata(
                withCacheState(
                  applyResolutionToResponse(cachedResponse, resolution),
                  'HIT'
                ),
                { kind: 'prerender', id: prerenderSeed.id }
              );
            }

            if (cacheResult.kind === 'stale') {
              await enqueueRevalidate({
                options,
                cacheKey: cacheKey.key,
                seed: prerenderSeed,
                reason: 'STALE',
              });
              const cachedResponse = prerenderCacheEntryToResponse(cacheResult.entry);
              return withRouteMetadata(
                withCacheState(
                  applyResolutionToResponse(cachedResponse, resolution),
                  'STALE'
                ),
                { kind: 'prerender', id: prerenderSeed.id }
              );
            }

            if (!hadExistingEntry && prerenderSeed.fallback?.stagedPath && prerenderSeed.fallback.sourcePath) {
              const fallbackResponse = await options.serveStatic({
                request,
                matchedPathname: resolvedMatchedPathname,
                routeMatches: resolution.routeMatches,
                resolution,
                source: 'static',
                cacheState: 'MISS',
                asset: {
                  id: `prerender-fallback:${prerenderSeed.id}`,
                  pathname: resolvedMatchedPathname,
                  sourceType: 'next-static',
                  sourcePath: prerenderSeed.fallback.sourcePath,
                  stagedPath: prerenderSeed.fallback.stagedPath,
                  objectKey: prerenderSeed.fallback.stagedPath,
                  contentType: null,
                  cacheControl: null,
                },
              });
              const seededFallbackResponse = applySeedFallbackHeaders(
                fallbackResponse,
                prerenderSeed
              );

              const parentOutput = indexes.functionById.get(
                prerenderSeed.parentOutputId
              );
              const resumeRequest = parentOutput
                ? toPrerenderParentRequest({
                    request: requestWithMiddlewareMutations,
                    seed: prerenderSeed,
                  })
                : requestWithMiddlewareMutations;
              const shouldAttemptInlineResume =
                Boolean(parentOutput) &&
                resumeRequest !== requestWithMiddlewareMutations;

              if (parentOutput && shouldAttemptInlineResume) {
                const resumeResponsePromise = Promise.resolve(
                  options.invokeFunction({
                    request: resumeRequest,
                    matchedPathname: resolvedMatchedPathname,
                    routeMatches: resolution.routeMatches,
                    resolution,
                    output: parentOutput,
                    source: 'prerender-parent',
                    prerenderSeed,
                    cacheState: 'MISS',
                  })
                ).catch(async () => {
                  await enqueueRevalidate({
                    options,
                    cacheKey: cacheKey.key,
                    seed: prerenderSeed,
                    reason: 'MISS_FALLBACK',
                  });
                  return null;
                });
                const mergedResponse = createFallbackBodyConcatenatedResponse({
                  fallbackResponse: seededFallbackResponse,
                  resumeResponsePromise,
                });
                return withRouteMetadata(
                  withCacheState(
                    applyResolutionToResponse(mergedResponse, resolution),
                    'MISS'
                  ),
                  { kind: 'prerender', id: prerenderSeed.id }
                );
              }

              await enqueueRevalidate({
                options,
                cacheKey: cacheKey.key,
                seed: prerenderSeed,
                reason: 'MISS_FALLBACK',
              });

              return withRouteMetadata(
                withCacheState(
                  applyResolutionToResponse(seededFallbackResponse, resolution),
                  'MISS'
                ),
                { kind: 'prerender', id: prerenderSeed.id }
              );
            }

            if (!hadExistingEntry && prerenderSeed.parentFallbackMode === false) {
              return withRouteMetadata(
                withCacheState(
                  applyResolutionToResponse(notFoundResponse(404), resolution, 404),
                  'MISS'
                ),
                { kind: 'prerender', id: prerenderSeed.id }
              );
            }
          }

          const parentOutput = indexes.functionById.get(prerenderSeed.parentOutputId);
          if (!parentOutput) {
            return withRouteMetadata(
              withCacheState(
                applyResolutionToResponse(
                  new Response('Prerender parent function is missing', {
                    status: 500,
                    headers: { 'content-type': 'text/plain; charset=utf-8' },
                  }),
                  resolution,
                  500
                ),
                'MISS'
              ),
              { kind: 'prerender', id: prerenderSeed.id }
            );
          }

          const invocationRequest = toPrerenderParentRequest({
            request: requestWithMiddlewareMutations,
            seed: prerenderSeed,
          });
          const generatedResponse = await options.invokeFunction({
            request: invocationRequest,
            matchedPathname: resolvedMatchedPathname,
            routeMatches: resolution.routeMatches,
            resolution,
            output: parentOutput,
            source: 'prerender-parent',
            prerenderSeed,
            cacheState: bypass ? 'BYPASS' : 'MISS',
          });

          if (!bypass) {
            const shouldCache =
              cacheConfig.shouldCacheResponse?.(generatedResponse, prerenderSeed) ??
              generatedResponse.status < 500;
            if (shouldCache && !isPrerenderResumeRequest(prerenderSeed, invocationRequest)) {
              const cacheEntry = await responseToPrerenderCacheEntry({
                seed: prerenderSeed,
                cacheKey: cacheKey.key,
                pathname: cacheKey.pathname,
                cacheQuery: cacheKey.query,
                cacheHeaders: cacheKey.headers,
                response: generatedResponse.clone(),
                now,
              });
              await cacheConfig.store.set(cacheKey.key, cacheEntry);
            }
          }

          return withRouteMetadata(
            withCacheState(
              applyResolutionToResponse(generatedResponse, resolution),
              bypass ? 'BYPASS' : 'MISS'
            ),
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        if (prerenderSeed.fallback?.stagedPath && prerenderSeed.fallback.sourcePath) {
          const fallbackResponse = await options.serveStatic({
            request,
            matchedPathname: resolvedMatchedPathname,
            routeMatches: resolution.routeMatches,
            resolution,
            source: 'static',
            cacheState: 'MISS',
            asset: {
              id: `prerender-fallback:${prerenderSeed.id}`,
              pathname: resolvedMatchedPathname,
              sourceType: 'next-static',
              sourcePath: prerenderSeed.fallback.sourcePath,
              stagedPath: prerenderSeed.fallback.stagedPath,
              objectKey: prerenderSeed.fallback.stagedPath,
              contentType: null,
              cacheControl: null,
            },
          });
          const seededFallbackResponse = applySeedFallbackHeaders(
            fallbackResponse,
            prerenderSeed
          );

          const parentOutput = indexes.functionById.get(prerenderSeed.parentOutputId);
          const resumeRequest = parentOutput
            ? toPrerenderParentRequest({
                request: requestWithMiddlewareMutations,
                seed: prerenderSeed,
              })
            : requestWithMiddlewareMutations;
          const shouldAttemptInlineResume =
            Boolean(parentOutput) &&
            resumeRequest !== requestWithMiddlewareMutations;

          if (parentOutput && shouldAttemptInlineResume) {
            const resumeResponsePromise = Promise.resolve(
              options.invokeFunction({
                request: resumeRequest,
                matchedPathname: resolvedMatchedPathname,
                routeMatches: resolution.routeMatches,
                resolution,
                output: parentOutput,
                source: 'prerender-parent',
                prerenderSeed,
                cacheState: 'MISS',
              })
            ).catch(() => null);
            const mergedResponse = createFallbackBodyConcatenatedResponse({
              fallbackResponse: seededFallbackResponse,
              resumeResponsePromise,
            });
            return withRouteMetadata(
              withCacheState(
                applyResolutionToResponse(mergedResponse, resolution),
                'MISS'
              ),
              { kind: 'prerender', id: prerenderSeed.id }
            );
          }

          return withRouteMetadata(
            withCacheState(
              applyResolutionToResponse(seededFallbackResponse, resolution),
              'MISS'
            ),
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        const parentOutput = indexes.functionById.get(prerenderSeed.parentOutputId);
        if (!parentOutput) {
          return withRouteMetadata(
            applyResolutionToResponse(
              new Response('Prerender parent function is missing', {
                status: 500,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              }),
              resolution,
              500
            ),
            { kind: 'prerender', id: prerenderSeed.id }
          );
        }

        const response = await options.invokeFunction({
          request: toPrerenderParentRequest({
            request: requestWithMiddlewareMutations,
            seed: prerenderSeed,
          }),
          matchedPathname: resolvedMatchedPathname,
          routeMatches: resolution.routeMatches,
          resolution,
          output: parentOutput,
          source: 'prerender-parent',
          prerenderSeed,
          cacheState: 'MISS',
        });
        return withRouteMetadata(
          withCacheState(applyResolutionToResponse(response, resolution), 'MISS'),
          { kind: 'prerender', id: prerenderSeed.id }
        );
      }

      const output = indexes.functionByPathname.get(resolvedMatchedPathname);
      if (output) {
        const response = await options.invokeFunction({
          request: requestWithMiddlewareMutations,
          matchedPathname: resolvedMatchedPathname,
          routeMatches: resolution.routeMatches,
          resolution,
          output,
          source: 'function',
          prerenderSeed: null,
          cacheState: undefined,
        });
        return withRouteMetadata(applyResolutionToResponse(response, resolution), {
          kind: 'function',
          id: output.id,
        });
      }

      const response = options.handleNotFound
        ? await options.handleNotFound({
          request: requestWithMiddlewareMutations,
          resolution,
        })
        : notFoundResponse(resolution.status ?? 404);
      return withRouteMetadata(applyResolutionToResponse(response, resolution), {
        kind: 'not-found',
      });
    },
  };
}
