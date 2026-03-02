import type {
  MiddlewareContext,
  MiddlewareResult,
  ResolveRoutesResult,
} from '@next/routing';
import type {
  BunDeploymentManifest,
  BunFunctionArtifact,
  BunPrerenderSeed,
  BunStaticAsset,
} from '../types.ts';
import type {
  PrerenderCacheRuntimeOptions,
  PrerenderCacheState,
} from './isr.ts';
import type { ImageCacheRuntimeOptions } from './image.ts';
export type {
  PrerenderCacheableResponse,
  PrerenderCacheEntry,
  PrerenderCacheEvaluation,
  PrerenderCacheKey,
  PrerenderCacheRuntimeOptions,
  PrerenderCacheState,
  PrerenderCacheStore,
  PrerenderRevalidateQueue,
  PrerenderRevalidateReason,
  PrerenderRevalidateTask,
  PrerenderRevalidateTarget,
  PrerenderTagManifestEntry,
  PrerenderTagManifestUpdate,
} from './isr.ts';
export type {
  ImageCacheableResponse,
  ImageCacheEntry,
  ImageCacheEvaluation,
  ImageCacheKey,
  ImageCacheRuntimeOptions,
  ImageCacheState,
  ImageCacheStore,
} from './image.ts';

export type RouteResolutionResult = ResolveRoutesResult;
export type RouteMatches = Record<string, string | string[]>;

export type RouterRouteKind =
  | 'static'
  | 'function'
  | 'prerender'
  | 'image'
  | 'not-found'
  | 'middleware'
  | 'redirect'
  | 'external-rewrite';

export type RouterMiddlewareResult = MiddlewareResult & {
  response?: Response;
};

export interface RouteDispatchBaseContext {
  request: Request;
  matchedPathname: string;
  routeMatches: RouteMatches | undefined;
  resolution: RouteResolutionResult;
  cacheState?: PrerenderCacheState;
}

export interface StaticRouteDispatchContext extends RouteDispatchBaseContext {
  asset: BunStaticAsset;
  source: 'static';
}

export interface FunctionRouteDispatchContext extends RouteDispatchBaseContext {
  output: BunFunctionArtifact;
  source: 'function' | 'prerender-parent';
  prerenderSeed: BunPrerenderSeed | null;
}

export interface PrerenderRouteDispatchContext extends RouteDispatchBaseContext {
  seed: BunPrerenderSeed;
  parentOutput: BunFunctionArtifact | null;
  source: 'prerender';
}

export interface ImageRouteDispatchContext extends RouteDispatchBaseContext {
  source: 'image';
}

export interface ExternalRewriteContext {
  request: Request;
  resolution: RouteResolutionResult;
  targetUrl: URL;
}

export interface NotFoundDispatchContext {
  request: Request;
  resolution: RouteResolutionResult;
}

export interface RouterRuntimeHandlers {
  invokeMiddleware?: (
    ctx: MiddlewareContext
  ) => Promise<RouterMiddlewareResult> | RouterMiddlewareResult;
  serveStatic: (ctx: StaticRouteDispatchContext) => Promise<Response> | Response;
  invokeFunction: (
    ctx: FunctionRouteDispatchContext
  ) => Promise<Response> | Response;
  invokeImageFunction?: (
    ctx: ImageRouteDispatchContext
  ) => Promise<Response> | Response;
  handlePrerender?: (
    ctx: PrerenderRouteDispatchContext
  ) => Promise<Response> | Response;
  handleExternalRewrite?: (
    ctx: ExternalRewriteContext
  ) => Promise<Response> | Response;
  handleNotFound?: (
    ctx: NotFoundDispatchContext
  ) => Promise<Response> | Response;
}

export interface RouterRuntimeOptions extends RouterRuntimeHandlers {
  manifest: BunDeploymentManifest;
  prerenderCache?: PrerenderCacheRuntimeOptions;
  imageCache?: ImageCacheRuntimeOptions;
  revalidateAuthToken?: string;
  revalidateEndpointPath?: string;
}

export interface RouterRuntime {
  readonly manifest: BunDeploymentManifest;
  handleRequest(request: Request): Promise<Response>;
}
