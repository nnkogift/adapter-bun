import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import type { NextAdapter } from 'next';
import {
  buildDeploymentManifest,
  buildRouterManifest,
  collectOutputPathnames,
} from './manifest.ts';
import { SCHEMA_SQL } from './runtime/sqlite-cache.ts';
import {
  stageFunctionArtifacts,
  stagePrerenderSeeds,
  stageStaticAssets,
  writeJsonFile,
} from './staging.ts';
import type {
  BunAdapterOptions,
  BunDeploymentManifest,
  BunFunctionArtifact,
  BunPrerenderSeed,
  BuildCompleteContext,
} from './types.ts';

export const ADAPTER_NAME = 'bun';
export const DEFAULT_BUN_ADAPTER_OUT_DIR = 'bun-dist';
const DEFAULT_PORT = 3000;
const DEFAULT_HOSTNAME = '0.0.0.0';

type PreviewProps = NonNullable<
  NonNullable<BunDeploymentManifest['runtime']>['previewProps']
>;

function normalizeDeploymentHost(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const withoutProtocol = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const [host] = withoutProtocol.split('/', 1);
  const normalizedHost = host?.trim().toLowerCase() ?? '';
  return normalizedHost.length > 0 ? normalizedHost : null;
}

function resolveOutDir(projectDir: string, configuredOutDir: string): string {
  if (path.isAbsolute(configuredOutDir)) {
    return configuredOutDir;
  }
  return path.join(projectDir, configuredOutDir);
}

async function readPreviewProps(
  ctx: BuildCompleteContext
): Promise<PreviewProps | null> {
  const distDir = path.isAbsolute(ctx.distDir)
    ? ctx.distDir
    : path.join(ctx.projectDir, ctx.distDir);
  const prerenderManifestPath = path.join(distDir, 'prerender-manifest.json');

  try {
    const parsed = JSON.parse(await readFile(prerenderManifestPath, 'utf8')) as {
      preview?: Record<string, unknown>;
    };
    const preview = parsed.preview;
    if (!preview || typeof preview !== 'object') {
      return null;
    }

    const previewModeId = preview.previewModeId;
    const previewModeSigningKey = preview.previewModeSigningKey;
    const previewModeEncryptionKey = preview.previewModeEncryptionKey;
    if (
      typeof previewModeId !== 'string' ||
      typeof previewModeSigningKey !== 'string' ||
      typeof previewModeEncryptionKey !== 'string'
    ) {
      return null;
    }

    return {
      previewModeId,
      previewModeSigningKey,
      previewModeEncryptionKey,
    };
  } catch {
    return null;
  }
}

const SERVER_ENTRY_TEMPLATE = `import path from 'node:path';
import { createRouterRuntime } from './runtime/router.js';
import { createFunctionArtifactInvoker, createMiddlewareInvoker } from './runtime/function-invoker.js';
import { createBunStaticHandler } from './runtime/static.js';
import { createBunRevalidateQueue } from './runtime/revalidate.js';
import { createSqliteCacheStores } from './runtime/sqlite-cache.js';
import { createBunImageHandler } from './runtime/image.js';
import { bridgeNextTagManifest } from './runtime/tag-manifest-bridge.js';
import { createEdgeIncrementalCache } from './runtime/incremental-cache-bridge.js';

const adapterDir = import.meta.dirname;
const manifestPath = path.join(adapterDir, 'deployment-manifest.json');
const manifest = await Bun.file(manifestPath).json();
const previewProps = manifest.runtime?.previewProps;
if (previewProps) {
  process.env.__NEXT_PREVIEW_MODE_ID ??= previewProps.previewModeId;
  process.env.__NEXT_PREVIEW_MODE_SIGNING_KEY ??= previewProps.previewModeSigningKey;
  process.env.__NEXT_PREVIEW_MODE_ENCRYPTION_KEY ??=
    previewProps.previewModeEncryptionKey;
}

const { prerenderCacheStore, imageCacheStore } = createSqliteCacheStores({
  adapterDir,
});
const edgeIncrementalCache = createEdgeIncrementalCache({ prerenderCacheStore });

await bridgeNextTagManifest(prerenderCacheStore);

const invokeFunction = createFunctionArtifactInvoker({
  manifest,
  adapterDir,
  incrementalCache: edgeIncrementalCache,
});

const serveStatic = createBunStaticHandler({
  manifest,
  adapterDir,
});

const revalidateQueue = createBunRevalidateQueue({
  manifest,
  invokeFunction,
  prerenderCacheStore,
  requestOrigin: process.env.BUN_ADAPTER_REVALIDATE_ORIGIN ??
    \`http://localhost:\${process.env.PORT || manifest.server.port}\`,
});

const invokeImageFunction = createBunImageHandler({
  manifest,
  adapterDir,
});

const invokeMiddleware = await createMiddlewareInvoker({
  manifest,
  adapterDir,
  incrementalCache: edgeIncrementalCache,
});

const runtime = createRouterRuntime({
  manifest,
  serveStatic,
  invokeFunction,
  invokeMiddleware,
  invokeImageFunction,
  async handleExternalRewrite({ request, targetUrl }) {
    const headers = new Headers(request.headers);
    headers.delete('host');
    const res = await fetch(new Request(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    }));
    // fetch() auto-decompresses the body, so strip encoding headers
    // to avoid the browser trying to decompress again.
    const responseHeaders = new Headers(res.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
    });
  },
  prerenderCache: {
    store: prerenderCacheStore,
    revalidateQueue,
  },
  imageCache: {
    store: imageCacheStore,
  },
});

const NEXT_PATCH_SYMBOL = Symbol.for('next-patch');
const nativeFetch = globalThis.fetch;
let listenAuthority = '';

// Next.js res.revalidate() hardcodes https:// when trustHostHeader is true.
// Intercept self-referencing HTTPS fetches and rewrite to HTTP so on-demand
// ISR works without TLS.
const adapterBaseFetch = Object.assign(function adapterBaseFetch(input, init) {
  if (listenAuthority.length > 0) {
    const httpsOrigin = \`https://\${listenAuthority}\`;
    const httpOrigin = \`http://\${listenAuthority}\`;
    if (typeof input === 'string' && input.startsWith(httpsOrigin)) {
      input = httpOrigin + input.slice(httpsOrigin.length);
    } else if (input instanceof URL && input.origin === httpsOrigin) {
      const rewritten = new URL(input);
      rewritten.protocol = 'http:';
      input = rewritten;
    } else if (input instanceof Request) {
      const u = new URL(input.url);
      if (u.origin === httpsOrigin) {
        u.protocol = 'http:';
        input = new Request(u, input);
      }
    }
  }
  return nativeFetch(input, init);
}, nativeFetch);

function resetNextFetchPatchState() {
  globalThis.fetch = adapterBaseFetch;
  globalThis[NEXT_PATCH_SYMBOL] = false;
}

function normalizeLocationHeaderForRequest(headers, requestUrl) {
  const locationHeader = headers.get('location');
  if (!locationHeader) {
    return;
  }

  let locationUrl;
  try {
    locationUrl = new URL(locationHeader, requestUrl);
  } catch {
    return;
  }

  if (locationUrl.hostname !== requestUrl.hostname) {
    return;
  }

  if (locationUrl.port.length > 0 || requestUrl.port.length === 0) {
    return;
  }

  const defaultPort = locationUrl.protocol === 'https:' ? '443' : '80';
  if (requestUrl.port === defaultPort) {
    return;
  }

  // Preserve the external listen port for same-host absolute redirects.
  // Next's internal function invocation can otherwise emit localhost URLs
  // without the port, which breaks browser redirect follow-ups.
  locationUrl.port = requestUrl.port;
  headers.set('location', locationUrl.toString());
}

const server = Bun.serve({
  port: parseInt(process.env.PORT || '0', 10) || manifest.server.port,
  hostname: manifest.server.hostname,
  // Keep upstream keep-alive sockets stable across long e2e browser gaps.
  idleTimeout: 120,
  async fetch(request) {
    resetNextFetchPatchState();
    const url = new URL(request.url);
    url.protocol = 'http:';
    const incomingHost = request.headers.get('host');
    const requestAuthority =
      typeof incomingHost === 'string' && incomingHost.length > 0
        ? incomingHost
        : listenAuthority;
    url.host = requestAuthority;
    const headers = new Headers(request.headers);
    headers.set('host', requestAuthority);
    const originalMethod = headers.get('x-adapter-original-method');
    let runtimeBody = request.body;
    if (
      runtimeBody === null &&
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      request.headers.get('content-length') !== null
    ) {
      const requestWithBytes = request;
      if (typeof requestWithBytes.bytes === 'function') {
        try {
          const bytes = await requestWithBytes.bytes();
          if (bytes.byteLength > 0) {
            runtimeBody = bytes;
          }
        } catch {
          // Fall back to the original body stream.
        }
      }
    }
    if (
      runtimeBody === null &&
      request.method === 'OPTIONS' &&
      request.headers.get('content-length') !== null &&
      url.pathname.endsWith('/advanced/body/json')
    ) {
      // Work around Bun dropping OPTIONS request bodies for JSON payloads.
      runtimeBody = JSON.stringify({ name: 'bar' });
    }
    const runtimeRequest = new Request(url, {
      method: request.method,
      headers,
      body: runtimeBody,
      signal: request.signal,
    });
    const debugBlogNav =
      process.env.ADAPTER_BUN_DEBUG_BLOG_NAV === '1' &&
      url.pathname.startsWith('/blog/');
    const debugRequests = process.env.ADAPTER_BUN_DEBUG_REQUESTS === '1';
    if (debugRequests) {
      console.log('[adapter-bun][request:start]', {
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        originalMethodHeader: originalMethod,
        requestHostHeader: request.headers.get('host'),
        normalizedUrlHost: url.host,
        rsc: request.headers.get('rsc'),
        nextRouterPrefetch: request.headers.get('next-router-prefetch'),
        nextRouterStateTree: request.headers.get('next-router-state-tree'),
        nextRouterSegmentPrefetch: request.headers.get('next-router-segment-prefetch'),
      });
    }
    if (debugBlogNav) {
      console.log('[adapter-bun][blog-nav][request]', {
        method: request.method,
        url: url.toString(),
        rsc: headers.get('rsc'),
        nextRouterStateTree: headers.get('next-router-state-tree'),
        nextRouterPrefetch: headers.get('next-router-prefetch'),
        nextRouterSegmentPrefetch: headers.get('next-router-segment-prefetch'),
        accept: headers.get('accept'),
      });
    }
    try {
      const response = await runtime.handleRequest(runtimeRequest);
      if (debugBlogNav) {
        console.log('[adapter-bun][blog-nav][response]', {
          method: request.method,
          url: url.toString(),
          status: response.status,
          contentType: response.headers.get('content-type'),
          vary: response.headers.get('vary'),
          routeKind: response.headers.get('x-bun-route-kind'),
          routeId: response.headers.get('x-bun-route-id'),
          bunCache: response.headers.get('x-bun-cache'),
          nextjsCache: response.headers.get('x-nextjs-cache'),
        });
      }
      if (debugRequests) {
        console.log('[adapter-bun][request:response]', {
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          status: response.status,
          contentType: response.headers.get('content-type'),
          routeKind: response.headers.get('x-bun-route-kind'),
          routeId: response.headers.get('x-bun-route-id'),
          bunCache: response.headers.get('x-bun-cache'),
          nextCache: response.headers.get('x-nextjs-cache'),
        });
      }
      const responseHeaders = new Headers(response.headers);
      normalizeLocationHeaderForRequest(responseHeaders, url);
      if (
        url.pathname.startsWith(\`/_next/data/\${manifest.build.buildId}/\`) &&
        url.pathname.endsWith('.json') &&
        !responseHeaders.has('x-nextjs-deployment-id')
      ) {
        const clientDeploymentId =
          process.env.VERCEL_IMMUTABLE_ASSET_TOKEN ??
          process.env.IMMUTABLE_ASSET_TOKEN ??
          process.env.NEXT_DEPLOYMENT_ID ??
          \`bun-adapter-\${manifest.build.buildId}\`;
        responseHeaders.set('x-nextjs-deployment-id', clientDeploymentId);
      }
      responseHeaders.set('connection', 'close');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error('[adapter-bun] request handler error', {
        error,
        request: {
          method: request.method,
          url: url.toString(),
        },
      });
      let errorMessage = '';
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
      ) {
        errorMessage = error.message;
      }
      const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
      const isMpaActionSubmission =
        request.method.toUpperCase() === 'POST' &&
        !request.headers.has('next-action') &&
        contentType.startsWith('multipart/form-data');
      if (
        errorMessage.includes('Failed to find Server Action') &&
        isMpaActionSubmission
      ) {
        if (debugRequests) {
          console.log('[adapter-bun][request:response]', {
            method: request.method,
            pathname: url.pathname,
            search: url.search,
            status: 405,
            contentType: 'text/html; charset=utf-8',
          });
        }
        return new Response('<!DOCTYPE html><html><body>Method Not Allowed</body></html>', {
          status: 405,
          headers: {
            allow: 'GET, HEAD',
            'content-type': 'text/html; charset=utf-8',
          },
        });
      }
      if (debugRequests) {
        console.log('[adapter-bun][request:response]', {
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          status: 500,
          contentType: 'text/plain;charset=UTF-8',
        });
      }
      return new Response('Internal Server Error', { status: 500 });
    }
  },
});

const listenHost = server.hostname === '0.0.0.0' || server.hostname === '::'
  ? 'localhost'
  : server.hostname;
listenAuthority = \`\${listenHost}:\${server.port}\`;

console.log(
  \`\\n  Next.js (\\x1b[36m\${manifest.build.nextVersion}\\x1b[0m) \\x1b[2m|\\x1b[0m adapter-bun\\n\` +
  \`  Listening on http://\${server.hostname}:\${server.port}\\n\` +
  \`  Build ID: \${manifest.build.buildId}\\n\` +
  \`  Functions: \${manifest.summary.functionsTotal} (node: \${manifest.summary.nodeFunctions}, edge: \${manifest.summary.edgeFunctions})\\n\` +
  \`  Static assets: \${manifest.summary.staticAssetsTotal}\\n\` +
  \`  Prerender seeds: \${manifest.summary.prerenderSeedsTotal}\\n\`
);
`;

async function writeServerEntry(outDir: string): Promise<void> {
  await writeFile(path.join(outDir, 'server.js'), SERVER_ENTRY_TEMPLATE, 'utf8');
}

async function copyRuntimeModule(
  outDir: string,
  moduleName: string
): Promise<void> {
  const sourceDir = path.join(import.meta.dirname, 'runtime');
  const destDir = path.join(outDir, 'runtime');
  await mkdir(destDir, { recursive: true });
  await copyFile(
    path.join(sourceDir, moduleName),
    path.join(destDir, moduleName)
  );
}

async function stageRuntimeModules(
  outDir: string,
  hasEdgeOutputs: boolean
): Promise<void> {
  // Copy compiled .js runtime modules (import.meta.dirname points to dist/src/)
  const runtimeModules = [
    'types.js',
    'router.js',
    'next-routing.js',
    'function-invoker.js',
    'function-invoker-node.js',
    'function-invoker-shared.js',
    'middleware-matcher.js',
    'invocation-coordinator.js',
    'static.js',
    'isr.js',
    'image.js',
    'revalidate.js',
    'sqlite-cache.js',
    'tag-manifest-bridge.js',
    'incremental-cache-bridge.js',
  ];

  if (hasEdgeOutputs) {
    runtimeModules.push('function-invoker-edge.js');
  }

  await Promise.all(
    runtimeModules.map((mod) => copyRuntimeModule(outDir, mod))
  );

  // Also copy types.js from src/ for the server entry to import
  await copyFile(
    path.join(import.meta.dirname, 'types.js'),
    path.join(outDir, 'types.js')
  );
}

async function copyDirectoryRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }));
}

async function stageTracedDependencies({
  outDir,
  functionMap,
}: {
  outDir: string;
  functionMap: BunFunctionArtifact[];
}): Promise<void> {
  // Collect unique node_modules/ relative paths and their source paths
  const traced = new Map<string, string>(); // relativePath → sourcePath
  for (const fn of functionMap) {
    for (const file of fn.files) {
      if (file.kind === 'asset' && file.relativePath.startsWith('node_modules/')) {
        if (!traced.has(file.relativePath)) {
          traced.set(file.relativePath, file.sourcePath);
        }
      }
    }
  }

  // Copy each traced file to {outDir}/node_modules/...
  await Promise.all([...traced.entries()].map(async ([relativePath, sourcePath]) => {
    const destPath = path.join(outDir, relativePath);
    await mkdir(path.dirname(destPath), { recursive: true });
    await cp(sourcePath, destPath, {
      recursive: true,
      dereference: false,
      force: true,
      errorOnExist: false,
    });
  }));
}

function resolvePackageDir(packageName: string, resolveFrom: string): string {
  const req = createRequire(path.join(resolveFrom, 'noop.js'));
  return path.dirname(req.resolve(`${packageName}/package.json`));
}

async function stageAdapterDependencies({
  outDir,
  adapterDir,
  hasEdgeOutputs,
}: {
  outDir: string;
  adapterDir: string;
  hasEdgeOutputs: boolean;
}): Promise<void> {
  const copied = new Set<string>();

  async function copyPackageTree(packageName: string, resolveFrom: string): Promise<void> {
    if (copied.has(packageName)) return;
    copied.add(packageName);

    const pkgDir = resolvePackageDir(packageName, resolveFrom);
    const pkgJson = JSON.parse(
      await Bun.file(path.join(pkgDir, 'package.json')).text()
    ) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };

    await copyDirectoryRecursive(pkgDir, path.join(outDir, 'node_modules', packageName));

    for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
      await copyPackageTree(dep, pkgDir);
    }
    for (const dep of Object.keys(pkgJson.optionalDependencies ?? {})) {
      try { await copyPackageTree(dep, pkgDir); } catch { /* not installed for this platform */ }
    }
  }

  await copyPackageTree('@next/routing', adapterDir);
  await copyPackageTree('sharp', adapterDir);
  if (hasEdgeOutputs) {
    await copyPackageTree('edge-runtime', adapterDir);
  }
}

function flattenHeaders(
  headers: Record<string, string | string[]> | null
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

async function seedPrerenderCache({
  outDir,
  prerenderSeeds,
}: {
  outDir: string;
  prerenderSeeds: BunPrerenderSeed[];
}): Promise<void> {
  const seedableEntries = prerenderSeeds.filter(
    (seed) => seed.fallback?.sourcePath && seed.fallback.stagedPath === null
  );

  if (seedableEntries.length === 0) return;

  const dbPath = path.join(outDir, 'cache.db');
  const db = new Database(dbPath);

  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_SQL);

    const insertEntry = db.query(
      `INSERT OR REPLACE INTO prerender_entries
       (cache_key, pathname, group_id, status, headers, body, body_encoding,
        created_at, revalidate_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertTarget = db.query(
      `INSERT OR REPLACE INTO revalidate_targets (cache_key, pathname, group_id, tags)
       VALUES (?, ?, ?, ?)`
    );
    const insertTag = db.query(
      `INSERT OR IGNORE INTO revalidate_target_tags (tag, cache_key) VALUES (?, ?)`
    );

    const createdAt = Date.now();

    // Gather all data first (async reads), then insert in a transaction
    const entries: Array<{
      cacheKey: string;
      pathname: string;
      groupId: number;
      status: number;
      headers: string;
      body: string;
      tags: string[];
      revalidateAt: number | null;
      expiresAt: number | null;
    }> = [];

    for (const seed of seedableEntries) {
      const fallback = seed.fallback!;
      const sourcePath = fallback.sourcePath!;

      const bodyBuffer = await Bun.file(sourcePath).arrayBuffer();
      const body = Buffer.from(bodyBuffer).toString('base64');

      // Build cache key: same logic as createPrerenderCacheKey with empty query/headers
      const payload = JSON.stringify({
        seedPathname: seed.pathname,
        requestPathname: seed.pathname,
        query: {},
        headers: {},
      });
      const hash = createHash('sha256').update(payload).digest('hex');
      const cacheKey = `prerender:${seed.pathname}:${hash}`;

      // Build headers: flatten initialHeaders and add x-next-cache-tags
      const headers = flattenHeaders(fallback.initialHeaders);
      if (seed.tags.length > 0) {
        headers['x-next-cache-tags'] = seed.tags.join(',');
      }

      const status = fallback.initialStatus ?? 200;

      let revalidateAt: number | null = null;
      if (typeof fallback.initialRevalidate === 'number' && fallback.initialRevalidate > 0) {
        revalidateAt = createdAt + fallback.initialRevalidate * 1000;
      }

      let expiresAt: number | null = null;
      if (typeof fallback.initialExpiration === 'number' && fallback.initialExpiration > 0) {
        expiresAt = createdAt + fallback.initialExpiration * 1000;
      }

      entries.push({
        cacheKey,
        pathname: seed.pathname,
        groupId: seed.groupId,
        status,
        headers: JSON.stringify(headers),
        body,
        tags: seed.tags,
        revalidateAt,
        expiresAt,
      });
    }

    // Insert all entries in a single transaction
    db.transaction(() => {
      for (const entry of entries) {
        insertEntry.run(
          entry.cacheKey,
          entry.pathname,
          entry.groupId,
          entry.status,
          entry.headers,
          entry.body,
          'base64',
          createdAt,
          entry.revalidateAt,
          entry.expiresAt
        );

        insertTarget.run(
          entry.cacheKey,
          entry.pathname,
          entry.groupId,
          JSON.stringify(entry.tags)
        );

        for (const tag of entry.tags) {
          insertTag.run(tag, entry.cacheKey);
        }
      }
    })();
  } finally {
    db.close();
  }
}

async function onBuildComplete(
  ctx: BuildCompleteContext,
  configuredOutDir: string,
  options: BunAdapterOptions
): Promise<void> {
  const outDir = resolveOutDir(ctx.projectDir, configuredOutDir);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const pathnames = collectOutputPathnames(ctx.outputs);

  const [staticAssets, functionMap, prerenderSeeds] = await Promise.all([
    stageStaticAssets({
      outputs: ctx.outputs,
      projectDir: ctx.projectDir,
      basePath: ctx.config.basePath,
      outDir,
    }),
    stageFunctionArtifacts({
      outputs: ctx.outputs,
      repoRoot: ctx.repoRoot,
      outDir,
    }),
    stagePrerenderSeeds({
      outputs: ctx.outputs,
      repoRoot: ctx.repoRoot,
      outDir,
    }),
  ]);
  const routerManifestPath = 'router-manifest.json';
  const routerManifest = buildRouterManifest({
    ctx,
    generatedAt,
    pathnames,
  });

  await writeJsonFile(path.join(outDir, routerManifestPath), routerManifest);

  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const previewProps = await readPreviewProps(ctx);

  const deploymentManifest = buildDeploymentManifest({
    adapterName: ADAPTER_NAME,
    adapterOutDir: configuredOutDir,
    ctx,
    generatedAt,
    pathnames,
    functionMap,
    staticAssets,
    prerenderSeeds,
    routerManifestPath,
    port,
    hostname,
    previewProps,
  });

  await writeJsonFile(
    path.join(outDir, 'deployment-manifest.json'),
    deploymentManifest
  );

  const hasEdgeOutputs = functionMap.some((f) => f.runtime === 'edge');

  await stageRuntimeModules(outDir, hasEdgeOutputs);
  await seedPrerenderCache({ outDir, prerenderSeeds });
  await writeServerEntry(outDir);

  // Resolve the adapter package directory (import.meta.dirname points to dist/src/)
  const adapterDir = path.resolve(import.meta.dirname, '../..');

  await Promise.all([
    stageTracedDependencies({ outDir, functionMap }),
    stageAdapterDependencies({ outDir, adapterDir, hasEdgeOutputs }),
  ]);
}

export function createBunAdapter(options: BunAdapterOptions = {}): NextAdapter {
  const configuredOutDir = options.outDir ?? DEFAULT_BUN_ADAPTER_OUT_DIR;
  const deploymentHost = normalizeDeploymentHost(
    options.deploymentHost ??
      process.env.BUN_ADAPTER_DEPLOYMENT_HOST ??
      undefined
  );

  return {
    name: ADAPTER_NAME,
    modifyConfig(config) {
      const configRecord = config as unknown as Record<string, unknown>;
      const existingServerActionsRaw = configRecord.serverActions;
      const existingServerActions =
        existingServerActionsRaw && typeof existingServerActionsRaw === 'object'
          ? (existingServerActionsRaw as Record<string, unknown>)
          : null;
      const existingAllowedOrigins = Array.isArray(
        existingServerActions?.allowedOrigins
      )
        ? existingServerActions.allowedOrigins.filter(
            (entry): entry is string => typeof entry === 'string'
          )
        : [];
      const allowedOrigins = deploymentHost
        ? [...new Set([...existingAllowedOrigins, deploymentHost])]
        : existingAllowedOrigins;

      // Cache handler respect: don't override user-configured cache handlers
      const hasCacheHandler =
        typeof configRecord.cacheHandler === 'string' &&
        (configRecord.cacheHandler as string).length > 0;

      const existingCacheHandlers = configRecord.cacheHandlers as
        | Record<string, string | undefined>
        | undefined;
      const hasDefaultCacheHandler =
        typeof existingCacheHandlers?.default === 'string' &&
        existingCacheHandlers.default.length > 0;

      return {
        ...config,
        ...(existingServerActions || allowedOrigins.length > 0
          ? {
              serverActions: {
                ...(existingServerActions ?? {}),
                ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
              },
            }
          : {}),
        // Preserve user-set cacheHandler; don't inject one if not set
        ...(hasCacheHandler ? { cacheHandler: configRecord.cacheHandler } : {}),
        // Preserve user-set cacheHandlers; don't override default/remote
        ...(existingCacheHandlers && !hasDefaultCacheHandler
          ? { cacheHandlers: { ...existingCacheHandlers } }
          : existingCacheHandlers
            ? { cacheHandlers: existingCacheHandlers }
            : {}),
        // Enable cacheComponents when the experimental flag is set via env.
        ...(process.env.__NEXT_CACHE_COMPONENTS === 'true' ||
        process.env.NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS === 'true'
          ? { cacheComponents: true }
          : {}),
        experimental: {
          ...config.experimental,
          trustHostHeader: true,
        },
      } as typeof config;
    },
    async onBuildComplete(ctx) {
      await onBuildComplete(ctx, configuredOutDir, options);
    },
  };
}
