import type { NextAdapter } from 'next';
import {
  ADAPTER_NAME,
  createBunAdapter,
  DEFAULT_BUN_ADAPTER_OUT_DIR,
} from './src/adapter.ts';
import {
  InMemoryPrerenderCacheStore,
  createPrerenderCacheKey,
  evaluatePrerenderCacheEntry,
  prerenderCacheEntryToResponse,
  responseToPrerenderCacheEntry,
  shouldBypassPrerenderCache,
  toImplicitPathTags,
} from './src/runtime/isr.ts';
import {
  InMemoryImageCacheStore,
  createImageCacheKey,
  createBunImageHandler,
  defaultShouldCacheImageResponse,
  evaluateImageCacheEntry,
  imageCacheEntryToResponse,
  isImageOptimizationPath,
  responseToImageCacheEntry,
  shouldBypassImageCache,
  toImageRoutePath,
} from './src/runtime/image.ts';
import {
  SqlitePrerenderCacheStore,
  SqliteImageCacheStore,
  createSqliteCacheStores,
} from './src/runtime/sqlite-cache.ts';
import { createFunctionArtifactInvoker } from './src/runtime/function-invoker.ts';
import { createBunStaticHandler } from './src/runtime/static.ts';
import { createBunRevalidateQueue } from './src/runtime/revalidate.ts';
import { createRouterRuntime } from './src/runtime/router.ts';

const bunAdapter: NextAdapter = createBunAdapter();

export default bunAdapter;
export {
  ADAPTER_NAME,
  DEFAULT_BUN_ADAPTER_OUT_DIR,
  bunAdapter,
  createBunAdapter,
  createRouterRuntime,
  createPrerenderCacheKey,
  evaluatePrerenderCacheEntry,
  responseToPrerenderCacheEntry,
  prerenderCacheEntryToResponse,
  shouldBypassPrerenderCache,
  toImplicitPathTags,
  InMemoryPrerenderCacheStore,
  createImageCacheKey,
  evaluateImageCacheEntry,
  responseToImageCacheEntry,
  imageCacheEntryToResponse,
  shouldBypassImageCache,
  defaultShouldCacheImageResponse,
  isImageOptimizationPath,
  toImageRoutePath,
  InMemoryImageCacheStore,
  createBunImageHandler,
  SqlitePrerenderCacheStore,
  SqliteImageCacheStore,
  createSqliteCacheStores,
  createFunctionArtifactInvoker,
  createBunStaticHandler,
  createBunRevalidateQueue,
};
export type {
  BunAdapterOptions,
  BunDeploymentManifest,
  BunFunctionArtifact,
  BunPrerenderSeed,
  BunRouterManifest,
  BunStaticAsset,
} from './src/types.ts';
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
  ImageCacheableResponse,
  ImageCacheEntry,
  ImageCacheEvaluation,
  ImageCacheKey,
  ImageCacheRuntimeOptions,
  ImageCacheState,
  ImageCacheStore,
  ExternalRewriteContext,
  FunctionRouteDispatchContext,
  ImageRouteDispatchContext,
  NotFoundDispatchContext,
  PrerenderRouteDispatchContext,
  RouterMiddlewareResult,
  RouterRouteKind,
  RouterRuntime,
  RouterRuntimeHandlers,
  RouterRuntimeOptions,
  StaticRouteDispatchContext,
} from './src/runtime/types.ts';
export type {
  CreateFunctionArtifactInvokerOptions,
} from './src/runtime/function-invoker.ts';
export type {
  BunRevalidateQueueOptions,
} from './src/runtime/revalidate.ts';
export type {
  BunImageHandlerOptions,
} from './src/runtime/image.ts';
export type {
  SqliteCacheOptions,
} from './src/runtime/sqlite-cache.ts';
