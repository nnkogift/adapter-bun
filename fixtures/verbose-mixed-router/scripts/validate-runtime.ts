import assert from 'node:assert/strict';
import {
  InMemoryPrerenderCacheStore,
  InMemoryImageCacheStore,
  createBunRevalidateQueue,
  createPrerenderCacheKey,
  createRouterRuntime,
  toImageRoutePath,
  toImplicitPathTags,
} from 'adapter-bun';
import type {
  BunDeploymentManifest,
  FunctionRouteDispatchContext,
  ImageRouteDispatchContext,
} from 'adapter-bun';
import manifestJson from '../bun-dist/deployment-manifest.json';

const ORIGIN = 'https://fixture.local';
const REVALIDATE_TOKEN = 'fixture-revalidate-token';
const HTML_ROUTE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const manifest = manifestJson as unknown as BunDeploymentManifest;
const IMAGE_ROUTE_PATH = toImageRoutePath(manifest.build.basePath);
const prerenderStore = new InMemoryPrerenderCacheStore();
const invocationCountByOutputId = new Map<string, number>();
let middlewareInvocationCount = 0;

function nextInvocation(outputId: string): number {
  const next = (invocationCountByOutputId.get(outputId) ?? 0) + 1;
  invocationCountByOutputId.set(outputId, next);
  return next;
}

function isRoutePresent({
  sourcePathFragment,
  routes,
}: {
  sourcePathFragment: string;
  routes: Array<{ sourceRegex: string; source?: string }>;
}): boolean {
  return routes.some((route) => {
    return (
      route.sourceRegex.includes(sourcePathFragment) ||
      (typeof route.source === 'string' && route.source.includes(sourcePathFragment))
    );
  });
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  return (await response.clone().json()) as T;
}

function getRequiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  assert.ok(value, `Expected response header "${name}" to be present`);
  return value;
}

function assertDocumentCacheControl(response: Response, context: string): void {
  assert.equal(
    response.headers.get('cache-control'),
    HTML_ROUTE_CACHE_CONTROL,
    `Expected ${context} to set cache-control: ${HTML_ROUTE_CACHE_CONTROL}`
  );
}

function readSingleHeaderValue(
  headers: Record<string, string | string[]> | null | undefined,
  name: string
): string | null {
  if (!headers) {
    return null;
  }

  const normalizedName = name.toLowerCase();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() !== normalizedName) {
      continue;
    }
    if (typeof headerValue === 'string') {
      return headerValue;
    }
    if (Array.isArray(headerValue)) {
      const firstValue = headerValue.find(
        (entry): entry is string => typeof entry === 'string'
      );
      if (firstValue) {
        return firstValue;
      }
    }
  }

  return null;
}

function assertRouteId(response: Response, expected: string): void {
  assert.equal(
    getRequiredHeader(response, 'x-bun-route-id'),
    expected,
    'Unexpected routed output id'
  );
}

function getNextStaticAssetFromManifest(): BunDeploymentManifest['staticAssets'][number] {
  const normalizedBasePath =
    manifest.build.basePath && manifest.build.basePath !== '/'
      ? manifest.build.basePath.endsWith('/')
        ? manifest.build.basePath.slice(0, -1)
        : manifest.build.basePath
      : '';
  const staticPrefix = `${normalizedBasePath}/_next/static/`;
  const asset = manifest.staticAssets.find((entry) =>
    entry.pathname.startsWith(staticPrefix)
  );
  assert.ok(
    asset,
    `Expected at least one static asset under "${staticPrefix}" in deployment manifest`
  );
  return asset;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type InvocationPayload = {
  kind: 'function';
  outputId: string;
  matchedPathname: string;
  source: FunctionRouteDispatchContext['source'];
  cacheState: string | null;
  invocation: number;
  routeMatches: Record<string, string> | null;
  requestMethod: string;
  requestNextAction: string | null;
  requestContentType: string | null;
  requestBody: string | null;
  requestUrl: string;
  requestCookie: string | null;
  requestBypassHeader: string | null;
  requestRscHeader: string | null;
  requestNextRouterStateTree: string | null;
  requestNextRouterSegmentPrefetch: string | null;
};

type ImageInvocationPayload = {
  kind: 'image';
  requestUrl: string;
  urlParam: string | null;
  wParam: string | null;
  qParam: string | null;
};

const imageInvocations: ImageInvocationPayload[] = [];

const invokeImageFunction = async (ctx: ImageRouteDispatchContext) => {
  const requestUrl = new URL(ctx.request.url);
  const payload: ImageInvocationPayload = {
    kind: 'image',
    requestUrl: ctx.request.url,
    urlParam: requestUrl.searchParams.get('url'),
    wParam: requestUrl.searchParams.get('w'),
    qParam: requestUrl.searchParams.get('q'),
  };
  imageInvocations.push(payload);
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};

const invokeFunction = async (ctx: FunctionRouteDispatchContext) => {
  const invocation = nextInvocation(ctx.output.id);
  const method = ctx.request.method;
  const contentType = ctx.request.headers.get('content-type');
  const nextAction = ctx.request.headers.get('next-action');
  const requestCookie = ctx.request.headers.get('cookie');
  const requestBypassHeader = ctx.request.headers.get('x-test-bypass');
  const requestRscHeader = ctx.request.headers.get('rsc');
  const requestNextRouterStateTree = ctx.request.headers.get(
    'next-router-state-tree'
  );
  const requestNextRouterSegmentPrefetch = ctx.request.headers.get(
    'next-router-segment-prefetch'
  );
  const requestBody =
    method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
      ? null
      : await ctx.request
          .clone()
          .text()
          .catch(() => null);
  const payload: InvocationPayload = {
    kind: 'function',
    outputId: ctx.output.id,
    matchedPathname: ctx.matchedPathname,
    source: ctx.source,
    cacheState: ctx.cacheState ?? null,
    invocation,
    routeMatches: ctx.routeMatches ?? null,
    requestMethod: method,
    requestNextAction: nextAction,
    requestContentType: contentType,
    requestBody,
    requestUrl: ctx.request.url,
    requestCookie,
    requestBypassHeader,
    requestRscHeader,
    requestNextRouterStateTree,
    requestNextRouterSegmentPrefetch,
  };
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
  });

  if (ctx.output.id === '/app-router/cache-tag') {
    headers.set('x-next-cache-tags', 'app-router-tag');
  }
  if (ctx.output.id === '/api/app-static') {
    headers.set('x-next-cache-tags', 'app-route-static-tag');
  }
  if (ctx.output.id === '/pages-router/ssg') {
    headers.set('x-next-cache-tags', '_N_T_/pages-router/ssg');
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers,
  });
};

const revalidateQueue = createBunRevalidateQueue({
  manifest,
  invokeFunction,
  prerenderCacheStore: prerenderStore,
  requestOrigin: ORIGIN,
});

const imageCacheStore = new InMemoryImageCacheStore();

const runtime = createRouterRuntime({
  manifest,
  invokeMiddleware: async (ctx) => {
    middlewareInvocationCount += 1;
    const requestHeaders = new Headers(ctx.headers);
    if (ctx.url.pathname === '/middleware-rewrite') {
      return {
        requestHeaders,
        responseHeaders: new Headers({
          'x-fixture-middleware': 'rewrite',
          'x-fixture-pathname': ctx.url.pathname,
        }),
        rewrite: new URL('/app-router/static', ctx.url),
      };
    }

    return {
      requestHeaders,
      responseHeaders: new Headers({
        'x-fixture-middleware': 'active',
        'x-fixture-pathname': ctx.url.pathname,
      }),
    };
  },
  serveStatic: async (ctx) => {
    return new Response(
      JSON.stringify({
        kind: 'static',
        assetId: ctx.asset.id,
        matchedPathname: ctx.matchedPathname,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
        },
      }
    );
  },
  invokeFunction,
  invokeImageFunction,
  prerenderCache: {
    store: prerenderStore,
    revalidateQueue,
  },
  imageCache: {
    store: imageCacheStore,
  },
  revalidateAuthToken: REVALIDATE_TOKEN,
});

async function invokeRuntime(
  pathname: string,
  init?: RequestInit
): Promise<Response> {
  const request = new Request(new URL(pathname, ORIGIN), init);
  return runtime.handleRequest(request);
}

// --- Test Functions ---

async function validateRouteGraphFromNextConfig(): Promise<void> {
  assert.ok(
    isRoutePresent({
      sourcePathFragment: 'cfg/rewrite-order',
      routes: manifest.routeGraph.beforeFiles,
    }),
    'Expected rewrite-order beforeFiles rule from next.config'
  );
  assert.ok(
    isRoutePresent({
      sourcePathFragment: 'cfg/rewrite-order',
      routes: manifest.routeGraph.afterFiles,
    }),
    'Expected rewrite-order afterFiles rule from next.config'
  );
  assert.ok(
    isRoutePresent({
      sourcePathFragment: 'cfg/rewrite-fallback',
      routes: manifest.routeGraph.fallback,
    }),
    'Expected rewrite-fallback rule from next.config'
  );
  assert.ok(
    isRoutePresent({
      sourcePathFragment: 'cfg/external',
      routes: manifest.routeGraph.fallback,
    }),
    'Expected external rewrite rule from next.config'
  );
}

async function validateMiddlewareAndRewriteOrdering(): Promise<void> {
  const middlewareRewrite = await invokeRuntime('/middleware-rewrite');
  assertRouteId(middlewareRewrite, '/app-router/static');
  assert.ok(
    middlewareInvocationCount > 0,
    'Expected middleware to be invoked during route resolution'
  );

  const rewriteOrder = await invokeRuntime('/cfg/rewrite-order/alpha');
  assertRouteId(rewriteOrder, '/pages-router/ssr');
  assert.equal(
    getRequiredHeader(rewriteOrder, 'x-fixture-next-config-header'),
    'cfg'
  );
  const rewriteOrderPayload = await parseJsonResponse<InvocationPayload>(
    rewriteOrder
  );
  assert.equal(
    rewriteOrderPayload.outputId,
    '/pages-router/ssr',
    'beforeFiles rewrite should win over afterFiles rewrite for identical source'
  );

  const rewriteAfter = await invokeRuntime('/cfg/rewrite-after/beta');
  assertRouteId(rewriteAfter, '/pages-router/products/[id]');
  assert.equal(
    getRequiredHeader(rewriteAfter, 'x-fixture-next-config-header'),
    'cfg'
  );
  const rewriteAfterPayload = await parseJsonResponse<InvocationPayload>(
    rewriteAfter
  );
  assert.equal(rewriteAfterPayload.routeMatches?.nxtPid, 'beta');

  const rewriteFallback = await invokeRuntime('/cfg/rewrite-fallback/foo/bar');
  assertRouteId(rewriteFallback, '/app-router/static');
}

async function validateRedirectFromNextConfig(): Promise<void> {
  const redirectResponse = await invokeRuntime('/cfg/redirect-old');
  assert.ok(
    redirectResponse.status === 307 ||
      redirectResponse.status === 308,
    `Expected 307/308 redirect, got ${redirectResponse.status}`
  );
  const location = getRequiredHeader(redirectResponse, 'location');
  assert.ok(
    location === '/pages-router/static' ||
      location === `${ORIGIN}/pages-router/static`,
    `Unexpected redirect location "${location}"`
  );
}

async function validateRequestHeadersAreNotEchoedToResponse(): Promise<void> {
  const response = await invokeRuntime('/pages-router/static', {
    headers: {
      'x-fixture-leak-check': 'sensitive-value',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  assert.equal(
    response.headers.get('x-fixture-leak-check'),
    null,
    'Expected request headers not to be reflected into response headers'
  );
  assert.equal(
    response.headers.get('accept'),
    null,
    'Expected request Accept header not to leak into response headers'
  );
}

async function validatePagesPrerenderAndOnDemandRevalidate(): Promise<void> {
  const first = await invokeRuntime('/pages-router/ssg');
  assert.equal(getRequiredHeader(first, 'x-bun-cache'), 'MISS');
  assertDocumentCacheControl(first, '/pages-router/ssg first response');

  const second = await invokeRuntime('/pages-router/ssg');
  assert.equal(
    getRequiredHeader(second, 'x-bun-cache'),
    'HIT'
  );
  assertDocumentCacheControl(second, '/pages-router/ssg second response');
  const secondPayload = await parseJsonResponse<InvocationPayload>(second);
  assert.ok(secondPayload.invocation >= 1);

  const onDemand = await invokeRuntime('/pages-router/ssg', {
    headers: {
      'x-prerender-revalidate': REVALIDATE_TOKEN,
    },
  });
  assert.equal(getRequiredHeader(onDemand, 'x-nextjs-cache'), 'REVALIDATED');
  assertDocumentCacheControl(onDemand, '/pages-router/ssg on-demand response');
  const onDemandPayload = await parseJsonResponse<InvocationPayload>(onDemand);
  assert.ok(onDemandPayload.invocation > secondPayload.invocation);

  const afterOnDemand = await invokeRuntime('/pages-router/ssg');
  assert.equal(
    getRequiredHeader(afterOnDemand, 'x-bun-cache'),
    'HIT'
  );
  assertDocumentCacheControl(
    afterOnDemand,
    '/pages-router/ssg response after on-demand revalidate'
  );
  const afterOnDemandPayload = await parseJsonResponse<InvocationPayload>(
    afterOnDemand
  );
  assert.equal(afterOnDemandPayload.invocation, onDemandPayload.invocation);
}

async function validateNextDataRoutes(): Promise<void> {
  const buildId = manifest.build.buildId;

  const ssgDataPath = `/_next/data/${buildId}/pages-router/ssg.json`;
  const ssgFirst = await invokeRuntime(ssgDataPath);
  assert.equal(
    getRequiredHeader(ssgFirst, 'x-bun-route-kind'),
    'prerender'
  );
  assert.equal(getRequiredHeader(ssgFirst, 'x-bun-cache'), 'MISS');
  assertDocumentCacheControl(ssgFirst, ssgDataPath);

  const ssgSecond = await invokeRuntime(ssgDataPath);
  assert.equal(
    getRequiredHeader(ssgSecond, 'x-bun-route-kind'),
    'prerender'
  );
  assert.equal(getRequiredHeader(ssgSecond, 'x-bun-cache'), 'HIT');
  assertDocumentCacheControl(ssgSecond, `${ssgDataPath} (cached)`);

  const ssrDataPath = `/_next/data/${buildId}/pages-router/ssr.json`;
  const ssrData = await invokeRuntime(ssrDataPath);
  assert.equal(
    getRequiredHeader(ssrData, 'x-bun-route-kind'),
    'function'
  );
  assertRouteId(ssrData, ssrDataPath);
  assertDocumentCacheControl(ssrData, ssrDataPath);

  const unknownData = await invokeRuntime(`/_next/data/${buildId}/pages-router/unknown.json`);
  assert.equal(
    getRequiredHeader(unknownData, 'x-bun-route-kind'),
    'not-found'
  );
  assertDocumentCacheControl(
    unknownData,
    `/_next/data/${buildId}/pages-router/unknown.json`
  );
}

async function validateRscAndSegmentRscRouting(): Promise<void> {
  const rscResponse = await invokeRuntime('/app-router/static', {
    headers: {
      rsc: '1',
    },
  });
  assert.equal(getRequiredHeader(rscResponse, 'x-bun-route-kind'), 'prerender');
  assertRouteId(rscResponse, '/app-router/static.rsc');
  assertDocumentCacheControl(rscResponse, '/app-router/static (RSC)');
  const rscPayload = await parseJsonResponse<{
    matchedPathname?: string;
  }>(rscResponse);
  assert.equal(rscPayload.matchedPathname, '/app-router/static.rsc');

  const segmentResponse = await invokeRuntime('/app-router/static', {
    headers: {
      rsc: '1',
      'next-router-segment-prefetch': 'app-router/static/__PAGE__',
    },
  });
  assert.equal(
    getRequiredHeader(segmentResponse, 'x-bun-route-kind'),
    'prerender'
  );
  assertRouteId(
    segmentResponse,
    '/app-router/static.segments/app-router/static/__PAGE__.segment.rsc'
  );
  assertDocumentCacheControl(
    segmentResponse,
    '/app-router/static (segment RSC)'
  );
  const segmentPayload = await parseJsonResponse<{
    matchedPathname?: string;
  }>(segmentResponse);
  assert.equal(
    segmentPayload.matchedPathname,
    '/app-router/static.segments/app-router/static/__PAGE__.segment.rsc'
  );

  const dynamicRscResponse = await invokeRuntime('/app-router/isr-dynamic/zeta', {
    headers: {
      rsc: '1',
      'next-router-state-tree': 'fixture-tree',
      'next-router-segment-prefetch': 'app-router/isr-dynamic/$d$slug/__PAGE__',
    },
  });
  assert.equal(
    getRequiredHeader(dynamicRscResponse, 'x-bun-route-kind'),
    'prerender'
  );
  assertRouteId(dynamicRscResponse, '/app-router/isr-dynamic/[slug].rsc');
  assertDocumentCacheControl(dynamicRscResponse, '/app-router/isr-dynamic/zeta (RSC)');
  const dynamicRscPayload = await parseJsonResponse<InvocationPayload>(
    dynamicRscResponse
  );
  assert.equal(dynamicRscPayload.requestRscHeader, '1');
  assert.equal(dynamicRscPayload.requestNextRouterStateTree, 'fixture-tree');
  assert.equal(
    dynamicRscPayload.requestNextRouterSegmentPrefetch,
    'app-router/isr-dynamic/$d$slug/__PAGE__'
  );
}

async function validateDynamicSsrAndIsrRoutes(): Promise<void> {
  const appDynamic = await invokeRuntime('/app-router/ssr-dynamic/alpha');
  assert.equal(getRequiredHeader(appDynamic, 'x-bun-route-kind'), 'function');
  assertRouteId(appDynamic, '/app-router/ssr-dynamic/[slug]');
  assertDocumentCacheControl(appDynamic, '/app-router/ssr-dynamic/alpha');
  const appDynamicPayload = await parseJsonResponse<InvocationPayload>(appDynamic);
  assert.equal(appDynamicPayload.outputId, '/app-router/ssr-dynamic/[slug]');

  const pagesDynamic = await invokeRuntime('/pages-router/ssr-dynamic/alpha');
  assert.equal(
    getRequiredHeader(pagesDynamic, 'x-bun-route-kind'),
    'function'
  );
  assertRouteId(pagesDynamic, '/pages-router/ssr-dynamic/[id]');
  assertDocumentCacheControl(pagesDynamic, '/pages-router/ssr-dynamic/alpha');
  const pagesDynamicPayload = await parseJsonResponse<InvocationPayload>(
    pagesDynamic
  );
  assert.equal(pagesDynamicPayload.outputId, '/pages-router/ssr-dynamic/[id]');

  const appIsrFirst = await invokeRuntime('/app-router/isr-dynamic/alpha');
  assert.equal(
    getRequiredHeader(appIsrFirst, 'x-bun-route-kind'),
    'prerender'
  );
  assertRouteId(appIsrFirst, '/app-router/isr-dynamic/alpha');
  assert.equal(getRequiredHeader(appIsrFirst, 'x-bun-cache'), 'MISS');

  const appIsrSecond = await invokeRuntime('/app-router/isr-dynamic/alpha');
  assert.equal(
    getRequiredHeader(appIsrSecond, 'x-bun-route-kind'),
    'prerender'
  );
  assertRouteId(appIsrSecond, '/app-router/isr-dynamic/alpha');
  assert.equal(getRequiredHeader(appIsrSecond, 'x-bun-cache'), 'HIT');
}

async function validatePagesStaticRouteIsNotIsr(): Promise<void> {
  assert.ok(
    manifest.staticAssets.some((asset) => asset.pathname === '/pages-router/static'),
    'Expected /pages-router/static to be emitted as a static asset'
  );
  assert.ok(
    !manifest.prerenderSeeds.some((seed) => seed.pathname === '/pages-router/static'),
    'Expected /pages-router/static not to be emitted as a prerender seed'
  );

  const first = await invokeRuntime('/pages-router/static');
  assert.equal(
    getRequiredHeader(first, 'x-bun-route-kind'),
    'static'
  );
  assert.equal(
    first.headers.get('x-bun-cache'),
    null,
    'Static pages should not return prerender cache state headers'
  );
  const firstPayload = await parseJsonResponse<{
    kind: string;
    assetId: string;
    matchedPathname: string;
  }>(first);
  assert.equal(firstPayload.kind, 'static');
  assert.equal(firstPayload.matchedPathname, '/pages-router/static');

  const second = await invokeRuntime('/pages-router/static');
  assert.equal(
    getRequiredHeader(second, 'x-bun-route-kind'),
    'static'
  );
  assert.equal(
    second.headers.get('x-bun-cache'),
    null,
    'Static pages should not be treated as ISR/prerender responses'
  );
}

async function validateHtmlRouteCacheControlPolicy(): Promise<void> {
  const htmlStaticAssets = manifest.staticAssets.filter((asset) =>
    asset.sourcePath.endsWith('.html')
  );
  assert.ok(
    htmlStaticAssets.length > 0,
    'Expected fixture to emit at least one static HTML asset'
  );
  for (const asset of htmlStaticAssets) {
    assert.equal(
      asset.cacheControl,
      HTML_ROUTE_CACHE_CONTROL,
      `Expected static HTML asset "${asset.pathname}" to use ${HTML_ROUTE_CACHE_CONTROL}`
    );
  }

  const htmlFallbackSeeds = manifest.prerenderSeeds.filter((seed) =>
    seed.fallback?.sourcePath?.endsWith('.html')
  );
  assert.ok(
    htmlFallbackSeeds.length > 0,
    'Expected fixture to emit prerender HTML fallback seeds'
  );
  for (const seed of htmlFallbackSeeds) {
    const cacheControl = readSingleHeaderValue(
      seed.fallback?.initialHeaders ?? null,
      'cache-control'
    );
    assert.equal(
      cacheControl,
      HTML_ROUTE_CACHE_CONTROL,
      `Expected prerender HTML fallback "${seed.pathname}" to use ${HTML_ROUTE_CACHE_CONTROL}`
    );
  }
}

async function validateManualPathAndTagRevalidate(): Promise<void> {
  const beforeManual = await invokeRuntime('/pages-router/ssg');
  const beforeManualPayload = await parseJsonResponse<InvocationPayload>(
    beforeManual
  );

  const manualPathRevalidate = await invokeRuntime('/_next/revalidate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      path: '/pages-router/ssg',
      token: REVALIDATE_TOKEN,
    }),
  });
  assert.equal(manualPathRevalidate.status, 202);
  const manualPathPayload = await parseJsonResponse<{
    accepted: boolean;
    dispatched: number;
  }>(manualPathRevalidate);
  assert.equal(manualPathPayload.accepted, true);
  assert.ok(manualPathPayload.dispatched > 0);

  const afterManual = await invokeRuntime('/pages-router/ssg');
  const afterManualPayload = await parseJsonResponse<InvocationPayload>(
    afterManual
  );
  assert.ok(afterManualPayload.invocation > beforeManualPayload.invocation);

  await invokeRuntime('/app-router/cache-tag');

  const manualTagRevalidate = await invokeRuntime('/_next/revalidate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      tag: 'app-router-tag',
      token: REVALIDATE_TOKEN,
    }),
  });
  assert.equal(manualTagRevalidate.status, 202);
  const manualTagPayload = await parseJsonResponse<{
    accepted: boolean;
    dispatched: number;
  }>(manualTagRevalidate);
  assert.equal(manualTagPayload.accepted, true);
  assert.ok(
    manualTagPayload.dispatched > 0,
    'Expected manual tag revalidate to dispatch at least one regeneration task'
  );

  const profileTagRevalidate = await invokeRuntime('/_next/revalidate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      tag: 'app-router-tag',
      profile: 'max',
      token: REVALIDATE_TOKEN,
    }),
  });
  assert.equal(profileTagRevalidate.status, 202);
  const profileTagPayload = await parseJsonResponse<{
    accepted: boolean;
    tagMode: 'stale' | 'expire';
    tagProfile?: string;
    tagExpireSeconds?: number;
  }>(profileTagRevalidate);
  assert.equal(profileTagPayload.accepted, true);
  assert.equal(profileTagPayload.tagMode, 'stale');
  assert.equal(profileTagPayload.tagProfile, 'max');
  assert.ok(
    typeof profileTagPayload.tagExpireSeconds === 'number' &&
      profileTagPayload.tagExpireSeconds > 0,
    'Expected profile-based revalidateTag to resolve a finite expire duration'
  );
}

async function validateTagProfilesAndPathInvalidation(): Promise<void> {
  await invokeRuntime('/app-router/cache-tag');
  const cacheTagHit = await invokeRuntime('/app-router/cache-tag');
  assert.equal(getRequiredHeader(cacheTagHit, 'x-bun-cache'), 'HIT');
  const cacheTagHitPayload = await parseJsonResponse<InvocationPayload>(
    cacheTagHit
  );

  await sleep(5);
  await prerenderStore.updateTagManifest?.(['app-router-tag'], {
    mode: 'stale',
    now: Date.now(),
    expireSeconds: 120,
  });

  const staleTagResponse = await invokeRuntime('/app-router/cache-tag');
  assert.equal(
    getRequiredHeader(staleTagResponse, 'x-bun-cache'),
    'STALE'
  );
  const staleTagPayload = await parseJsonResponse<InvocationPayload>(
    staleTagResponse
  );
  assert.equal(
    staleTagPayload.invocation,
    cacheTagHitPayload.invocation,
    'Stale tag response should serve cached payload before background regeneration'
  );

  const refreshedTagResponse = await invokeRuntime('/app-router/cache-tag');
  const refreshedTagPayload = await parseJsonResponse<InvocationPayload>(
    refreshedTagResponse
  );
  assert.ok(
    refreshedTagPayload.invocation > cacheTagHitPayload.invocation,
    'Expected stale tag regeneration to refresh cache entry'
  );

  await sleep(5);
  await prerenderStore.updateTagManifest?.(['app-router-tag'], {
    mode: 'expire',
  });

  const expiredTagResponse = await invokeRuntime('/app-router/cache-tag');
  assert.equal(
    getRequiredHeader(expiredTagResponse, 'x-bun-cache'),
    'MISS'
  );

  const afterExpiredTagRefresh = await invokeRuntime('/app-router/cache-tag');
  assert.equal(
    getRequiredHeader(afterExpiredTagRefresh, 'x-bun-cache'),
    'HIT'
  );
  const expiredTagPayload = await parseJsonResponse<InvocationPayload>(
    afterExpiredTagRefresh
  );
  assert.ok(
    expiredTagPayload.invocation > refreshedTagPayload.invocation,
    'Expected expired tag invalidation to regenerate cache entry'
  );

  await invokeRuntime('/app-router/cache-path');
  const cachePathHit = await invokeRuntime('/app-router/cache-path');
  assert.equal(getRequiredHeader(cachePathHit, 'x-bun-cache'), 'HIT');
  const cachePathHitPayload = await parseJsonResponse<InvocationPayload>(
    cachePathHit
  );

  await sleep(5);
  await prerenderStore.updateTagManifest?.(toImplicitPathTags('/app-router/cache-path'), {
    mode: 'expire',
  });

  const cachePathAfterRevalidatePath = await invokeRuntime('/app-router/cache-path');
  assert.equal(
    getRequiredHeader(cachePathAfterRevalidatePath, 'x-bun-cache'),
    'MISS'
  );
  const cachePathAfterRefresh = await invokeRuntime('/app-router/cache-path');
  assert.equal(
    getRequiredHeader(cachePathAfterRefresh, 'x-bun-cache'),
    'HIT'
  );
  const cachePathAfterPayload = await parseJsonResponse<InvocationPayload>(
    cachePathAfterRefresh
  );
  assert.ok(
    cachePathAfterPayload.invocation > cachePathHitPayload.invocation,
    'Expected implicit path tag invalidation to regenerate cache-path prerender'
  );
}

async function validateCacheTagHeadersAreInternalOnly(): Promise<void> {
  const appRoute = await invokeRuntime('/api/app-static');
  assert.equal(
    appRoute.headers.get('x-next-cache-tags'),
    null,
    'App route responses must not expose x-next-cache-tags to end users'
  );

  const appPageMiss = await invokeRuntime('/app-router/cache-tag');
  assert.equal(
    appPageMiss.headers.get('x-next-cache-tags'),
    null,
    'App router prerender responses must not expose x-next-cache-tags to end users'
  );

  const appPageHit = await invokeRuntime('/app-router/cache-tag');
  assert.equal(
    appPageHit.headers.get('x-next-cache-tags'),
    null,
    'Cached app router responses must not expose x-next-cache-tags to end users'
  );
}

async function validateServerActionBypass(): Promise<void> {
  await invokeRuntime('/app-router/static');
  const staticHit = await invokeRuntime('/app-router/static');
  assert.equal(getRequiredHeader(staticHit, 'x-bun-cache'), 'HIT');
  const staticHitPayload = await parseJsonResponse<InvocationPayload>(staticHit);

  const nextActionBypass = await invokeRuntime('/app-router/static', {
    method: 'POST',
    headers: {
      'next-action': 'fixture-action-id',
    },
    body: JSON.stringify({ action: true }),
  });
  assert.equal(
    getRequiredHeader(nextActionBypass, 'x-bun-cache'),
    'BYPASS'
  );
  const nextActionBypassPayload = await parseJsonResponse<InvocationPayload>(
    nextActionBypass
  );
  assert.equal(nextActionBypassPayload.outputId, '/app-router/static');
  assert.equal(nextActionBypassPayload.source, 'prerender-parent');
  assert.equal(nextActionBypassPayload.requestMethod, 'POST');
  assert.equal(nextActionBypassPayload.requestNextAction, 'fixture-action-id');
  assert.ok(
    nextActionBypassPayload.requestContentType === null ||
      nextActionBypassPayload.requestContentType === 'text/plain;charset=UTF-8',
    'Expected forwarded next-action request to preserve optional content-type'
  );
  assert.equal(nextActionBypassPayload.requestBody, '{"action":true}');
  assert.ok(
    nextActionBypassPayload.invocation > staticHitPayload.invocation,
    'Expected next-action header to bypass prerender cache'
  );

  const multipartBypass = await invokeRuntime('/app-router/static', {
    method: 'POST',
    headers: {
      'content-type': 'multipart/form-data; boundary=fixture',
    },
    body: '--fixture\r\n\r\n',
  });
  assert.equal(
    getRequiredHeader(multipartBypass, 'x-bun-cache'),
    'BYPASS'
  );
  const multipartBypassPayload = await parseJsonResponse<InvocationPayload>(
    multipartBypass
  );
  assert.equal(multipartBypassPayload.outputId, '/app-router/static');
  assert.equal(multipartBypassPayload.source, 'prerender-parent');
  assert.equal(multipartBypassPayload.requestMethod, 'POST');
  assert.equal(
    multipartBypassPayload.requestContentType,
    'multipart/form-data; boundary=fixture'
  );
  assert.equal(multipartBypassPayload.requestBody, '--fixture\r\n\r\n');
}

async function validatePreviewBypassCookie(): Promise<void> {
  const appStaticSeed = manifest.prerenderSeeds.find(
    (seed) => seed.pathname === '/app-router/static'
  );
  assert.ok(appStaticSeed, 'Expected /app-router/static prerender seed');
  const bypassToken = (appStaticSeed.config as Record<string, unknown>).bypassToken;
  assert.ok(
    typeof bypassToken === 'string' && bypassToken.length > 0,
    'Expected prerender bypass token for preview-mode bypass checks'
  );

  const warmHit = await invokeRuntime('/app-router/static');
  assert.equal(getRequiredHeader(warmHit, 'x-bun-cache'), 'HIT');
  const warmPayload = await parseJsonResponse<InvocationPayload>(warmHit);

  const previewBypass = await invokeRuntime('/app-router/static?bypass-variant=1', {
    headers: {
      cookie: `__prerender_bypass=${bypassToken}`,
      'x-test-bypass': 'preview-on',
    },
  });
  assert.equal(
    getRequiredHeader(previewBypass, 'x-bun-cache'),
    'BYPASS'
  );
  const previewPayload = await parseJsonResponse<InvocationPayload>(previewBypass);
  assert.ok(
    previewPayload.invocation > warmPayload.invocation,
    'Expected __prerender_bypass cookie to bypass prerender cache'
  );
  assert.ok(
    previewPayload.requestUrl.includes('/app-router/static?bypass-variant=1'),
    'Expected bypass request to preserve original query string for function invocation'
  );
  assert.equal(
    previewPayload.requestBypassHeader,
    'preview-on',
    'Expected bypass request to preserve non-allowlisted headers for function invocation'
  );
  assert.equal(
    previewPayload.requestCookie,
    `__prerender_bypass=${bypassToken}`,
    'Expected bypass request to preserve __prerender_bypass cookie for function invocation'
  );
}

async function validatePreviouslyRevalidatedTagHeaders(): Promise<void> {
  const bypassToken = manifest.prerenderSeeds.reduce<string | null>((token, seed) => {
    if (token) {
      return token;
    }
    const candidate = (seed.config as Record<string, unknown>).bypassToken;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
  }, null);
  assert.ok(
    typeof bypassToken === 'string' && bypassToken.length > 0,
    'Expected prerender bypass token to be present in deployment manifest'
  );

  await invokeRuntime('/app-router/cache-tag');
  const warmHit = await invokeRuntime('/app-router/cache-tag');
  assert.equal(getRequiredHeader(warmHit, 'x-bun-cache'), 'HIT');
  const warmPayload = await parseJsonResponse<InvocationPayload>(warmHit);

  const taggedRequest = await invokeRuntime('/app-router/cache-tag', {
    headers: {
      'x-next-revalidated-tags': 'app-router-tag',
      'x-next-revalidate-tag-token': bypassToken,
    },
  });
  assert.equal(
    getRequiredHeader(taggedRequest, 'x-bun-cache'),
    'MISS'
  );

  const refreshedHit = await invokeRuntime('/app-router/cache-tag');
  assert.equal(
    getRequiredHeader(refreshedHit, 'x-bun-cache'),
    'HIT'
  );
  const refreshedPayload = await parseJsonResponse<InvocationPayload>(refreshedHit);
  assert.ok(
    refreshedPayload.invocation > warmPayload.invocation,
    'Expected previously revalidated tags header to invalidate matching cache entries'
  );
}

async function validateRewriteToNextStaticStillUsesRouting(): Promise<void> {
  const staticAsset = getNextStaticAssetFromManifest();
  let middlewareCalls = 0;
  let staticCalls = 0;
  const configRewriteRuntime = createRouterRuntime({
    manifest,
    invokeMiddleware: async (ctx) => {
      middlewareCalls += 1;
      const requestHeaders = new Headers(ctx.headers);
      if (ctx.url.pathname === '/middleware-static-rewrite') {
        return {
          requestHeaders,
          responseHeaders: new Headers({
            'x-middleware-next': '1',
          }),
          rewrite: new URL(staticAsset.pathname, ctx.url),
        };
      }
      return {
        requestHeaders,
        responseHeaders: new Headers({
          'x-middleware-next': '1',
        }),
      };
    },
    serveStatic: async ({ matchedPathname }) => {
      staticCalls += 1;
      return new Response(matchedPathname, { status: 200 });
    },
    invokeFunction: async ({ output, matchedPathname }) =>
      new Response(`function:${output.id}:${matchedPathname}`, { status: 200 }),
  });

  const response = await configRewriteRuntime.handleRequest(
    new Request(new URL('/middleware-static-rewrite', ORIGIN))
  );
  assert.equal(response.status, 200);
  assert.equal(getRequiredHeader(response, 'x-bun-route-kind'), 'static');
  assert.equal(
    getRequiredHeader(response, 'x-bun-route-id'),
    staticAsset.id
  );
  assert.equal(
    await response.text(),
    staticAsset.pathname,
    'Expected middleware rewrite to _next/static asset pathname to route through static dispatch'
  );
  assert.equal(middlewareCalls, 1);
  assert.equal(staticCalls, 1);
}

async function validateRevalidateTaskAllowListPropagation(): Promise<void> {
  const { manifest: allowListManifest, seed } = createAllowListVariantManifest(
    '/pages-router/ssg'
  );
  const revalidateStore = new InMemoryPrerenderCacheStore();
  const invokedRequests: Request[] = [];

  const allowListInvokeFunction = async (ctx: FunctionRouteDispatchContext) => {
    invokedRequests.push(ctx.request.clone());
    return new Response('ok', {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-next-cache-tags': 'allow-list-tag',
      },
    });
  };

  const allowListRevalidateQueue = createBunRevalidateQueue({
    manifest: allowListManifest,
    invokeFunction: allowListInvokeFunction,
    prerenderCacheStore: revalidateStore,
    requestOrigin: ORIGIN,
  });

  const runtimeWithAllowList = createRouterRuntime({
    manifest: allowListManifest,
    serveStatic: async (ctx) => {
      return new Response(ctx.asset.id, { status: 200 });
    },
    invokeFunction: allowListInvokeFunction,
    prerenderCache: {
      store: revalidateStore,
      revalidateQueue: allowListRevalidateQueue,
    },
    revalidateAuthToken: REVALIDATE_TOKEN,
  });

  const variantRequest = new Request(new URL('/pages-router/ssg?variant=blue', ORIGIN), {
    headers: {
      host: 'fixture.local',
      'x-variant': 'blue',
    },
  });
  const variantCacheKey = createPrerenderCacheKey(seed, variantRequest);
  const initialCreatedAt = Date.now() - 5_000;
  await revalidateStore.set(variantCacheKey.key, {
    cacheKey: variantCacheKey.key,
    pathname: variantCacheKey.pathname,
    groupId: seed.groupId,
    cacheQuery: variantCacheKey.query,
    cacheHeaders: variantCacheKey.headers,
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
    body: Buffer.from('stale-variant').toString('base64'),
    bodyEncoding: 'base64',
    createdAt: initialCreatedAt,
    revalidateAt: Date.now() - 1_000,
    expiresAt: null,
  });

  const staleResponse = await runtimeWithAllowList.handleRequest(variantRequest);
  assert.equal(staleResponse.headers.get('x-bun-cache'), 'STALE');

  // Wait for background revalidation to complete
  await sleep(100);

  assert.ok(
    invokedRequests.length > 0,
    'Expected stale revalidation task to invoke parent output'
  );
  const inlineTaskRequest = invokedRequests[0];
  assert.ok(inlineTaskRequest, 'Expected stale revalidation invocation request');
  assert.equal(
    new URL(inlineTaskRequest.url).searchParams.get('variant'),
    'blue',
    'Expected inline revalidate task to preserve allowQuery values'
  );
  assert.equal(
    inlineTaskRequest.headers.get('x-variant'),
    'blue',
    'Expected inline revalidate task to preserve allowHeader values'
  );
  const refreshedEntry = await revalidateStore.get(variantCacheKey.key);
  assert.ok(refreshedEntry, 'Expected stale variant key to be refreshed in cache');
  assert.ok(
    (refreshedEntry?.createdAt ?? 0) > initialCreatedAt,
    'Expected stale revalidation to write refreshed content using the same variant cache key'
  );
}

function createAllowListVariantManifest(pathname: string): {
  manifest: BunDeploymentManifest;
  seed: BunDeploymentManifest['prerenderSeeds'][number];
} {
  const nextManifest = JSON.parse(
    JSON.stringify(manifest)
  ) as BunDeploymentManifest;
  const seed = nextManifest.prerenderSeeds.find((item) => item.pathname === pathname);
  assert.ok(seed, `Expected prerender seed for "${pathname}"`);

  const seedConfig = seed.config as Record<string, unknown>;
  const allowHeaders = new Set<string>(
    Array.isArray(seedConfig.allowHeader)
      ? seedConfig.allowHeader.filter((entry): entry is string => typeof entry === 'string')
      : []
  );
  allowHeaders.add('x-variant');
  seedConfig.allowHeader = [...allowHeaders].sort((left, right) =>
    left.localeCompare(right)
  );
  seedConfig.allowQuery = ['variant'];

  return {
    manifest: nextManifest,
    seed,
  };
}

async function validateDraftModeEnableAndDisable(): Promise<void> {
  // POST to enable draft mode should route to /api/draft-mode function
  const enableResponse = await invokeRuntime('/api/draft-mode', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enableResponse.status, 200);
  assertRouteId(enableResponse, '/api/draft-mode');
  const enablePayload = await parseJsonResponse<InvocationPayload>(enableResponse);
  assert.equal(enablePayload.outputId, '/api/draft-mode');
  assert.equal(enablePayload.requestMethod, 'POST');
  assert.equal(enablePayload.requestContentType, 'application/json');
  assert.equal(
    enablePayload.requestBody,
    '{"enabled":true}',
    'Expected POST body to be forwarded to draft-mode handler'
  );

  // GET should route to the same draft-mode API function
  const getResponse = await invokeRuntime('/api/draft-mode');
  assert.equal(getResponse.status, 200);
  assertRouteId(getResponse, '/api/draft-mode');
  const getPayload = await parseJsonResponse<InvocationPayload>(getResponse);
  assert.equal(getPayload.outputId, '/api/draft-mode');
  assert.equal(getPayload.requestMethod, 'GET');

  // POST to disable draft mode should also route correctly
  const disableResponse = await invokeRuntime('/api/draft-mode', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableResponse.status, 200);
  assertRouteId(disableResponse, '/api/draft-mode');
  const disablePayload = await parseJsonResponse<InvocationPayload>(disableResponse);
  assert.equal(disablePayload.requestMethod, 'POST');
  assert.equal(
    disablePayload.requestBody,
    '{"enabled":false}',
    'Expected POST body with enabled:false to be forwarded'
  );

  // Draft mode with __prerender_bypass cookie should bypass prerender cache
  // and still route to the correct function
  const appStaticSeed = manifest.prerenderSeeds.find(
    (seed) => seed.pathname === '/app-router/static'
  );
  assert.ok(appStaticSeed, 'Expected /app-router/static prerender seed');
  const bypassToken = (appStaticSeed.config as Record<string, unknown>).bypassToken;
  assert.ok(typeof bypassToken === 'string' && bypassToken.length > 0);

  // Warm the cache first
  await invokeRuntime('/app-router/dynamic');

  // With __prerender_bypass cookie, should bypass cache and hit function directly
  const draftBypass = await invokeRuntime('/app-router/dynamic', {
    headers: {
      cookie: `__prerender_bypass=${bypassToken}`,
    },
  });
  assert.equal(draftBypass.status, 200);
  assertRouteId(draftBypass, '/app-router/dynamic');
  const draftBypassPayload = await parseJsonResponse<InvocationPayload>(draftBypass);
  assert.equal(draftBypassPayload.outputId, '/app-router/dynamic');
  assert.equal(
    draftBypassPayload.requestCookie,
    `__prerender_bypass=${bypassToken}`,
    'Expected draft mode bypass cookie to be forwarded to function'
  );
}

async function validateNextImageRouting(): Promise<void> {
  const imageCountBefore = imageInvocations.length;

  // _next/image with valid params should route to the image handler
  const imageResponse = await invokeRuntime(
    '/_next/image?url=%2Fimages%2Fnextjs-logo.png&w=640&q=75'
  );
  assert.equal(imageResponse.status, 200);
  assert.equal(
    getRequiredHeader(imageResponse, 'x-bun-route-kind'),
    'image'
  );
  assert.equal(
    imageInvocations.length,
    imageCountBefore + 1,
    'Expected _next/image request to invoke the image handler'
  );
  const imagePayload = imageInvocations[imageInvocations.length - 1]!;
  assert.equal(imagePayload.urlParam, '/images/nextjs-logo.png');
  assert.equal(imagePayload.wParam, '640');
  assert.equal(imagePayload.qParam, '75');

  // _next/image without url param should still route to image handler
  const noUrlResponse = await invokeRuntime('/_next/image?w=640&q=75');
  assert.equal(noUrlResponse.status, 200);
  assert.equal(
    getRequiredHeader(noUrlResponse, 'x-bun-route-kind'),
    'image'
  );
  assert.equal(
    imageInvocations.length,
    imageCountBefore + 2,
    'Expected _next/image without url to still route to image handler'
  );
  assert.equal(imageInvocations[imageInvocations.length - 1]!.urlParam, null);

  // _next/image with different widths and qualities
  const variantResponse = await invokeRuntime(
    '/_next/image?url=%2Fimages%2Fnextjs-logo.png&w=1080&q=70'
  );
  assert.equal(variantResponse.status, 200);
  assert.equal(
    getRequiredHeader(variantResponse, 'x-bun-route-kind'),
    'image'
  );
  const variantPayload = imageInvocations[imageInvocations.length - 1]!;
  assert.equal(variantPayload.wParam, '1080');
  assert.equal(variantPayload.qParam, '70');

  // Verify IMAGE_ROUTE_PATH matches manifest basePath
  assert.equal(
    IMAGE_ROUTE_PATH,
    '/_next/image',
    'Expected toImageRoutePath to return /_next/image for empty basePath'
  );
}

// --- Test Runner ---

interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

const tests: TestCase[] = [
  { name: 'Route graph from next.config', fn: validateRouteGraphFromNextConfig },
  { name: 'Middleware and rewrite ordering', fn: validateMiddlewareAndRewriteOrdering },
  { name: 'Redirect from next.config', fn: validateRedirectFromNextConfig },
  { name: 'Request headers not echoed to response', fn: validateRequestHeadersAreNotEchoedToResponse },
  { name: 'Pages prerender and on-demand revalidate', fn: validatePagesPrerenderAndOnDemandRevalidate },
  { name: 'Next data routes', fn: validateNextDataRoutes },
  { name: 'RSC and segment RSC routing', fn: validateRscAndSegmentRscRouting },
  { name: 'Dynamic SSR and ISR routes', fn: validateDynamicSsrAndIsrRoutes },
  { name: 'Pages static route is not ISR', fn: validatePagesStaticRouteIsNotIsr },
  { name: 'HTML route cache-control policy', fn: validateHtmlRouteCacheControlPolicy },
  { name: 'Manual path and tag revalidate', fn: validateManualPathAndTagRevalidate },
  { name: 'Tag profiles and path invalidation', fn: validateTagProfilesAndPathInvalidation },
  { name: 'Cache tag headers are internal only', fn: validateCacheTagHeadersAreInternalOnly },
  { name: 'Server action bypass', fn: validateServerActionBypass },
  { name: 'Preview bypass cookie', fn: validatePreviewBypassCookie },
  { name: 'Previously revalidated tag headers', fn: validatePreviouslyRevalidatedTagHeaders },
  { name: 'Rewrite to _next/static uses routing', fn: validateRewriteToNextStaticStillUsesRouting },
  { name: 'Revalidate task allow-list propagation', fn: validateRevalidateTaskAllowListPropagation },
  { name: 'Draft mode enable and disable', fn: validateDraftModeEnableAndDisable },
  { name: '_next/image routing', fn: validateNextImageRouting },
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`  PASS  ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${test.name}`);
    console.error(
      `        ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);

if (failed > 0) {
  process.exit(1);
}
