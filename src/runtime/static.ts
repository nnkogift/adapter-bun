import path from 'node:path';
import type { BunDeploymentManifest, BunStaticAsset } from '../types.ts';
import type { StaticRouteDispatchContext, RouterRuntimeHandlers } from './types.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
};

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function createBunStaticHandler({
  manifest,
  adapterDir,
}: {
  manifest: BunDeploymentManifest;
  adapterDir: string;
}): RouterRuntimeHandlers['serveStatic'] {
  const assetByPathname = new Map<string, BunStaticAsset>();
  for (const asset of manifest.staticAssets) {
    assetByPathname.set(asset.pathname, asset);
  }

  return async (ctx: StaticRouteDispatchContext): Promise<Response> => {
    const asset = ctx.asset;
    const filePath = path.join(adapterDir, asset.stagedPath);
    const file = Bun.file(filePath);

    const exists = await file.exists();
    if (!exists) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const headers = new Headers();

    // Content-Type
    const contentType = asset.contentType ?? inferContentType(filePath);
    headers.set('content-type', contentType);

    // Cache-Control
    if (asset.cacheControl) {
      headers.set('cache-control', asset.cacheControl);
    } else {
      headers.set('cache-control', 'public, max-age=0, must-revalidate');
    }

    // ETag based on file size and modification time
    const stat = file;
    const etag = `"${stat.size.toString(36)}-${stat.lastModified.toString(36)}"`;
    headers.set('etag', etag);

    // Conditional request support
    const ifNoneMatch = ctx.request.headers.get('if-none-match');
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers,
      });
    }

    // HEAD request
    if (ctx.request.method === 'HEAD') {
      headers.set('content-length', String(stat.size));
      return new Response(null, {
        status: 200,
        headers,
      });
    }

    // Serve via Bun.file() zero-copy
    return new Response(file, {
      status: 200,
      headers,
    });
  };
}
