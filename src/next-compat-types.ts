export type Timestamp = number;

export interface CacheEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];
  stale: number;
  timestamp: Timestamp;
  expire: number;
  revalidate: number;
}

export interface NextUseCacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<undefined | CacheEntry>;
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<Timestamp>;
  updateTags(
    tags: string[],
    durations?: {
      expire?: number;
    }
  ): Promise<void>;
}

export type IncrementalCacheKind =
  | 'APP_PAGE'
  | 'APP_ROUTE'
  | 'PAGES'
  | 'FETCH'
  | 'REDIRECT'
  | 'IMAGE';

export type IncrementalCacheValue = {
  kind: IncrementalCacheKind;
  [key: string]: unknown;
};

export interface GetIncrementalFetchCacheContext {
  kind: 'FETCH';
  revalidate?: number;
  fetchUrl?: string;
  fetchIdx?: number;
  tags?: string[];
  softTags?: string[];
}

export interface GetIncrementalResponseCacheContext {
  kind: Exclude<IncrementalCacheKind, 'FETCH'>;
  isRoutePPREnabled?: boolean;
  isFallback: boolean;
}

export interface SetIncrementalFetchCacheContext {
  fetchCache: true;
  fetchUrl?: string;
  fetchIdx?: number;
  tags?: string[];
  isImplicitBuildTimeCache?: boolean;
}

export interface CacheControlLike {
  revalidate?: number | false;
  expire?: number;
}

export interface SetIncrementalResponseCacheContext {
  fetchCache?: false;
  cacheControl?: CacheControlLike;
  isRoutePPREnabled?: boolean;
  isFallback?: boolean;
}

export interface NextIncrementalCacheHandlerContext {
  revalidatedTags?: string[];
  _requestHeaders?: Record<string, undefined | string | string[]>;
  [key: string]: unknown;
}

export interface NextIncrementalCacheHandlerValue {
  lastModified: number;
  age?: number;
  cacheState?: string;
  value: IncrementalCacheValue | null;
}

export interface NextIncrementalCacheHandler {
  resetRequestCache?(): void;
  get(
    cacheKey: string,
    ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext
  ): Promise<NextIncrementalCacheHandlerValue | null>;
  set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext
  ): Promise<void>;
  revalidateTag(
    tags: string | string[],
    durations?: {
      expire?: number;
    }
  ): Promise<void>;
}
