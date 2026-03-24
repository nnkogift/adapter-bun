import type { NextUseCacheHandler } from '../next-compat-types.js';

const handlersSymbol = Symbol.for('@next/cache-handlers');

type GlobalCacheHandlersReference = typeof globalThis & {
  [handlersSymbol]?: {
    DefaultCache?: NextUseCacheHandler;
    RemoteCache?: NextUseCacheHandler;
  };
};

export function registerGlobalCacheHandlers(
  cacheHandler: NextUseCacheHandler
): void {
  const reference = globalThis as GlobalCacheHandlersReference;
  const existing = reference[handlersSymbol] ?? {};

  reference[handlersSymbol] = {
    ...existing,
    DefaultCache: cacheHandler,
    RemoteCache: cacheHandler,
  };
}
