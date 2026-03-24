import type { IncomingHttpHeaders } from 'node:http';

export const RSC_HEADER = 'rsc';
export const ACTION_HEADER = 'next-action';
export const NEXT_ROUTER_STATE_TREE_HEADER = 'next-router-state-tree';
export const NEXT_ROUTER_PREFETCH_HEADER = 'next-router-prefetch';
export const NEXT_ROUTER_SEGMENT_PREFETCH_HEADER = 'next-router-segment-prefetch';
export const NEXT_URL = 'next-url';
export const NEXT_RSC_UNION_QUERY = '_rsc';

const NEXT_QUERY_PARAM_PREFIX = 'nxtP';
const NEXT_INTERCEPTION_MARKER_PREFIX = 'nxtI';
const INTERCEPTION_ROUTE_MARKERS = ['(..)(..)', '(.)', '(..)', '(...)'] as const;
const PARAMETER_PATTERN = /^([^[]*)\[((?:\[[^\]]*\])|[^\]]+)\](.*)$/;

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

type RouteRegexGroup = {
  pos: number;
  repeat: boolean;
  optional: boolean;
};

type RouteRegex = {
  re: RegExp;
  groups: Record<string, RouteRegexGroup>;
  namedRegex?: string;
  routeKeys?: Record<string, string>;
  pathToRegexpPattern?: string;
  reference?: unknown;
};

type NamedRouteRegexOptions = {
  includeSuffix?: boolean;
  includePrefix?: boolean;
  excludeOptionalTrailingSlash?: boolean;
  prefixRouteKeys?: boolean;
  backreferenceDuplicateKeys?: boolean;
  reference?: unknown;
};

type ParsedParameter = {
  key: string;
  repeat: boolean;
  optional: boolean;
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

function escapeStringRegexp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

function removeTrailingSlash(route: string): string {
  if (route.length > 1 && route.endsWith('/')) {
    return route.slice(0, -1);
  }
  return route;
}

function parseMatchedParameter(param: string): ParsedParameter {
  let target = param;
  const optional = target.startsWith('[') && target.endsWith(']');
  if (optional) {
    target = target.slice(1, -1);
  }
  const repeat = target.startsWith('...');
  if (repeat) {
    target = target.slice(3);
  }
  return {
    key: target,
    repeat,
    optional,
  };
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

function getParametrizedRoute(
  route: string,
  includeSuffix: boolean,
  includePrefix: boolean
): {
  parameterizedRoute: string;
  groups: Record<string, RouteRegexGroup>;
} {
  const groups: Record<string, RouteRegexGroup> = {};
  let groupIndex = 1;
  const segments: string[] = [];
  const normalizedRoute = removeTrailingSlash(route);
  const routeSegments =
    normalizedRoute === '/' ? [] : normalizedRoute.slice(1).split('/');

  for (const segment of routeSegments) {
    const parameterMatch = segment.match(PARAMETER_PATTERN);
    if (parameterMatch && parameterMatch[2]) {
      const prefix = parameterMatch[1] ?? '';
      const parsed = parseMatchedParameter(parameterMatch[2]);
      const suffix = parameterMatch[3] ?? '';

      groups[parsed.key] = {
        pos: groupIndex++,
        repeat: parsed.repeat,
        optional: parsed.optional,
      };

      if (includePrefix && prefix.length > 0) {
        segments.push(`/${escapeStringRegexp(prefix)}`);
      }

      let dynamicSegment = parsed.repeat
        ? parsed.optional
          ? '(?:/(.+?))?'
          : '/(.+?)'
        : '/([^/]+?)';
      if (includePrefix && prefix.length > 0) {
        dynamicSegment = dynamicSegment.slice(1);
      }
      segments.push(dynamicSegment);

      if (includeSuffix && suffix.length > 0) {
        segments.push(escapeStringRegexp(suffix));
      }
      continue;
    }

    segments.push(`/${escapeStringRegexp(segment)}`);
  }

  return {
    parameterizedRoute: segments.join(''),
    groups,
  };
}

export function getNamedRouteRegex(
  normalizedRoute: string,
  options: NamedRouteRegexOptions
): RouteRegex {
  const includeSuffix = options.includeSuffix ?? false;
  const includePrefix = options.includePrefix ?? false;
  const excludeOptionalTrailingSlash =
    options.excludeOptionalTrailingSlash ?? false;
  const { parameterizedRoute, groups } = getParametrizedRoute(
    normalizedRoute,
    includeSuffix,
    includePrefix
  );
  const routePattern = excludeOptionalTrailingSlash
    ? parameterizedRoute
    : `${parameterizedRoute}(?:/)?`;

  return {
    re: new RegExp(`^${routePattern}$`),
    groups,
    namedRegex: `^${routePattern}$`,
    routeKeys: {},
    pathToRegexpPattern: parameterizedRoute,
  };
}

function decodeRouteParam(param: string): string {
  try {
    return decodeURIComponent(param);
  } catch {
    throw new Error('failed to decode route param');
  }
}

export function getRouteMatcher({
  re,
  groups,
}: Pick<RouteRegex, 're' | 'groups'>): (
  pathname: string
) => Record<string, string | string[]> | false {
  return (pathname: string) => {
    const routeMatch = re.exec(pathname);
    if (!routeMatch) {
      return false;
    }

    const params: Record<string, string | string[]> = {};
    for (const [key, group] of Object.entries(groups)) {
      const match = routeMatch[group.pos];
      if (match === undefined) {
        continue;
      }
      if (group.repeat) {
        params[key] = match.split('/').map((entry) => decodeRouteParam(entry));
      } else {
        params[key] = decodeRouteParam(match);
      }
    }

    return params;
  };
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

class UrlNode {
  private placeholder = true;
  private readonly children = new Map<string, UrlNode>();
  private slugName: string | null = null;
  private restSlugName: string | null = null;
  private optionalRestSlugName: string | null = null;

  insert(urlPath: string): void {
    this.insertSegments(urlPath.split('/').filter(Boolean), [], false);
  }

  smoosh(): string[] {
    return this.smooshWithPrefix();
  }

  private getOrCreateChild(nextSegment: string): UrlNode {
    const existing = this.children.get(nextSegment);
    if (existing) {
      return existing;
    }
    const created = new UrlNode();
    this.children.set(nextSegment, created);
    return created;
  }

  private insertSegments(
    urlPaths: string[],
    slugNames: string[],
    isCatchAll: boolean
  ): void {
    if (urlPaths.length === 0) {
      this.placeholder = false;
      return;
    }
    if (isCatchAll) {
      throw new Error('Catch-all must be the last part of the URL.');
    }

    let nextSegment = urlPaths[0] ?? '';
    if (nextSegment.startsWith('[') && nextSegment.endsWith(']')) {
      let segmentName = nextSegment.slice(1, -1);
      let isOptional = false;
      if (segmentName.startsWith('[') && segmentName.endsWith(']')) {
        segmentName = segmentName.slice(1, -1);
        isOptional = true;
      }

      if (segmentName.startsWith('...')) {
        segmentName = segmentName.slice(3);
        isCatchAll = true;
      }

      const handleSlug = (previousSlug: string | null, nextSlug: string) => {
        if (previousSlug !== null && previousSlug !== nextSlug) {
          throw new Error(
            `You cannot use different slug names for the same dynamic path ('${previousSlug}' !== '${nextSlug}').`
          );
        }
        for (const slug of slugNames) {
          if (slug === nextSlug) {
            throw new Error(
              `You cannot have the same slug name "${nextSlug}" repeat within a single dynamic path`
            );
          }
          if (slug.replace(/\W/g, '') === nextSegment.replace(/\W/g, '')) {
            throw new Error(
              `You cannot have the slug names "${slug}" and "${nextSlug}" differ only by non-word symbols within a single dynamic path`
            );
          }
        }
        slugNames.push(nextSlug);
      };

      if (isCatchAll) {
        if (isOptional) {
          if (this.restSlugName !== null) {
            throw new Error(
              `You cannot use both an required and optional catch-all route at the same level ("[...${this.restSlugName}]" and "${urlPaths[0]}" ).`
            );
          }
          handleSlug(this.optionalRestSlugName, segmentName);
          this.optionalRestSlugName = segmentName;
          nextSegment = '[[...]]';
        } else {
          if (this.optionalRestSlugName !== null) {
            throw new Error(
              `You cannot use both an optional and required catch-all route at the same level ("[[...${this.optionalRestSlugName}]]" and "${urlPaths[0]}").`
            );
          }
          handleSlug(this.restSlugName, segmentName);
          this.restSlugName = segmentName;
          nextSegment = '[...]';
        }
      } else {
        if (isOptional) {
          throw new Error(
            `Optional route parameters are not yet supported ("${urlPaths[0]}").`
          );
        }
        handleSlug(this.slugName, segmentName);
        this.slugName = segmentName;
        nextSegment = '[]';
      }
    }

    this.getOrCreateChild(nextSegment).insertSegments(
      urlPaths.slice(1),
      slugNames,
      isCatchAll
    );
  }

  private smooshWithPrefix(prefix: string = '/'): string[] {
    const childrenPaths = [...this.children.keys()].sort();
    if (this.slugName !== null) {
      const dynamicIndex = childrenPaths.indexOf('[]');
      if (dynamicIndex >= 0) {
        childrenPaths.splice(dynamicIndex, 1);
      }
    }
    if (this.restSlugName !== null) {
      const catchAllIndex = childrenPaths.indexOf('[...]');
      if (catchAllIndex >= 0) {
        childrenPaths.splice(catchAllIndex, 1);
      }
    }
    if (this.optionalRestSlugName !== null) {
      const optionalCatchAllIndex = childrenPaths.indexOf('[[...]]');
      if (optionalCatchAllIndex >= 0) {
        childrenPaths.splice(optionalCatchAllIndex, 1);
      }
    }

    const routes = childrenPaths
      .map((child) => {
        const childNode = this.children.get(child);
        if (!childNode) {
          return [] as string[];
        }
        return childNode.smooshWithPrefix(`${prefix}${child}/`);
      })
      .flat();

    if (this.slugName !== null) {
      const slugChild = this.children.get('[]');
      if (slugChild) {
        routes.push(...slugChild.smooshWithPrefix(`${prefix}[${this.slugName}]/`));
      }
    }

    if (!this.placeholder) {
      const route = prefix === '/' ? '/' : prefix.slice(0, -1);
      if (this.optionalRestSlugName !== null) {
        throw new Error(
          `You cannot define a route with the same specificity as a optional catch-all route ("${route}" and "${route}[[...${this.optionalRestSlugName}]]").`
        );
      }
      routes.unshift(route);
    }

    if (this.restSlugName !== null) {
      const restChild = this.children.get('[...]');
      if (restChild) {
        routes.push(
          ...restChild.smooshWithPrefix(`${prefix}[...${this.restSlugName}]/`)
        );
      }
    }

    if (this.optionalRestSlugName !== null) {
      const optionalRestChild = this.children.get('[[...]]');
      if (optionalRestChild) {
        routes.push(
          ...optionalRestChild.smooshWithPrefix(
            `${prefix}[[...${this.optionalRestSlugName}]]/`
          )
        );
      }
    }

    return routes;
  }
}

export function getSortedRoutes(normalizedPages: string[]): string[] {
  const root = new UrlNode();
  for (const pagePath of normalizedPages) {
    root.insert(pagePath);
  }
  return root.smoosh();
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
        params[paramKey] = Array.isArray(value) ? (value[value.length - 1] ?? '') : value;
      }
      return true;
    }

    if (!value || !hasItem.value) {
      return false;
    }

    const candidate = Array.isArray(value) ? (value[value.length - 1] ?? '') : value;
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

export function normalizeNextQueryParam(key: string): string | null {
  const prefixes = [NEXT_QUERY_PARAM_PREFIX, NEXT_INTERCEPTION_MARKER_PREFIX];
  for (const prefix of prefixes) {
    if (key !== prefix && key.startsWith(prefix)) {
      return key.slice(prefix.length);
    }
  }
  return null;
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
