import { createHash } from 'node:crypto';
import type { PrerenderCacheStore } from './isr.ts';

type FetchCacheEntry = {
  value: unknown;
  tags: string[];
  revalidateAt: number | null;
  createdAt: number;
};

type FetchCacheContext = {
  tags?: string[];
  softTags?: string[];
};

type SetFetchCacheContext = {
  tags?: string[];
  revalidate?: number;
};

type DeferredPromise = {
  promise: Promise<void>;
  resolve: () => void;
};

type NextTagManifestEntry = {
  stale?: number;
  expired?: number;
};

type TagManifestUpdateShape = {
  mode: 'stale' | 'expire';
  now: number;
  expireSeconds?: number;
};

const NEXT_TAG_MANIFEST_MODULE_SPECIFIERS = [
  'next/dist/esm/server/lib/incremental-cache/tags-manifest.external.js',
  'next/dist/server/lib/incremental-cache/tags-manifest.external.js',
];

let nextTagManifestMapsPromise: Promise<Map<string, NextTagManifestEntry>[]> | null =
  null;

export interface EdgeIncrementalCacheBridge {
  get: (cacheKey: string, ctx?: FetchCacheContext) => Promise<{
    isStale?: boolean;
    value: unknown;
    revalidateAfter?: number | false;
    cacheControl?: unknown;
  } | null>;
  set: (
    cacheKey: string,
    data: unknown,
    ctx?: SetFetchCacheContext
  ) => Promise<void>;
  generateCacheKey: (url: string, init?: RequestInit | Request) => Promise<string>;
  lock: (cacheKey: string) => Promise<() => Promise<void> | void>;
  revalidateTag: (
    tags: string | string[],
    durations?: { expire?: number }
  ) => Promise<void>;
  resetRequestCache: () => void;
  isOnDemandRevalidate?: boolean;
}

function normalizeTags(input: string | string[]): string[] {
  const values = Array.isArray(input) ? input : [input];
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function normalizeHeaders(
  headersInput: unknown
): Record<string, string> {
  if (!headersInput) {
    return {};
  }

  const headers = new Headers(headersInput as Headers);
  headers.delete('traceparent');
  headers.delete('tracestate');

  const normalized: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    normalized[key] = value;
  }
  return normalized;
}

function toHashInput({
  url,
  method,
  headers,
  cache,
  mode,
  redirect,
  credentials,
  referrer,
  referrerPolicy,
  integrity,
}: {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  cache: unknown;
  mode: unknown;
  redirect: unknown;
  credentials: unknown;
  referrer: string | undefined;
  referrerPolicy: unknown;
  integrity: string | undefined;
}): string {
  return JSON.stringify([
    'adapter-bun-fetch-cache-v1',
    url,
    method ?? 'GET',
    headers,
    cache ?? null,
    mode ?? null,
    redirect ?? null,
    credentials ?? null,
    referrer ?? null,
    referrerPolicy ?? null,
    integrity ?? null,
  ]);
}

function createDeferredPromise(): DeferredPromise {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolve: resolve ?? (() => {}),
  };
}

async function loadNextTagManifestMaps(): Promise<Map<string, NextTagManifestEntry>[]> {
  if (!nextTagManifestMapsPromise) {
    nextTagManifestMapsPromise = (async () => {
      const manifests: Map<string, NextTagManifestEntry>[] = [];
      for (const specifier of NEXT_TAG_MANIFEST_MODULE_SPECIFIERS) {
        try {
          const mod = (await import(specifier)) as {
            tagsManifest?: unknown;
          };
          const tagsManifest = mod.tagsManifest;
          if (tagsManifest instanceof Map && !manifests.includes(tagsManifest)) {
            manifests.push(tagsManifest as Map<string, NextTagManifestEntry>);
          }
        } catch {
          // Optional module variant is unavailable in this runtime.
        }
      }
      return manifests;
    })();
  }
  return nextTagManifestMapsPromise;
}

async function syncNextTagsManifest({
  tags,
  update,
}: {
  tags: string[];
  update: TagManifestUpdateShape;
}): Promise<void> {
  const manifests = await loadNextTagManifestMaps();
  if (manifests.length === 0) {
    return;
  }

  for (const manifest of manifests) {
    for (const tag of tags) {
      const existing = manifest.get(tag) ?? {};
      if (update.mode === 'stale') {
        const nextEntry: NextTagManifestEntry = {
          ...existing,
          stale: update.now,
        };
        if (typeof update.expireSeconds === 'number') {
          nextEntry.expired = update.now + update.expireSeconds * 1000;
        }
        manifest.set(tag, nextEntry);
      } else {
        manifest.set(tag, {
          ...existing,
          expired: update.now,
        });
      }
    }
  }
}

export function createEdgeIncrementalCache({
  prerenderCacheStore,
  now = () => Date.now(),
}: {
  prerenderCacheStore: PrerenderCacheStore;
  now?: () => number;
}): EdgeIncrementalCacheBridge {
  const fetchCache = new Map<string, FetchCacheEntry>();
  const locks = new Map<string, Promise<void>>();
  const invalidatedTags = new Set<string>();

  return {
    async get(cacheKey: string, ctx?: FetchCacheContext) {
      const entry = fetchCache.get(cacheKey);
      if (!entry) {
        return null;
      }

      const requestedTags = [
        ...(ctx?.tags ?? []),
        ...(ctx?.softTags ?? []),
      ].filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);

      // `softTags` are implicit tags used for revalidation checks and should
      // not be required to exist on the entry itself.
      for (const tag of ctx?.tags ?? []) {
        if (!entry.tags.includes(tag)) {
          return null;
        }
      }

      for (const tag of requestedTags.length > 0 ? requestedTags : entry.tags) {
        if (invalidatedTags.has(tag)) {
          return null;
        }
      }

      const stale =
        typeof entry.revalidateAt === 'number' && now() >= entry.revalidateAt;

      return {
        isStale: stale,
        value: entry.value,
        revalidateAfter: stale
          ? now()
          : entry.revalidateAt === null
            ? false
            : entry.revalidateAt,
      };
    },

    async set(cacheKey: string, data: unknown, ctx?: SetFetchCacheContext): Promise<void> {
      if (data === null || data === undefined) {
        fetchCache.delete(cacheKey);
        return;
      }

      const tags = [...new Set((ctx?.tags ?? []).filter(Boolean))];
      const revalidateSeconds =
        typeof ctx?.revalidate === 'number' && Number.isFinite(ctx.revalidate)
          ? ctx.revalidate
          : null;
      const revalidateAt =
        typeof revalidateSeconds === 'number' && revalidateSeconds > 0
          ? now() + revalidateSeconds * 1000
          : null;

      fetchCache.set(cacheKey, {
        value: data,
        tags,
        revalidateAt,
        createdAt: now(),
      });
    },

    async generateCacheKey(url: string, init: RequestInit | Request = {}): Promise<string> {
      const requestLike = init instanceof Request ? init : undefined;
      const headers = normalizeHeaders(requestLike?.headers ?? init.headers);
      const hashInput = toHashInput({
        url,
        method: requestLike?.method ?? init.method,
        headers,
        cache: requestLike?.cache ?? init.cache,
        mode: requestLike?.mode ?? init.mode,
        redirect: requestLike?.redirect ?? init.redirect,
        credentials: requestLike?.credentials ?? init.credentials,
        referrer: requestLike?.referrer ?? init.referrer,
        referrerPolicy: requestLike?.referrerPolicy ?? init.referrerPolicy,
        integrity: requestLike?.integrity ?? init.integrity,
      });

      return createHash('sha256').update(hashInput).digest('hex');
    },

    async lock(cacheKey: string): Promise<() => Promise<void> | void> {
      while (true) {
        const existing = locks.get(cacheKey);
        if (!existing) {
          break;
        }
        await existing;
      }

      const deferred = createDeferredPromise();
      locks.set(cacheKey, deferred.promise);

      return () => {
        deferred.resolve();
        locks.delete(cacheKey);
      };
    },

    async revalidateTag(
      tagsInput: string | string[],
      durations?: { expire?: number }
    ): Promise<void> {
      const tags = normalizeTags(tagsInput);
      if (tags.length === 0) {
        return;
      }

      for (const tag of tags) {
        invalidatedTags.add(tag);
      }

      for (const [cacheKey, entry] of fetchCache.entries()) {
        if (entry.tags.some((tag) => invalidatedTags.has(tag))) {
          fetchCache.delete(cacheKey);
        }
      }

      const updateTagManifest = prerenderCacheStore.updateTagManifest;
      const timestamp = now();
      if (durations) {
        const update: TagManifestUpdateShape = {
          mode: 'stale',
          now: timestamp,
          expireSeconds: durations.expire,
        };
        await syncNextTagsManifest({
          tags,
          update,
        });
        if (updateTagManifest) {
          await updateTagManifest(tags, update);
        }
        return;
      }

      const update: TagManifestUpdateShape = {
        mode: 'expire',
        now: timestamp,
      };
      await syncNextTagsManifest({
        tags,
        update,
      });
      if (updateTagManifest) {
        await updateTagManifest(tags, update);
      }
    },

    resetRequestCache(): void {
      // Request-local cache behavior is handled by Next's ALS stores.
    },

    isOnDemandRevalidate: false,
  };
}
