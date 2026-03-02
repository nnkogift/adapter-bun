import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MiddlewareContext, RouteHas } from '@next/routing';
import type { BunDeploymentManifest, BunFunctionArtifact } from '../types.ts';

export type LambdaLikeResult = {
  statusCode?: number;
  headers?: Record<string, string | number | boolean | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
};

export type ArtifactRouteHandler = (...args: unknown[]) => unknown;

export type LoadedModule = Record<string, unknown>;

export interface CreateFunctionArtifactInvokerOptions {
  manifest: BunDeploymentManifest;
  adapterDir: string;
  loadModule?: (entrypointPath: string) => Promise<LoadedModule>;
  incrementalCache?: unknown;
}

export function resolveInside(baseDir: string, relativePath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativePath);
  const prefix = `${resolvedBase}${path.sep}`;

  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(prefix)) {
    throw new Error(`Resolved path escapes base directory: "${relativePath}"`);
  }

  return resolvedTarget;
}

export function toResponseFromLambdaLike(result: LambdaLikeResult): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    if (value === undefined) continue;
    headers.set(key, String(value));
  }

  const body =
    typeof result.body === 'string'
      ? result.isBase64Encoded
        ? Buffer.from(result.body, 'base64')
        : result.body
      : null;

  return new Response(body, {
    status: result.statusCode ?? 200,
    headers,
  });
}

export function asResponse(value: Response | LambdaLikeResult): Response {
  if (value instanceof Response) {
    return value;
  }
  return toResponseFromLambdaLike(value);
}

export function resolveRouteHandlerExport(module: LoadedModule): ArtifactRouteHandler {
  if (typeof module.handler === 'function') {
    return module.handler as ArtifactRouteHandler;
  }

  if (typeof module.default === 'function') {
    return module.default as ArtifactRouteHandler;
  }

  if (module.default && typeof module.default === 'object') {
    const nested = module.default as Record<string, unknown>;
    if (typeof nested.handler === 'function') {
      return nested.handler as ArtifactRouteHandler;
    }
    if (typeof nested.fetch === 'function') {
      return nested.fetch as ArtifactRouteHandler;
    }
  }

  if (typeof module.fetch === 'function') {
    return module.fetch as ArtifactRouteHandler;
  }

  throw new Error(
    'Function module does not export a supported handler (expected one of: handler, default, default.handler, fetch)'
  );
}

export function defaultLoadModule(entrypointPath: string): Promise<LoadedModule> {
  return import(pathToFileURL(entrypointPath).href) as Promise<LoadedModule>;
}

export function findEntrypointRelativePath(output: BunFunctionArtifact): string {
  const entrypoint = output.files.find((file) => file.kind === 'entrypoint');
  if (!entrypoint) {
    throw new Error(`Function output "${output.id}" is missing an entrypoint file`);
  }
  return entrypoint.relativePath;
}

export function resolveOutputEntrypointPath(
  output: BunFunctionArtifact,
  adapterDir: string,
  functionRoot: string
): string {
  const relativeEntrypointPath = findEntrypointRelativePath(output);
  return resolveInside(
    adapterDir,
    path.join(functionRoot, relativeEntrypointPath)
  );
}

export function resolveOutputFilePath(
  output: BunFunctionArtifact,
  fileRelativePath: string,
  adapterDir: string,
  functionRoot: string
): string {
  return resolveInside(
    adapterDir,
    path.join(functionRoot, fileRelativePath)
  );
}

type MiddlewareMatcherLike = {
  regexp?: string;
  sourceRegex?: string;
  has?: RouteHas[];
  missing?: RouteHas[];
};

function parseCookieHeader(headerValue: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  const segments = headerValue.split(';');
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const delimiterIndex = trimmed.indexOf('=');
    if (delimiterIndex === -1) {
      cookies[trimmed] = '';
      continue;
    }
    const key = trimmed.slice(0, delimiterIndex).trim();
    if (!key) {
      continue;
    }
    const value = trimmed.slice(delimiterIndex + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

function getConditionValue(
  condition: RouteHas,
  url: URL,
  headers: Headers
): string | undefined {
  switch (condition.type) {
    case 'header':
      return headers.get(condition.key) ?? undefined;
    case 'cookie': {
      const cookieHeader = headers.get('cookie');
      if (!cookieHeader) {
        return undefined;
      }
      const cookies = parseCookieHeader(cookieHeader);
      return cookies[condition.key];
    }
    case 'query':
      return url.searchParams.get(condition.key) ?? undefined;
    case 'host':
      return url.hostname;
    default:
      return undefined;
  }
}

function matchesRouteCondition(
  condition: RouteHas,
  url: URL,
  headers: Headers
): boolean {
  const value = getConditionValue(condition, url, headers);
  if (value === undefined) {
    return false;
  }

  if (!('value' in condition) || condition.value === undefined) {
    return true;
  }

  try {
    if (new RegExp(condition.value).test(value)) {
      return true;
    }
  } catch {
    // Ignore invalid pattern and fallback to exact string match.
  }

  return value === condition.value;
}

function conditionsPass(
  matcher: MiddlewareMatcherLike,
  url: URL,
  headers: Headers
): boolean {
  if (matcher.has?.some((condition) => !matchesRouteCondition(condition, url, headers))) {
    return false;
  }

  if (matcher.missing?.some((condition) => matchesRouteCondition(condition, url, headers))) {
    return false;
  }

  return true;
}

function getMiddlewareMatchers(output: BunFunctionArtifact): MiddlewareMatcherLike[] | null {
  const config = output.config;
  if (!config || typeof config !== 'object') {
    return null;
  }

  const maybeMatchers = (config as { matchers?: unknown }).matchers;
  if (!Array.isArray(maybeMatchers) || maybeMatchers.length === 0) {
    return null;
  }

  const matchers = maybeMatchers.filter(
    (value): value is MiddlewareMatcherLike =>
      value !== null && typeof value === 'object'
  );
  return matchers.length > 0 ? matchers : null;
}

export function shouldInvokeMiddlewareForRequest(
  output: BunFunctionArtifact,
  ctx: MiddlewareContext
): boolean {
  const matchers = getMiddlewareMatchers(output);
  if (!matchers) {
    return true;
  }

  const { pathname } = ctx.url;

  for (const matcher of matchers) {
    const pattern = matcher.sourceRegex ?? matcher.regexp;
    if (typeof pattern !== 'string') {
      return true;
    }

    let routeRegex: RegExp;
    try {
      routeRegex = new RegExp(pattern);
    } catch {
      return true;
    }

    if (!routeRegex.test(pathname)) {
      continue;
    }

    if (conditionsPass(matcher, ctx.url, ctx.headers)) {
      return true;
    }
  }

  return false;
}
