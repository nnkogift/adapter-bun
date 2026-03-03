import { getMiddlewareRouteMatcher } from 'next/dist/shared/lib/router/utils/middleware-route-matcher';
import type { BunFunctionArtifact } from '../types.ts';

type MatcherLike = {
  regexp?: string;
  sourceRegex?: string;
  has?: unknown[];
  missing?: unknown[];
};

type QueryValue = string | string[];
type QueryLike = Record<string, QueryValue>;

function toQuery(url: URL): QueryLike {
  const query: QueryLike = {};
  for (const [key, value] of url.searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
      continue;
    }

    if (Array.isArray(existing)) {
      existing.push(value);
      continue;
    }

    query[key] = [existing, value];
  }
  return query;
}

function toRequestHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

export function createMiddlewareMatcher(
  output: Pick<BunFunctionArtifact, 'config'>
): ((url: URL, headers: Headers) => boolean) | null {
  const debug = process.env.ADAPTER_BUN_DEBUG_MW === '1';
  const configuredMatchers =
    output.config &&
    typeof output.config === 'object' &&
    Array.isArray((output.config as { matchers?: unknown[] }).matchers)
      ? ((output.config as { matchers?: unknown[] }).matchers as MatcherLike[])
      : [];

  if (configuredMatchers.length === 0) {
    return null;
  }

  const matchers = configuredMatchers
    .map((matcher) => ({
      regexp: matcher.regexp ?? matcher.sourceRegex,
      has: matcher.has,
      missing: matcher.missing,
    }))
    .filter(
      (matcher) =>
        typeof matcher.regexp === 'string' && matcher.regexp.length > 0
    ) as Array<{
      regexp: string;
      has?: unknown[];
      missing?: unknown[];
    }>;

  if (matchers.length === 0) {
    return null;
  }

  const routeMatcher = getMiddlewareRouteMatcher(
    matchers as Parameters<typeof getMiddlewareRouteMatcher>[0]
  );
  if (debug) {
    console.log('[adapter-bun][middleware][matcher:init]', {
      matchers,
    });
  }

  return (url: URL, headers: Headers): boolean => {
    let decodedPathname: string;
    try {
      decodedPathname = decodeURIComponent(url.pathname);
    } catch {
      decodedPathname = url.pathname;
    }
    const matched = routeMatcher(
      decodedPathname,
      { headers: toRequestHeaders(headers) } as Parameters<
        ReturnType<typeof getMiddlewareRouteMatcher>
      >[1],
      toQuery(url) as Parameters<ReturnType<typeof getMiddlewareRouteMatcher>>[2]
    );
    if (debug) {
      console.log('[adapter-bun][middleware][matcher:check]', {
        pathname: url.pathname,
        search: url.search,
        matched,
      });
    }
    return matched;
  };
}
