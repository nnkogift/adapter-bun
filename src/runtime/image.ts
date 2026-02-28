import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BunDeploymentManifest } from '../types.ts';
import type { ImageRouteDispatchContext } from './types.ts';

export type ImageCacheState = 'HIT' | 'STALE' | 'MISS' | 'BYPASS';
const IMAGE_CACHE_QUERY_KEYS = ['q', 'url', 'w'] as const;

export interface ImageCacheKey {
  key: string;
  pathname: string;
  query: Record<string, string[]>;
  accept: string | null;
}

export interface ImageCacheEntry {
  cacheKey: string;
  pathname: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'base64';
  createdAt: number;
  revalidateAt: number | null;
  expiresAt: number | null;
}

export interface ImageCacheStore {
  get(cacheKey: string): Promise<ImageCacheEntry | null> | ImageCacheEntry | null;
  set(cacheKey: string, entry: ImageCacheEntry): Promise<void> | void;
  delete?(cacheKey: string): Promise<void> | void;
}

export interface ImageCacheableResponse {
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers: {
    entries(): IterableIterator<[string, string]>;
    get(name: string): string | null;
  };
}

export interface ImageCacheRuntimeOptions {
  store: ImageCacheStore;
  now?: () => number;
  ttlSeconds?: number;
  staleTtlSeconds?: number;
  shouldBypassCache?: (request: Request, cacheKey: ImageCacheKey) => boolean;
  shouldCacheResponse?: (
    response: ImageCacheableResponse,
    cacheKey: ImageCacheKey
  ) => boolean;
}

export type ImageCacheEvaluation =
  | {
      kind: 'miss';
      entry: null;
    }
  | {
      kind: 'fresh';
      entry: ImageCacheEntry;
    }
  | {
      kind: 'stale';
      entry: ImageCacheEntry;
    };

interface ParsedCacheControl {
  cacheable: boolean;
  maxAgeSeconds: number | null;
  staleWhileRevalidateSeconds: number | null;
}

function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath || basePath === '/') {
    return '';
  }
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

function collectQuery(searchParams: URLSearchParams): Record<string, string[]> {
  const query: Record<string, string[]> = {};
  const keys = [...IMAGE_CACHE_QUERY_KEYS].sort((left, right) =>
    left.localeCompare(right)
  );

  for (const key of keys) {
    const values = searchParams.getAll(key);
    if (values.length > 0) {
      query[key] = values;
    }
  }

  return query;
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function parseCacheControl(headerValue: string | null): ParsedCacheControl {
  if (!headerValue) {
    return {
      cacheable: true,
      maxAgeSeconds: null,
      staleWhileRevalidateSeconds: null,
    };
  }

  let cacheable = true;
  let maxAge: number | null = null;
  let sharedMaxAge: number | null = null;
  let staleWhileRevalidate: number | null = null;

  for (const rawToken of headerValue.split(',')) {
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;

    if (token === 'no-store' || token === 'private') {
      cacheable = false;
      continue;
    }

    if (token.startsWith('s-maxage=')) {
      const parsed = parsePositiveInt(token.slice('s-maxage='.length));
      if (parsed !== null) {
        sharedMaxAge = parsed;
      }
      continue;
    }

    if (token.startsWith('max-age=')) {
      const parsed = parsePositiveInt(token.slice('max-age='.length));
      if (parsed !== null) {
        maxAge = parsed;
      }
      continue;
    }

    if (token.startsWith('stale-while-revalidate=')) {
      const parsed = parsePositiveInt(
        token.slice('stale-while-revalidate='.length)
      );
      if (parsed !== null) {
        staleWhileRevalidate = parsed;
      }
    }
  }

  return {
    cacheable,
    maxAgeSeconds: sharedMaxAge ?? maxAge,
    staleWhileRevalidateSeconds: staleWhileRevalidate,
  };
}

function toResponseHeadersRecord(
  headers: ImageCacheableResponse['headers']
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') {
      continue;
    }
    record[key] = value;
  }
  return record;
}

function toCacheDurations({
  cacheControl,
  ttlSeconds,
  staleTtlSeconds,
}: {
  cacheControl: ParsedCacheControl;
  ttlSeconds: number | undefined;
  staleTtlSeconds: number | undefined;
}): { revalidateAfterSeconds: number | null; staleAfterSeconds: number | null } {
  const fallbackTtl = ttlSeconds ?? 3600;
  const effectiveTtlSeconds = cacheControl.maxAgeSeconds ?? fallbackTtl;
  if (effectiveTtlSeconds < 0) {
    return {
      revalidateAfterSeconds: null,
      staleAfterSeconds: null,
    };
  }

  const staleSeconds =
    cacheControl.staleWhileRevalidateSeconds ?? (staleTtlSeconds ?? 0);

  const revalidateAfterSeconds = effectiveTtlSeconds;
  const staleAfterSeconds =
    staleSeconds > 0 ? revalidateAfterSeconds + staleSeconds : revalidateAfterSeconds;

  return {
    revalidateAfterSeconds,
    staleAfterSeconds,
  };
}

export function toImageRoutePath(basePath: string | undefined): string {
  const normalizedBasePath = normalizeBasePath(basePath);
  return `${normalizedBasePath}/_next/image`;
}

export function isImageOptimizationPath(
  pathname: string,
  basePath: string | undefined
): boolean {
  const imagePath = toImageRoutePath(basePath);
  return pathname === imagePath || pathname === `${imagePath}/`;
}

export function createImageCacheKey(
  request: Request,
  basePath: string | undefined
): ImageCacheKey {
  const url = new URL(request.url);
  const pathname = toImageRoutePath(basePath);
  const query = collectQuery(url.searchParams);
  const accept = request.headers.get('accept');
  const payload = JSON.stringify({
    pathname,
    query,
    accept,
  });
  const hash = createHash('sha256').update(payload).digest('hex');

  return {
    key: `image:${pathname}:${hash}`,
    pathname,
    query,
    accept,
  };
}

export function shouldBypassImageCache(
  request: Request,
  cacheKey: ImageCacheKey,
  resolver?: (request: Request, cacheKey: ImageCacheKey) => boolean
): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return true;
  }

  if (resolver) {
    return resolver(request, cacheKey);
  }

  const cacheControl = request.headers.get('cache-control')?.toLowerCase() ?? '';
  if (cacheControl.includes('no-cache') || cacheControl.includes('no-store')) {
    return true;
  }

  const pragma = request.headers.get('pragma')?.toLowerCase() ?? '';
  if (pragma.includes('no-cache')) {
    return true;
  }

  return false;
}

export function evaluateImageCacheEntry({
  entry,
  now,
}: {
  entry: ImageCacheEntry | null;
  now: number;
}): ImageCacheEvaluation {
  if (!entry) {
    return {
      kind: 'miss',
      entry: null,
    };
  }

  if (entry.expiresAt !== null && now >= entry.expiresAt) {
    return {
      kind: 'miss',
      entry: null,
    };
  }

  if (entry.revalidateAt === null || now < entry.revalidateAt) {
    return {
      kind: 'fresh',
      entry,
    };
  }

  return {
    kind: 'stale',
    entry,
  };
}

export function defaultShouldCacheImageResponse(
  response: ImageCacheableResponse
): boolean {
  if (response.status >= 500) {
    return false;
  }

  const cacheControl = parseCacheControl(response.headers.get('cache-control'));
  return cacheControl.cacheable;
}

export async function responseToImageCacheEntry({
  cacheKey,
  pathname,
  response,
  now,
  ttlSeconds,
  staleTtlSeconds,
}: {
  cacheKey: string;
  pathname: string;
  response: ImageCacheableResponse;
  now: number;
  ttlSeconds?: number;
  staleTtlSeconds?: number;
}): Promise<ImageCacheEntry> {
  const bodyBuffer = Buffer.from(await response.arrayBuffer());
  const cacheControl = parseCacheControl(response.headers.get('cache-control'));
  const durations = toCacheDurations({
    cacheControl,
    ttlSeconds,
    staleTtlSeconds,
  });

  return {
    cacheKey,
    pathname,
    status: response.status,
    headers: toResponseHeadersRecord(response.headers),
    body: bodyBuffer.toString('base64'),
    bodyEncoding: 'base64',
    createdAt: now,
    revalidateAt:
      durations.revalidateAfterSeconds === null
        ? null
        : now + durations.revalidateAfterSeconds * 1000,
    expiresAt:
      durations.staleAfterSeconds === null
        ? null
        : now + durations.staleAfterSeconds * 1000,
  };
}

export function imageCacheEntryToResponse(entry: ImageCacheEntry): Response {
  const body = Buffer.from(entry.body, 'base64');
  return new Response(body, {
    status: entry.status,
    headers: entry.headers,
  });
}

export class InMemoryImageCacheStore implements ImageCacheStore {
  #entries = new Map<string, ImageCacheEntry>();

  async get(cacheKey: string): Promise<ImageCacheEntry | null> {
    return this.#entries.get(cacheKey) ?? null;
  }

  async set(cacheKey: string, entry: ImageCacheEntry): Promise<void> {
    this.#entries.set(cacheKey, entry);
  }

  async delete(cacheKey: string): Promise<void> {
    this.#entries.delete(cacheKey);
  }
}

// --- Sharp image handler ---

export interface BunImageHandlerOptions {
  manifest: BunDeploymentManifest;
  adapterDir: string;
}

type SharpFormat = 'avif' | 'webp' | 'png' | 'jpeg' | 'gif' | 'tiff';

function matchesHostnameGlob(hostname: string, pattern: string): boolean {
  if (pattern === '**') return true;

  // Convert glob to regex: ** matches anything, * matches non-dot segments
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^.]+')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  return new RegExp(`^${regex}$`).test(hostname);
}

function matchesPathnameGlob(pathname: string, pattern: string): boolean {
  if (!pattern) return true;

  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]+')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  return new RegExp(`^${regex}`).test(pathname);
}

function matchesRemotePattern(
  url: URL,
  pattern: BunDeploymentManifest['imageConfig'] extends infer C
    ? C extends { remotePatterns: Array<infer P> }
      ? P
      : never
    : never
): boolean {
  if (pattern.protocol && url.protocol !== `${pattern.protocol}:`) {
    return false;
  }
  if (!matchesHostnameGlob(url.hostname, pattern.hostname)) {
    return false;
  }
  if (pattern.port && url.port !== pattern.port) {
    return false;
  }
  if (pattern.pathname && !matchesPathnameGlob(url.pathname, pattern.pathname)) {
    return false;
  }
  return true;
}

function matchesLocalPattern(
  pathname: string,
  pattern: { pathname?: string; search?: string }
): boolean {
  if (!pattern.pathname) return true;
  return matchesPathnameGlob(pathname, pattern.pathname);
}

function negotiateFormat(
  acceptHeader: string | null,
  configFormats: string[]
): SharpFormat | null {
  if (!acceptHeader) return null;

  const accept = acceptHeader.toLowerCase();
  const formatPriority: SharpFormat[] = ['avif', 'webp'];

  for (const format of formatPriority) {
    if (configFormats.includes(`image/${format}`) && accept.includes(`image/${format}`)) {
      return format;
    }
  }

  return null;
}

function contentTypeForFormat(format: SharpFormat): string {
  switch (format) {
    case 'avif':
      return 'image/avif';
    case 'webp':
      return 'image/webp';
    case 'png':
      return 'image/png';
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}

function detectFormatFromContentType(contentType: string | null): SharpFormat | null {
  if (!contentType) return null;
  const lower = contentType.toLowerCase();
  if (lower.includes('image/png')) return 'png';
  if (lower.includes('image/jpeg') || lower.includes('image/jpg')) return 'jpeg';
  if (lower.includes('image/webp')) return 'webp';
  if (lower.includes('image/avif')) return 'avif';
  if (lower.includes('image/gif')) return 'gif';
  if (lower.includes('image/tiff')) return 'tiff';
  if (lower.includes('image/svg+xml')) return null; // SVG handled separately
  return null;
}

export function createBunImageHandler(
  options: BunImageHandlerOptions
): (ctx: ImageRouteDispatchContext) => Promise<Response> {
  const { manifest, adapterDir } = options;
  const imageConfig = manifest.imageConfig;

  if (!imageConfig) {
    return async () =>
      new Response('Image optimization not configured', { status: 500 });
  }

  const allowedWidths = new Set([
    ...imageConfig.deviceSizes,
    ...imageConfig.imageSizes,
  ]);

  return async (ctx: ImageRouteDispatchContext): Promise<Response> => {
    const requestUrl = new URL(ctx.request.url);
    const urlParam = requestUrl.searchParams.get('url');
    const wParam = requestUrl.searchParams.get('w');
    const qParam = requestUrl.searchParams.get('q');

    if (!urlParam) {
      return new Response('"url" parameter is required', { status: 400 });
    }

    if (!wParam) {
      return new Response('"w" parameter is required', { status: 400 });
    }

    const width = Number.parseInt(wParam, 10);
    if (Number.isNaN(width) || !allowedWidths.has(width)) {
      return new Response(`"w" parameter must be one of: ${[...allowedWidths].sort((a, b) => a - b).join(', ')}`, {
        status: 400,
      });
    }

    const quality = qParam ? Number.parseInt(qParam, 10) : 75;
    if (Number.isNaN(quality) || quality < 1 || quality > 100) {
      return new Response('"q" parameter must be between 1 and 100', {
        status: 400,
      });
    }

    // Determine if local or remote
    let sourceBuffer: Buffer;
    let sourceContentType: string | null = null;
    const isAbsoluteUrl = urlParam.startsWith('http://') || urlParam.startsWith('https://');

    if (isAbsoluteUrl) {
      // Remote image
      const remoteUrl = new URL(urlParam);

      const isAllowed = imageConfig.remotePatterns.some((pattern) =>
        matchesRemotePattern(remoteUrl, pattern)
      );
      if (!isAllowed) {
        return new Response('URL not allowed by remotePatterns', { status: 403 });
      }

      const response = await fetch(urlParam);
      if (!response.ok) {
        return new Response(`Failed to fetch remote image: ${response.status}`, {
          status: 502,
        });
      }

      sourceContentType = response.headers.get('content-type');
      sourceBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      // Local image
      const localPathname = urlParam.startsWith('/') ? urlParam : `/${urlParam}`;

      // Check against localPatterns if defined
      if (imageConfig.localPatterns && imageConfig.localPatterns.length > 0) {
        const isAllowed =
          localPathname.startsWith('/_next/static') ||
          imageConfig.localPatterns.some((pattern) =>
            matchesLocalPattern(localPathname, pattern)
          );
        if (!isAllowed) {
          return new Response('Path not allowed by localPatterns', { status: 403 });
        }
      }

      // Resolve local file path — check static assets directory
      const staticRoot = path.join(adapterDir, manifest.artifacts.staticRoot);
      const filePath = path.join(staticRoot, localPathname);

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return new Response('Image not found', { status: 404 });
      }

      sourceContentType = file.type;
      sourceBuffer = Buffer.from(await file.arrayBuffer());
    }

    // Block SVG unless allowed
    const isSvg =
      sourceContentType?.includes('image/svg+xml') ||
      urlParam.endsWith('.svg');
    if (isSvg && !imageConfig.dangerouslyAllowSVG) {
      return new Response('SVG images are not allowed', { status: 400 });
    }

    // SVG pass-through (no transformation needed)
    if (isSvg) {
      return new Response(sourceBuffer, {
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': `public, max-age=${imageConfig.minimumCacheTTL}`,
          Vary: 'Accept',
        },
      });
    }

    // Negotiate output format
    const acceptHeader = ctx.request.headers.get('accept');
    const negotiatedFormat = negotiateFormat(acceptHeader, imageConfig.formats);
    const originalFormat = detectFormatFromContentType(sourceContentType);
    const outputFormat = negotiatedFormat ?? originalFormat ?? 'jpeg';

    // Use sharp to process
    const sharp = (await import('sharp')).default;
    let pipeline = sharp(sourceBuffer).resize({ width, withoutEnlargement: true });

    switch (outputFormat) {
      case 'avif':
        pipeline = pipeline.avif({ quality });
        break;
      case 'webp':
        pipeline = pipeline.webp({ quality });
        break;
      case 'png':
        pipeline = pipeline.png({ quality });
        break;
      case 'jpeg':
        pipeline = pipeline.jpeg({ quality });
        break;
      case 'gif':
        pipeline = pipeline.gif();
        break;
      case 'tiff':
        pipeline = pipeline.tiff({ quality });
        break;
    }

    const outputBuffer = await pipeline.toBuffer();

    return new Response(outputBuffer, {
      headers: {
        'Content-Type': contentTypeForFormat(outputFormat),
        'Cache-Control': `public, max-age=${imageConfig.minimumCacheTTL}`,
        Vary: 'Accept',
      },
    });
  };
}
