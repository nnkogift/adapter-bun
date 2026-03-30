import { createFetchPrerenderCacheStore } from './cache-http-client.js';
import { bytesFromUtf8, decodeBase64ToBytes, utf8FromBytes } from './binary.js';
import type {
  CacheEntry,
  NextUseCacheHandler,
  Timestamp,
} from '../next-compat-types.js';

const CACHE_TAGS_HEADER = 'x-next-cache-tags';
const CACHE_STALE_HEADER = 'x-next-cache-stale';
const store = createFetchPrerenderCacheStore();
const pendingSets = new Map<string, Promise<void>>();
const inMemoryBodyChunks = new Map<
  string,
  {
    createdAt: number;
    chunks: Uint8Array[];
  }
>();
const MAX_IN_MEMORY_CHUNK_ENTRIES = 512;

function readStoredTags(headers: Record<string, string>): string[] {
  const raw = headers[CACHE_TAGS_HEADER];
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function readStoredStale(
  headers: Record<string, string>,
  fallbackStale: number
): number {
  const raw = headers[CACHE_STALE_HEADER];
  if (typeof raw !== 'string' || raw.length === 0) {
    return fallbackStale;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallbackStale;
}

function decodeStoredBodyBytes(row: {
  body: Uint8Array | string;
  bodyEncoding: 'binary' | 'base64';
}): Uint8Array {
  if (row.bodyEncoding === 'binary') {
    return typeof row.body === 'string' ? bytesFromUtf8(row.body) : row.body;
  }

  const encodedBody = typeof row.body === 'string' ? row.body : utf8FromBytes(row.body);
  return decodeBase64ToBytes(encodedBody);
}

function toReadableStreamFromChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

class FetchCacheHandler implements NextUseCacheHandler {
  async get(
    cacheKey: string,
    _softTags: string[]
  ): Promise<undefined | CacheEntry> {
    const pendingPromise = pendingSets.get(cacheKey);
    if (pendingPromise) {
      await pendingPromise;
    }

    const row = await store.get(cacheKey);
    if (!row) {
      return undefined;
    }

    const now = Date.now();
    if (row.expiresAt !== null && row.expiresAt <= now) {
      return undefined;
    }
    if (row.revalidateAt !== null && row.revalidateAt <= now) {
      return undefined;
    }

    let revalidateSec =
      row.revalidateAt !== null
        ? Math.max(0, Math.floor((row.revalidateAt - row.createdAt) / 1000))
        : 31536000;
    const expireSec =
      row.expiresAt !== null
        ? Math.max(0, Math.floor((row.expiresAt - row.createdAt) / 1000))
        : revalidateSec * 2;
    const tags = readStoredTags(row.headers);

    if (tags.length > 0) {
      const tagEntries = await store.getTagManifestEntries?.(tags);
      if (tagEntries) {
        const now = Date.now();
        for (const tag of tags) {
          const tagEntry = tagEntries[tag];
          if (!tagEntry) continue;

          if (
            typeof tagEntry.expiredAt === 'number' &&
            tagEntry.expiredAt <= now &&
            tagEntry.expiredAt > row.createdAt
          ) {
            return undefined;
          }

          if (
            typeof tagEntry.staleAt === 'number' &&
            tagEntry.staleAt > row.createdAt
          ) {
            revalidateSec = -1;
          }
        }
      }
    }

    const staleSec = readStoredStale(row.headers, revalidateSec);
    const cachedBody = inMemoryBodyChunks.get(cacheKey);
    const stream =
      cachedBody && cachedBody.createdAt === row.createdAt && cachedBody.chunks.length > 0
        ? toReadableStreamFromChunks(cachedBody.chunks)
        : toReadableStreamFromChunks([decodeStoredBodyBytes(row)]);

    return {
      value: stream,
      tags,
      stale: staleSec,
      timestamp: row.createdAt,
      expire: expireSec,
      revalidate: revalidateSec,
    };
  }

  async set(
    cacheKey: string,
    pendingEntry: Promise<CacheEntry>
  ): Promise<void> {
    let resolvePending: () => void = () => {};
    const pendingPromise = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    pendingSets.set(cacheKey, pendingPromise);

    try {
      const entry = await pendingEntry;
      const [value, clonedValue] = entry.value.tee();
      entry.value = value;

      const reader = clonedValue.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (chunk) chunks.push(chunk);
      }

      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const createdAt = entry.timestamp ?? Date.now();

      const chunksForMemory =
        chunks.length > 0
          ? chunks.map((chunk) => chunk.slice())
          : [combined.slice()];
      inMemoryBodyChunks.set(cacheKey, {
        createdAt,
        chunks: chunksForMemory,
      });
      if (inMemoryBodyChunks.size > MAX_IN_MEMORY_CHUNK_ENTRIES) {
        const oldestKey = inMemoryBodyChunks.keys().next().value;
        if (typeof oldestKey === 'string') {
          inMemoryBodyChunks.delete(oldestKey);
        }
      }

      await store.set(cacheKey, {
        cacheKey,
        pathname: cacheKey,
        groupId: 0,
        status: 200,
        headers: {
          ...(entry.tags.length > 0
            ? { [CACHE_TAGS_HEADER]: entry.tags.join(',') }
            : {}),
          [CACHE_STALE_HEADER]: String(entry.stale),
        },
        body: combined,
        bodyEncoding: 'binary',
        createdAt,
        revalidateAt:
          entry.revalidate > 0 ? createdAt + entry.revalidate * 1000 : null,
        expiresAt:
          entry.expire > 0 ? createdAt + entry.expire * 1000 : null,
      });
    } catch {
      return;
    } finally {
      resolvePending();
      pendingSets.delete(cacheKey);
    }
  }

  async refreshTags(): Promise<void> {}

  async getExpiration(tags: string[]): Promise<Timestamp> {
    if (tags.length === 0) return 0;

    const entries = await store.getTagManifestEntries?.(tags);
    if (!entries) return 0;

    let maxTimestamp = 0;
    for (const tag of tags) {
      const entry = entries[tag];
      if (!entry) continue;
      if (entry.expiredAt !== undefined && entry.expiredAt > maxTimestamp) {
        maxTimestamp = entry.expiredAt;
      }
    }

    return maxTimestamp;
  }

  async updateTags(
    tags: string[],
    durations?: { expire?: number }
  ): Promise<void> {
    if (tags.length === 0) return;

    const now = Date.now();
    if (durations?.expire !== undefined) {
      await store.updateTagManifest?.(tags, {
        mode: 'stale',
        now,
        expireSeconds: durations.expire,
      });
      return;
    }

    await store.updateTagManifest?.(tags, {
      mode: 'expire',
      now,
    });
  }
}

const cacheHandler: NextUseCacheHandler = new FetchCacheHandler();
export default cacheHandler;
