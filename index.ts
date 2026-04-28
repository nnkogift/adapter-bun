import type { NextAdapter } from 'next';
import {
  ADAPTER_NAME,
  createBunAdapter,
  DEFAULT_BUN_ADAPTER_OUT_DIR,
} from './src/adapter.ts';
import { CONTEXT_PATH_PLACEHOLDER } from './src/context-path.ts';
import {
  SqlitePrerenderCacheStore,
  SqliteImageCacheStore,
  createSqliteCacheStores,
} from './src/runtime/sqlite-cache.ts';

const bunAdapter: NextAdapter = createBunAdapter();

export default bunAdapter;
export {
  ADAPTER_NAME,
  CONTEXT_PATH_PLACEHOLDER,
  DEFAULT_BUN_ADAPTER_OUT_DIR,
  bunAdapter,
  createBunAdapter,
  SqlitePrerenderCacheStore,
  SqliteImageCacheStore,
  createSqliteCacheStores,
};
export type {
  BunAdapterOptions,
  BunDeploymentManifest,
  BunStaticAsset,
} from './src/types.ts';
export type {
  SqliteCacheOptions,
} from './src/runtime/sqlite-cache.ts';
