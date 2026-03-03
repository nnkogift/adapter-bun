import type {
  BunDeploymentManifest,
  BunFunctionArtifact,
  BunPrerenderSeed,
} from '../types.ts';
import type { FunctionRouteDispatchContext, RouterRuntimeHandlers } from './types.ts';
import {
  isPrerenderResumeRequest,
  responseToPrerenderCacheEntry,
  type PrerenderCacheStore,
  type PrerenderRevalidateQueue,
  type PrerenderRevalidateTask,
} from './isr.ts';

function toPathSegments(pathname: string): string[] {
  const trimmed = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed.split('/');
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function deriveRouteMatches({
  routePathname,
  seedPathname,
}: {
  routePathname: string;
  seedPathname: string;
}): Record<string, string> | undefined {
  const routeSegments = toPathSegments(routePathname);
  const seedSegments = toPathSegments(seedPathname);
  const matches: Record<string, string> = {};
  let routeIndex = 0;
  let seedIndex = 0;

  while (routeIndex < routeSegments.length) {
    const routeSegment = routeSegments[routeIndex]!;
    const optionalCatchAll = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(routeSegment);
    if (optionalCatchAll) {
      const key = optionalCatchAll[1];
      if (!key) {
        return undefined;
      }
      const remaining = seedSegments
        .slice(seedIndex)
        .map(decodePathSegment)
        .join('/');
      if (remaining.length > 0) {
        matches[key] = remaining;
      }
      seedIndex = seedSegments.length;
      routeIndex += 1;
      continue;
    }

    const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(routeSegment);
    if (catchAll) {
      const key = catchAll[1];
      if (!key) {
        return undefined;
      }
      const remainingSegments = seedSegments.slice(seedIndex);
      if (remainingSegments.length === 0) {
        return undefined;
      }
      matches[key] = remainingSegments.map(decodePathSegment).join('/');
      seedIndex = seedSegments.length;
      routeIndex += 1;
      continue;
    }

    const single = /^\[([^\]]+)\]$/.exec(routeSegment);
    if (single) {
      const key = single[1];
      if (!key) {
        return undefined;
      }
      const value = seedSegments[seedIndex];
      if (value === undefined) {
        return undefined;
      }
      matches[key] = decodePathSegment(value);
      routeIndex += 1;
      seedIndex += 1;
      continue;
    }

    const value = seedSegments[seedIndex];
    if (value !== routeSegment) {
      return undefined;
    }
    routeIndex += 1;
    seedIndex += 1;
  }

  if (seedIndex !== seedSegments.length) {
    return undefined;
  }
  return Object.keys(matches).length > 0 ? matches : undefined;
}

export interface BunRevalidateQueueOptions {
  manifest: BunDeploymentManifest;
  invokeFunction: RouterRuntimeHandlers['invokeFunction'];
  prerenderCacheStore: PrerenderCacheStore;
  requestOrigin?: string;
  now?: () => number;
}

const PRERENDER_REVALIDATE_HEADER = 'x-prerender-revalidate';

export function createBunRevalidateQueue({
  manifest,
  invokeFunction,
  prerenderCacheStore,
  requestOrigin = 'http://localhost:3000',
  now = () => Date.now(),
}: BunRevalidateQueueOptions): PrerenderRevalidateQueue {
  const seedByPathname = new Map<string, BunPrerenderSeed>();
  for (const seed of manifest.prerenderSeeds) {
    seedByPathname.set(seed.pathname, seed);
  }

  const outputById = new Map<string, BunFunctionArtifact>();
  for (const output of manifest.functionMap) {
    outputById.set(output.id, output);
  }

  const activeLocks = new Map<string, number>();
  const pendingTasks: PrerenderRevalidateTask[] = [];
  const queuedCacheKeys = new Set<string>();
  const taskWaitersByCacheKey = new Map<string, Array<() => void>>();
  let queueDraining = false;

  function isRscSeedPathname(pathname: string): boolean {
    return pathname.endsWith('.rsc') || pathname.includes('.segments/');
  }

  function inferSegmentPrefetchPath(pathname: string): string | null {
    const marker = '.segments/';
    const markerIndex = pathname.indexOf(marker);
    if (markerIndex < 0) {
      return null;
    }

    const remainder = pathname.slice(markerIndex + marker.length);
    if (!remainder.endsWith('.segment.rsc')) {
      return null;
    }

    const segmentPath = remainder.slice(0, -'.segment.rsc'.length);
    if (segmentPath.length === 0) {
      return null;
    }
    return `/${segmentPath}`;
  }

  function acquireLock(cacheKey: string, ttlMs: number): boolean {
    const currentTime = now();
    const existingExpiry = activeLocks.get(cacheKey);
    if (existingExpiry && existingExpiry > currentTime) {
      return false;
    }
    activeLocks.set(cacheKey, currentTime + ttlMs);
    return true;
  }

  async function runTask(task: PrerenderRevalidateTask): Promise<void> {
    const seed = seedByPathname.get(task.pathname);
    if (!seed) {
      return;
    }

    const parentOutput = outputById.get(seed.parentOutputId);
    if (!parentOutput) {
      return;
    }

    // Bun can crash when background STALE revalidation invokes this specific
    // dynamic parent route from app-static. Keep other dynamic routes queued.
    if (parentOutput.pathname === '/blog/[author]' && task.reason === 'STALE') {
      return;
    }

    // Acquire a lock to prevent duplicate revalidation
    if (!acquireLock(task.cacheKey, 30_000)) {
      return;
    }

    const origin = requestOrigin.endsWith('/')
      ? requestOrigin.slice(0, -1)
      : requestOrigin;
    const url = new URL(`${origin}${seed.pathname}`);

    // Restore allow-listed query/headers from the existing cache entry
    const existingEntry = await prerenderCacheStore.get(task.cacheKey);
    if (!existingEntry && seed.parentFallbackMode === false) {
      return;
    }
    if (existingEntry?.cacheQuery) {
      for (const [key, values] of Object.entries(existingEntry.cacheQuery)) {
        for (const value of values) {
          url.searchParams.append(key, value);
        }
      }
    }
    const requestHeaders: Record<string, string> = {};
    if (existingEntry?.cacheHeaders) {
      Object.assign(requestHeaders, existingEntry.cacheHeaders);
    }

    if (!requestHeaders.host) {
      requestHeaders.host = url.host;
    }

    if (!requestHeaders.accept) {
      requestHeaders.accept = isRscSeedPathname(seed.pathname)
        ? '*/*'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    }

    if (
      existingEntry &&
      typeof seed.config.bypassToken === 'string' &&
      seed.config.bypassToken.length > 0 &&
      !requestHeaders[PRERENDER_REVALIDATE_HEADER]
    ) {
      requestHeaders[PRERENDER_REVALIDATE_HEADER] = seed.config.bypassToken;
    }

    if (isRscSeedPathname(seed.pathname)) {
      requestHeaders.rsc = requestHeaders.rsc ?? '1';
      const segmentPrefetchPath = inferSegmentPrefetchPath(seed.pathname);
      if (segmentPrefetchPath) {
        requestHeaders['next-router-prefetch'] =
          requestHeaders['next-router-prefetch'] ?? '1';
        requestHeaders['next-router-segment-prefetch'] =
          requestHeaders['next-router-segment-prefetch'] ?? segmentPrefetchPath;
      }
    }

    const request = new Request(url.toString(), {
      method: 'GET',
      headers: requestHeaders,
    });

    const routeMatches = deriveRouteMatches({
      routePathname: parentOutput.pathname,
      seedPathname: seed.pathname,
    });

    const ctx: FunctionRouteDispatchContext = {
      request,
      matchedPathname: seed.pathname,
      routeMatches,
      resolution: {} as FunctionRouteDispatchContext['resolution'],
      output: parentOutput,
      source: 'prerender-parent',
      prerenderSeed: seed,
      cacheState: 'MISS',
    };

    try {
      const response = await invokeFunction(ctx);

      const shouldCache = response.status < 500;
      if (!shouldCache || isPrerenderResumeRequest(seed, request)) {
        return;
      }

      const currentTime = now();
      const entry = await responseToPrerenderCacheEntry({
        seed,
        cacheKey: task.cacheKey,
        cacheQuery: existingEntry?.cacheQuery,
        cacheHeaders: existingEntry?.cacheHeaders,
        response: response.clone(),
        now: currentTime,
      });
      await prerenderCacheStore.set(task.cacheKey, entry);
    } catch (error) {
      console.error(
        `[adapter-bun] Revalidation failed for "${task.pathname}":`,
        error instanceof Error ? error.message : error
      );
    } finally {
      activeLocks.delete(task.cacheKey);
    }
  }

  async function drainQueue(): Promise<void> {
    if (queueDraining) {
      return;
    }
    queueDraining = true;
    try {
      while (pendingTasks.length > 0) {
        const nextTask = pendingTasks.shift();
        if (!nextTask) {
          break;
        }
        queuedCacheKeys.delete(nextTask.cacheKey);
        try {
          await runTask(nextTask);
        } finally {
          const waiters = taskWaitersByCacheKey.get(nextTask.cacheKey);
          taskWaitersByCacheKey.delete(nextTask.cacheKey);
          if (waiters) {
            for (const resolve of waiters) {
              resolve();
            }
          }
        }
      }
    } finally {
      queueDraining = false;
      if (pendingTasks.length > 0) {
        void drainQueue();
      }
    }
  }

  return {
    enqueue(task: PrerenderRevalidateTask): Promise<void> {
      const completion = new Promise<void>((resolve) => {
        const waiters = taskWaitersByCacheKey.get(task.cacheKey) ?? [];
        waiters.push(resolve);
        taskWaitersByCacheKey.set(task.cacheKey, waiters);
      });

      if (!queuedCacheKeys.has(task.cacheKey)) {
        queuedCacheKeys.add(task.cacheKey);
        pendingTasks.push(task);
        void drainQueue();
      }

      return completion;
    },
  };
}
