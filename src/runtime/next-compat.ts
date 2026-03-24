import type { IncomingHttpHeaders } from 'node:http';

export const RSC_HEADER = 'rsc';
export const ACTION_HEADER = 'next-action';
export const NEXT_ROUTER_STATE_TREE_HEADER = 'next-router-state-tree';
export const NEXT_ROUTER_PREFETCH_HEADER = 'next-router-prefetch';
export const NEXT_ROUTER_SEGMENT_PREFETCH_HEADER = 'next-router-segment-prefetch';
export const NEXT_URL = 'next-url';
export const NEXT_RSC_UNION_QUERY = '_rsc';

const INTERCEPTION_ROUTE_MARKERS = ['(..)(..)', '(.)', '(..)', '(...)'] as const;
const DYNAMIC_PARAM_TYPES: Record<string, string> = {
  catchall: 'c',
  'catchall-intercepted-(..)(..)': 'ci(..)(..)',
  'catchall-intercepted-(.)': 'ci(.)',
  'catchall-intercepted-(..)': 'ci(..)',
  'catchall-intercepted-(...)': 'ci(...)',
  'optional-catchall': 'oc',
  dynamic: 'd',
  'dynamic-intercepted-(..)(..)': 'di(..)(..)',
  'dynamic-intercepted-(.)': 'di(.)',
  'dynamic-intercepted-(..)': 'di(..)',
  'dynamic-intercepted-(...)': 'di(...)',
};

export type OpaqueFallbackRouteParams = Map<string, [string, string]>;

export interface FallbackRouteParamInput {
  paramName: string;
  paramType: string;
}

export interface MiddlewareRouteMatcherHas {
  type: 'header' | 'cookie' | 'query' | 'host';
  key?: string;
  value?: string;
}

export interface MiddlewareRouteMatcher {
  regexp: string;
  has?: MiddlewareRouteMatcherHas[];
  missing?: MiddlewareRouteMatcherHas[];
}

function stripInterceptionMarkerPrefix(segment: string): string {
  let normalizedSegment = segment;
  while (
    INTERCEPTION_ROUTE_MARKERS.some((marker) =>
      normalizedSegment.startsWith(marker)
    )
  ) {
    if (normalizedSegment.startsWith('(.)')) {
      normalizedSegment = normalizedSegment.slice('(.)'.length);
      continue;
    }
    if (normalizedSegment.startsWith('(..)')) {
      normalizedSegment = normalizedSegment.slice('(..)'.length);
      continue;
    }
    if (normalizedSegment.startsWith('(...)')) {
      normalizedSegment = normalizedSegment.slice('(...)'.length);
      continue;
    }
    if (normalizedSegment.startsWith('(..)(..)')) {
      normalizedSegment = normalizedSegment.slice('(..)(..)'.length);
      continue;
    }
  }
  return normalizedSegment;
}

function normalizeInterceptionPathname(route: string): string {
  if (!route.includes('(.')) {
    return route;
  }
  return route
    .split('/')
    .map((segment) => stripInterceptionMarkerPrefix(segment))
    .join('/');
}

const TEST_ROUTE = /\/[^/]*\[[^/]+\][^/]*(?=\/|$)/;
const TEST_STRICT_ROUTE = /\/\[[^/]+\](?=\/|$)/;

export function isDynamicRoute(route: string, strict: boolean = true): boolean {
  const normalizedRoute = normalizeInterceptionPathname(route);
  if (strict) {
    return TEST_STRICT_ROUTE.test(normalizedRoute);
  }
  return TEST_ROUTE.test(normalizedRoute);
}

function getSingleHeaderValue(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function parseCookies(
  cookieHeader: string | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) {
    return result;
  }

  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }
    const rawKey = part.slice(0, separatorIndex).trim();
    if (rawKey.length === 0) {
      continue;
    }
    const rawValue = part.slice(separatorIndex + 1).trim();
    try {
      result[rawKey] = decodeURIComponent(rawValue);
    } catch {
      result[rawKey] = rawValue;
    }
  }

  return result;
}

function getSafeParamName(paramName: string): string {
  let safeName = '';
  for (let index = 0; index < paramName.length; index += 1) {
    const code = paramName.charCodeAt(index);
    if ((code > 64 && code < 91) || (code > 96 && code < 123)) {
      safeName += paramName[index];
    }
  }
  return safeName;
}

function matchHas(
  req: { headers: IncomingHttpHeaders },
  query: Record<string, string | string[]>,
  has: MiddlewareRouteMatcherHas[] = [],
  missing: MiddlewareRouteMatcherHas[] = []
): false | Record<string, string> {
  const params: Record<string, string> = {};
  const cookies = parseCookies(getSingleHeaderValue(req.headers.cookie));

  const hasMatch = (hasItem: MiddlewareRouteMatcherHas): boolean => {
    let value: string | string[] | undefined;
    const key = hasItem.key ?? '';

    switch (hasItem.type) {
      case 'header': {
        if (key.length === 0) {
          return false;
        }
        value = req.headers[key.toLowerCase()];
        break;
      }
      case 'cookie': {
        if (key.length === 0) {
          return false;
        }
        value = cookies[key];
        break;
      }
      case 'query': {
        if (key.length === 0) {
          return false;
        }
        value = query[key];
        break;
      }
      case 'host': {
        const host = getSingleHeaderValue(req.headers.host);
        value = host ? host.split(':', 1)[0]?.toLowerCase() : undefined;
        break;
      }
      default: {
        return false;
      }
    }

    if (!hasItem.value && value) {
      const paramKey = getSafeParamName(key);
      if (paramKey.length > 0) {
        params[paramKey] = Array.isArray(value)
          ? (value[value.length - 1] ?? '')
          : value;
      }
      return true;
    }

    if (!value || !hasItem.value) {
      return false;
    }

    const candidate = Array.isArray(value)
      ? (value[value.length - 1] ?? '')
      : value;
    const matcher = new RegExp(`^${hasItem.value}$`);
    const matches = candidate.match(matcher);
    if (!matches) {
      return false;
    }

    if (matches.groups) {
      for (const [groupKey, groupValue] of Object.entries(matches.groups)) {
        if (typeof groupValue === 'string') {
          params[groupKey] = groupValue;
        }
      }
    } else if (hasItem.type === 'host' && matches[0]) {
      params.host = matches[0];
    }

    return true;
  };

  const allMatch =
    has.every((item) => hasMatch(item)) &&
    !missing.some((item) => hasMatch(item));

  return allMatch ? params : false;
}

export function getMiddlewareRouteMatcher(
  matchers: MiddlewareRouteMatcher[]
): (
  pathname: string,
  req: { headers: IncomingHttpHeaders },
  query: Record<string, string | string[]>
) => boolean {
  return (
    pathname: string,
    req: { headers: IncomingHttpHeaders },
    query: Record<string, string | string[]>
  ): boolean => {
    for (const matcher of matchers) {
      const routeMatch = new RegExp(matcher.regexp).exec(pathname);
      if (!routeMatch) {
        continue;
      }
      if (matcher.has || matcher.missing) {
        const hasParams = matchHas(
          req,
          query,
          matcher.has ?? [],
          matcher.missing ?? []
        );
        if (!hasParams) {
          continue;
        }
      }
      return true;
    }
    return false;
  };
}

function djb2Hash(str: string): number {
  let hash = 5381;
  for (let index = 0; index < str.length; index += 1) {
    const char = str.charCodeAt(index);
    hash = ((hash << 5) + hash + char) & 0xffffffff;
  }
  return hash >>> 0;
}

function hexHash(str: string): string {
  return djb2Hash(str).toString(36).slice(0, 5);
}

export function computeCacheBustingSearchParam(
  prefetchHeader: string | undefined,
  segmentPrefetchHeader: string | undefined,
  stateTreeHeader: string | undefined,
  nextUrlHeader: string | undefined
): string {
  if (
    (prefetchHeader === undefined || prefetchHeader === '0') &&
    segmentPrefetchHeader === undefined &&
    stateTreeHeader === undefined &&
    nextUrlHeader === undefined
  ) {
    return '';
  }

  return hexHash(
    [
      prefetchHeader || '0',
      segmentPrefetchHeader || '0',
      stateTreeHeader || '0',
      nextUrlHeader || '0',
    ].join(',')
  );
}

export function setCacheBustingSearchParamWithHash(
  url: URL,
  hash: string
): void {
  const existingSearch = url.search;
  const rawQuery = existingSearch.startsWith('?')
    ? existingSearch.slice(1)
    : existingSearch;
  const pairs = rawQuery
    .split('&')
    .filter((pair) => pair && !pair.startsWith(`${NEXT_RSC_UNION_QUERY}=`));

  if (hash.length > 0) {
    pairs.push(`${NEXT_RSC_UNION_QUERY}=${hash}`);
  } else {
    pairs.push(NEXT_RSC_UNION_QUERY);
  }

  url.search = pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

export function createOpaqueFallbackRouteParams(
  fallbackRouteParams: FallbackRouteParamInput[]
): OpaqueFallbackRouteParams | null {
  if (fallbackRouteParams.length === 0) {
    return null;
  }

  const uniqueID = Math.random().toString(16).slice(2);
  const keys: OpaqueFallbackRouteParams = new Map();
  for (const { paramName, paramType } of fallbackRouteParams) {
    keys.set(paramName, [
      `%%drp:${paramName}:${uniqueID}%%`,
      DYNAMIC_PARAM_TYPES[paramType] ?? 'd',
    ]);
  }
  return keys;
}
