import type { PrerenderCacheStore } from './isr.ts';

/**
 * Bridges Next.js's in-memory `tagsManifest` Map with our SQLite tag manifest.
 *
 * When `revalidateTag()` or `revalidatePath()` from `next/cache` is called
 * inside a route handler or server action, Next.js updates an in-memory Map
 * (`tagsManifest`) via `FileSystemCache.revalidateTag()`. That Map is never
 * persisted to our SQLite `tag_manifest` table, so subsequent requests don't
 * see the invalidation.
 *
 * This bridge intercepts `tagsManifest.set()` to also write the tag state
 * into our SQLite store so the router's cache evaluation picks it up.
 *
 * Next.js ships both CJS and ESM copies of the module — each has its own
 * `tagsManifest` Map instance.  We patch whichever copies are resolvable.
 */
export async function bridgeNextTagManifest(
  store: PrerenderCacheStore
): Promise<void> {
  if (!store.updateTagManifest) {
    return;
  }

  // Next.js ships both CJS and ESM; the function handler may use either.
  const moduleSpecifiers = [
    'next/dist/esm/server/lib/incremental-cache/tags-manifest.external.js',
    'next/dist/server/lib/incremental-cache/tags-manifest.external.js',
  ];

  const patched = new Set<Map<string, TagEntry>>();

  for (const specifier of moduleSpecifiers) {
    try {
      const mod = await import(specifier) as Record<string, unknown>;
      const tagsManifest = mod.tagsManifest as Map<string, TagEntry> | undefined;
      if (tagsManifest instanceof Map && !patched.has(tagsManifest)) {
        patchTagsManifest(tagsManifest, store);
        patched.add(tagsManifest);
      }
    } catch {
      // Module variant not available, skip.
    }
  }
}

type TagEntry = { stale?: number; expired?: number };

function patchTagsManifest(
  tagsManifest: Map<string, TagEntry>,
  store: PrerenderCacheStore
): void {
  const originalSet = tagsManifest.set.bind(tagsManifest) as Map<string, TagEntry>['set'];
  tagsManifest.set = function (tag: string, entry: TagEntry) {
    const result = originalSet(tag, entry);
    syncTagToStore(store, tag, entry);
    return result;
  };
}

function syncTagToStore(
  store: PrerenderCacheStore,
  tag: string,
  entry: TagEntry
): void {
  if (entry.stale !== undefined && entry.expired !== undefined) {
    // Stale with future expiration window
    store.updateTagManifest!([tag], {
      mode: 'stale',
      now: entry.stale,
      expireSeconds: (entry.expired - entry.stale) / 1000,
    });
  } else if (entry.expired !== undefined) {
    // Immediate expiration
    store.updateTagManifest!([tag], {
      mode: 'expire',
      now: entry.expired,
    });
  } else if (entry.stale !== undefined) {
    // Stale only (no expiration deadline)
    store.updateTagManifest!([tag], {
      mode: 'stale',
      now: entry.stale,
    });
  }
}
