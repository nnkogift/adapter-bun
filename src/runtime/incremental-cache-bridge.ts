import type { PrerenderCacheStore } from './isr.ts';

export interface EdgeIncrementalCacheBridge {
  get: (...args: unknown[]) => Promise<null>;
  set: (...args: unknown[]) => Promise<void>;
  revalidateTag: (
    tags: string | string[],
    durations?: { expire?: number }
  ) => Promise<void>;
  resetRequestCache: () => void;
}

function normalizeTags(input: string | string[]): string[] {
  const values = Array.isArray(input) ? input : [input];
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

export function createEdgeIncrementalCache({
  prerenderCacheStore,
  now = () => Date.now(),
}: {
  prerenderCacheStore: PrerenderCacheStore;
  now?: () => number;
}): EdgeIncrementalCacheBridge {
  return {
    async get(): Promise<null> {
      // Edge route handlers can read from workStore.incrementalCache.
      // We currently persist route/page output via our prerender cache path,
      // so this bridge only implements tag invalidation behavior.
      return null;
    },

    async set(): Promise<void> {
      // No-op by design for now.
    },

    async revalidateTag(
      tagsInput: string | string[],
      durations?: { expire?: number }
    ): Promise<void> {
      const updateTagManifest = prerenderCacheStore.updateTagManifest;
      if (!updateTagManifest) {
        return;
      }

      const tags = normalizeTags(tagsInput);
      if (tags.length === 0) {
        return;
      }

      const timestamp = now();
      if (durations) {
        await updateTagManifest(tags, {
          mode: 'stale',
          now: timestamp,
          expireSeconds: durations.expire,
        });
        return;
      }

      await updateTagManifest(tags, {
        mode: 'expire',
        now: timestamp,
      });
    },

    resetRequestCache(): void {
      // Kept for parity with IncrementalCache contract.
    },
  };
}
