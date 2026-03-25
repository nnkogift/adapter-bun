import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import type { NextAdapter } from 'next';
import type { AdapterOutput } from 'next';
import type { IncrementalCacheValue } from './next-compat-types.js';
import {
  buildDeploymentManifest,
  collectOutputPathnames,
} from './manifest.ts';
import { encodeCacheValue } from './runtime/incremental-cache-codec.ts';
import { SCHEMA_SQL } from './runtime/sqlite-cache.ts';
import {
  stageStaticAssets,
  writeJsonFile,
} from './staging.ts';
import type {
  BunAdapterOptions,
  BunRuntimeAssetBinding,
  BunDeploymentManifest,
  BunRuntimeFunctionOutput,
  BunResolvedPathnameSourcePageMap,
  BuildCompleteContext,
} from './types.ts';

export const ADAPTER_NAME = 'bun';
export const DEFAULT_BUN_ADAPTER_OUT_DIR = 'bun-dist';
const DEFAULT_PORT = 3000;
const DEFAULT_HOSTNAME = '0.0.0.0';
const DEFAULT_CACHE_HANDLER_MODE = 'http';
const DEFAULT_CACHE_ENDPOINT_PATH = '/_adapter/cache';
const RUNTIME_NEXT_CONFIG_FILE = 'runtime-next-config.json';
const RSC_SUFFIX = '.rsc';
const SEGMENT_RSC_SUFFIX = '.segment.rsc';
const CACHE_RUNTIME_MODULES = [
  'early-timers.js',
  'next-compat.js',
  'cache-handler.js',
  'cache-handler-http.js',
  'cache-http-client.js',
  'cache-http-protocol.js',
  'cache-http-server.js',
  'incremental-cache-handler.js',
  'incremental-cache-codec.js',
  'incremental-cache-handler-http.js',
  'binary.js',
  'cache-store.js',
  'sqlite-cache.js',
  'isr.js',
];

type PreviewProps = NonNullable<
  NonNullable<BunDeploymentManifest['runtime']>['previewProps']
>;
type CacheRuntimeConfig = NonNullable<
  NonNullable<BunDeploymentManifest['runtime']>['cache']
>;
type RuntimeRoutingConfig = NonNullable<
  NonNullable<BunDeploymentManifest['runtime']>['routing']
>;
type BuildRoute = BuildCompleteContext['routing']['beforeFiles'][number];
type BuildRouteHas = NonNullable<BuildRoute['has']>[number];

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

function resolveCacheHandlerMode(
  options: BunAdapterOptions
): 'sqlite' | 'http' {
  return options.cacheHandlerMode ?? DEFAULT_CACHE_HANDLER_MODE;
}

function getRuntimeHandlerModuleNames(options: BunAdapterOptions): {
  incremental: string;
  useCache: string;
} {
  const mode = resolveCacheHandlerMode(options);
  return mode === 'http'
    ? {
        incremental: 'incremental-cache-handler-http.js',
        useCache: 'cache-handler-http.js',
      }
    : {
        incremental: 'incremental-cache-handler.js',
        useCache: 'cache-handler.js',
      };
}

async function readPreviewProps(
  ctx: BuildCompleteContext
): Promise<PreviewProps | null> {
  const distDir = path.isAbsolute(ctx.distDir)
    ? ctx.distDir
    : path.join(ctx.projectDir, ctx.distDir);
  const prerenderManifestPath = path.join(distDir, 'prerender-manifest.json');

  try {
    const parsed = (await Bun.file(prerenderManifestPath).json()) as {
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

function toJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function createRuntimeNextConfig(
  config: BuildCompleteContext['config']
): Record<string, unknown> {
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(config));
  } catch {
    cloned = {};
  }

  const configRecord = toJsonRecord(cloned);
  delete configRecord.outputFileTracingRoot;
  delete configRecord.cacheHandler;
  delete configRecord.adapterPath;

  const cacheHandlersValue = configRecord.cacheHandlers;
  if (cacheHandlersValue && typeof cacheHandlersValue === 'object') {
    const cacheHandlers = {
      ...(cacheHandlersValue as Record<string, unknown>),
    };
    delete cacheHandlers.remote;
    configRecord.cacheHandlers = cacheHandlers;
  }

  const experimentalValue = configRecord.experimental;
  if (experimentalValue && typeof experimentalValue === 'object') {
    const experimental = {
      ...(experimentalValue as Record<string, unknown>),
    };
    delete experimental.adapterPath;
    configRecord.experimental = experimental;
  }

  return configRecord;
}

async function writeRuntimeNextConfig(
  outDir: string,
  config: BuildCompleteContext['config']
): Promise<void> {
  const runtimeNextConfig = createRuntimeNextConfig(config);
  await writeJsonFile(path.join(outDir, RUNTIME_NEXT_CONFIG_FILE), runtimeNextConfig);
}

function createRuntimeCacheConfig(options: BunAdapterOptions): CacheRuntimeConfig {
  return {
    handlerMode: resolveCacheHandlerMode(options),
    endpointPath: options.cacheEndpointPath ?? DEFAULT_CACHE_ENDPOINT_PATH,
    authToken: options.cacheAuthToken ?? null,
  };
}

async function writeServerEntry(outDir: string): Promise<void> {
  const sourcePath = path.join(import.meta.dirname, 'runtime', 'server.js');
  const sourceCode = await Bun.file(sourcePath).text();
  const runtimeServerCode = sourceCode
    .replace("import './early-timers.js';", "import './runtime/early-timers.js';")
    .replace("from './next-compat.js';", "from './runtime/next-compat.js';")
    .replace("from './cache-store.js';", "from './runtime/cache-store.js';")
    .replace(
      "from './cache-http-server.js';",
      "from './runtime/cache-http-server.js';"
    );
  await Bun.write(path.join(outDir, 'server.js'), runtimeServerCode);
}

async function copyRuntimeModule(
  outDir: string,
  moduleName: string
): Promise<void> {
  const sourceDir = path.join(import.meta.dirname, 'runtime');
  const destDir = path.join(outDir, 'runtime');
  await mkdir(destDir, { recursive: true });
  await Bun.write(
    path.join(destDir, moduleName),
    Bun.file(path.join(sourceDir, moduleName))
  );
}

async function stageRuntimeModules(outDir: string): Promise<void> {
  await Promise.all(
    CACHE_RUNTIME_MODULES.map((mod) => copyRuntimeModule(outDir, mod))
  );
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

function collectTags(
  config: AdapterOutput['PRERENDER']['config'],
  fallbackHeaders?: Record<string, string | string[]> | null
): string[] {
  const tags = new Set<string>();
  const record = config as Record<string, unknown>;

  function addValues(value: unknown): void {
    if (typeof value === 'string' && value.length > 0) {
      tags.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) tags.add(item);
      }
    }
  }

  addValues(record.tags);
  addValues(record.revalidateTags);
  addValues(record.cacheTags);

  const experimental =
    record.experimental && typeof record.experimental === 'object'
      ? (record.experimental as Record<string, unknown>)
      : null;
  if (experimental) {
    addValues(experimental.tags);
    addValues(experimental.revalidateTags);
    addValues(experimental.cacheTags);
  }

  if (fallbackHeaders) {
    const headerVal = fallbackHeaders['x-next-cache-tags'];
    const raw = Array.isArray(headerVal) ? headerVal.join(',') : headerVal;
    if (typeof raw === 'string') {
      for (const t of raw.split(',')) {
        const trimmed = t.trim();
        if (trimmed.length > 0) tags.add(trimmed);
      }
    }
  }

  return [...tags].sort();
}

function getHeaderValueIgnoreCase(
  headers: Record<string, string>,
  key: string
): string | undefined {
  const keyLower = key.toLowerCase();
  for (const [headerKey, value] of Object.entries(headers)) {
    if (headerKey.toLowerCase() === keyLower) {
      return value;
    }
  }
  return undefined;
}

interface AppPageRouteMeta {
  postponed?: string;
  segmentPaths?: string[];
}

async function readAppPageRouteMeta(htmlPath: string): Promise<AppPageRouteMeta | null> {
  if (!htmlPath.endsWith('.html')) {
    return null;
  }

  const metaPath = htmlPath.slice(0, -'.html'.length) + '.meta';
  if (!existsSync(metaPath)) {
    return null;
  }

  try {
    const parsed = (await Bun.file(metaPath).json()) as Record<string, unknown>;
    const postponed = typeof parsed.postponed === 'string' ? parsed.postponed : undefined;
    const segmentPaths = Array.isArray(parsed.segmentPaths)
      ? parsed.segmentPaths.filter((item): item is string => typeof item === 'string')
      : undefined;
    return { postponed, segmentPaths };
  } catch {
    return null;
  }
}

function hasSeededSegmentEntries(
  cacheKey: string,
  pathnames: Iterable<string>
): boolean {
  const segmentPrefix = `${cacheKey}.segments/`;
  for (const pathname of pathnames) {
    if (
      pathname.startsWith(segmentPrefix) &&
      pathname.endsWith(SEGMENT_RSC_SUFFIX)
    ) {
      return true;
    }
  }
  return false;
}

function getSeededCacheKeyCandidates(cacheKey: string): string[] {
  const candidates = new Set<string>([cacheKey]);

  if (cacheKey === '/') {
    candidates.add('/index');
  } else if (cacheKey.endsWith('/index')) {
    const withoutIndex = cacheKey.slice(0, -'/index'.length);
    candidates.add(withoutIndex.length > 0 ? withoutIndex : '/');
  }

  return [...candidates];
}

function findExistingSeededPath(
  sourcePathByPathname: Map<string, string>,
  pathnameCandidates: readonly string[]
): string | undefined {
  for (const pathname of pathnameCandidates) {
    const sourcePath = sourcePathByPathname.get(pathname);
    if (sourcePath && existsSync(sourcePath)) {
      return sourcePath;
    }
  }
  return undefined;
}

async function buildSeededAppPageCacheValue({
  cacheKey,
  sourcePath,
  htmlBody,
  headers,
  status,
  sourcePathByPathname,
}: {
  cacheKey: string;
  sourcePath: string;
  htmlBody: Uint8Array;
  headers: Record<string, string>;
  status: number;
  sourcePathByPathname: Map<string, string>;
}): Promise<IncrementalCacheValue | null> {
  const contentType = getHeaderValueIgnoreCase(headers, 'content-type');
  if (!contentType || !contentType.toLowerCase().startsWith('text/html')) {
    return null;
  }

  const meta = await readAppPageRouteMeta(sourcePath);
  const cacheKeyCandidates = getSeededCacheKeyCandidates(cacheKey);
  const hasAppCompanion =
    cacheKeyCandidates.some((candidate) =>
      sourcePathByPathname.has(`${candidate}${RSC_SUFFIX}`)
    ) ||
    cacheKeyCandidates.some((candidate) =>
      hasSeededSegmentEntries(candidate, sourcePathByPathname.keys())
    ) ||
    Boolean(meta?.postponed);
  if (!hasAppCompanion) {
    return null;
  }

  let rscData: Buffer | undefined;
  const shouldLoadRscData = !(meta && typeof meta.postponed === 'string');
  if (shouldLoadRscData) {
    const rscPath = findExistingSeededPath(
      sourcePathByPathname,
      cacheKeyCandidates.map((candidate) => `${candidate}${RSC_SUFFIX}`)
    );
    if (rscPath) {
      rscData = Buffer.from(await Bun.file(rscPath).bytes());
    }
  }

  const segmentData = new Map<string, Buffer>();
  for (const segmentPathRaw of meta?.segmentPaths ?? []) {
    const segmentPath = segmentPathRaw.startsWith('/')
      ? segmentPathRaw
      : `/${segmentPathRaw}`;
    const segmentSourcePath = findExistingSeededPath(
      sourcePathByPathname,
      cacheKeyCandidates.map(
        (candidate) => `${candidate}.segments${segmentPath}${SEGMENT_RSC_SUFFIX}`
      )
    );
    if (!segmentSourcePath) {
      continue;
    }
    segmentData.set(
      segmentPath,
      Buffer.from(await Bun.file(segmentSourcePath).bytes())
    );
  }

  const appPageValue: IncrementalCacheValue = {
    kind: 'APP_PAGE',
    html: Buffer.from(htmlBody).toString('utf8'),
    headers,
    status,
    ...(rscData ? { rscData } : {}),
    ...(meta?.postponed ? { postponed: meta.postponed } : {}),
    ...(segmentData.size > 0 ? { segmentData } : {}),
  } as IncrementalCacheValue;

  return appPageValue;
}

function cloneRouteHas(
  value: BuildRouteHas
): NonNullable<RuntimeRoutingConfig['beforeFiles'][number]['has']>[number] {
  if (value.type === 'host') {
    return {
      type: 'host',
      value: value.value,
    };
  }

  return {
    type: value.type,
    key: value.key,
    value: value.value,
  };
}

function cloneRoute(route: BuildRoute): RuntimeRoutingConfig['beforeFiles'][number] {
  return {
    sourceRegex: route.sourceRegex,
    ...(typeof route.destination === 'string'
      ? { destination: route.destination }
      : {}),
    ...(route.headers ? { headers: { ...route.headers } } : {}),
    ...(route.has ? { has: route.has.map(cloneRouteHas) } : {}),
    ...(route.missing ? { missing: route.missing.map(cloneRouteHas) } : {}),
    ...(typeof route.status === 'number' ? { status: route.status } : {}),
  };
}

function toRuntimeI18nConfig(
  value: BuildCompleteContext['config']['i18n']
): RuntimeRoutingConfig['i18n'] {
  if (!value) {
    return null;
  }

  return {
    defaultLocale: value.defaultLocale,
    locales: [...value.locales],
    ...(value.localeDetection === false ? { localeDetection: false } : {}),
    ...(value.domains
      ? {
          domains: value.domains.map((domain) => ({
            defaultLocale: domain.defaultLocale,
            domain: domain.domain,
            ...(domain.http ? { http: true } : {}),
            ...(domain.locales ? { locales: [...domain.locales] } : {}),
          })),
        }
      : {}),
  };
}

function toRuntimeRoutingConfig(ctx: BuildCompleteContext): RuntimeRoutingConfig {
  return {
    i18n: toRuntimeI18nConfig(ctx.config.i18n),
    beforeMiddleware: ctx.routing.beforeMiddleware.map(cloneRoute),
    beforeFiles: ctx.routing.beforeFiles.map(cloneRoute),
    afterFiles: ctx.routing.afterFiles.map(cloneRoute),
    dynamicRoutes: ctx.routing.dynamicRoutes.map(cloneRoute),
    onMatch: ctx.routing.onMatch.map(cloneRoute),
    fallback: ctx.routing.fallback.map(cloneRoute),
    shouldNormalizeNextData: Boolean(ctx.routing.shouldNormalizeNextData),
  };
}

function toRuntimeAssetBindings(
  value: Record<string, string> | undefined
): BunRuntimeAssetBinding[] | undefined {
  if (!value) {
    return undefined;
  }

  const bindings: BunRuntimeAssetBinding[] = [];
  for (const [name, filePath] of Object.entries(value)) {
    if (!name || !filePath) {
      continue;
    }
    bindings.push({ name, filePath });
  }

  return bindings.length > 0 ? bindings : undefined;
}

function toRuntimeFunctionOutput({
  output,
  includeAssets,
}: {
  output:
    | AdapterOutput['PAGES']
    | AdapterOutput['PAGES_API']
    | AdapterOutput['APP_PAGE']
    | AdapterOutput['APP_ROUTE']
    | AdapterOutput['MIDDLEWARE'];
  includeAssets: boolean;
}): BunRuntimeFunctionOutput {
  const assetBindings = includeAssets ? toRuntimeAssetBindings(output.assets) : undefined;
  const wasmBindings = includeAssets ? toRuntimeAssetBindings(output.wasmAssets) : undefined;
  const serializedAssets =
    includeAssets
      ? [
          ...new Set([
            output.filePath,
            ...(assetBindings?.map((binding) => binding.filePath) ?? []),
            ...(wasmBindings?.map((binding) => binding.filePath) ?? []),
          ]),
        ]
      : undefined;
  const env = output.config.env;

  return {
    id: output.id,
    pathname: output.pathname,
    sourcePage: output.sourcePage,
    runtime: output.runtime,
    filePath: output.filePath,
    ...(output.edgeRuntime
      ? {
          edgeRuntime: {
            modulePath: output.edgeRuntime.modulePath,
            entryKey: output.edgeRuntime.entryKey,
            handlerExport: output.edgeRuntime.handlerExport,
          },
        }
      : {}),
    ...(serializedAssets && serializedAssets.length > 0
      ? { assets: serializedAssets }
      : {}),
    ...(assetBindings && assetBindings.length > 0
      ? { assetBindings }
      : {}),
    ...(wasmBindings && wasmBindings.length > 0
      ? { wasmBindings }
      : {}),
    ...(env && Object.keys(env).length > 0 ? { env: { ...env } } : {}),
  };
}

function collectRuntimeFunctionOutputs(
  outputs: BuildCompleteContext['outputs']
): BunRuntimeFunctionOutput[] {
  return [
    ...outputs.pages,
    ...outputs.pagesApi,
    ...outputs.appPages,
    ...outputs.appRoutes,
  ].map((output) =>
    toRuntimeFunctionOutput({
      output,
      includeAssets: output.runtime === 'edge',
    })
  );
}

function addResolvedPathnameSourcePageEntry(
  map: Map<string, string>,
  pathname: string,
  sourcePage: string
): void {
  if (!pathname || !sourcePage) {
    return;
  }

  map.set(pathname, sourcePage);
  if (pathname === '/index') {
    map.set('/', sourcePage);
  } else if (pathname === '/') {
    map.set('/index', sourcePage);
  }
}

function collectResolvedPathnameToSourcePage({
  outputs,
  runtimeFunctionOutputs,
}: {
  outputs: BuildCompleteContext['outputs'];
  runtimeFunctionOutputs: BunRuntimeFunctionOutput[];
}): BunResolvedPathnameSourcePageMap {
  const sourcePageByResolvedPathname = new Map<string, string>();
  const sourcePageByOutputId = new Map<string, string>();

  for (const output of [
    ...outputs.pages,
    ...outputs.pagesApi,
    ...outputs.appPages,
    ...outputs.appRoutes,
  ]) {
    sourcePageByOutputId.set(output.id, output.sourcePage);
  }

  if (outputs.middleware) {
    sourcePageByOutputId.set(outputs.middleware.id, outputs.middleware.sourcePage);
  }

  for (const output of runtimeFunctionOutputs) {
    if (!sourcePageByOutputId.has(output.id)) {
      sourcePageByOutputId.set(output.id, output.sourcePage);
    }
    addResolvedPathnameSourcePageEntry(
      sourcePageByResolvedPathname,
      output.pathname,
      output.sourcePage
    );
  }

  for (const prerender of outputs.prerenders) {
    const parentSourcePage = sourcePageByOutputId.get(prerender.parentOutputId);
    if (!parentSourcePage) {
      continue;
    }
    addResolvedPathnameSourcePageEntry(
      sourcePageByResolvedPathname,
      prerender.pathname,
      parentSourcePage
    );
  }

  return Object.fromEntries(
    [...sourcePageByResolvedPathname.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
}

function isStaticMetadataRoutePathname(pathname: string): boolean {
  return (
    pathname.endsWith('/robots.txt') ||
    pathname.endsWith('/sitemap.xml') ||
    pathname.endsWith('/favicon.ico') ||
    pathname.endsWith('/manifest.webmanifest')
  );
}

function isPrerenderedMetadataRoutePathname({
  pathname,
  prerenderRoutes,
  prerenderDynamicRoutes,
  locales,
}: {
  pathname: string;
  prerenderRoutes: Set<string>;
  prerenderDynamicRoutes: Set<string>;
  locales: readonly string[] | undefined;
}): boolean {
  if (prerenderRoutes.has(pathname) || prerenderDynamicRoutes.has(pathname)) {
    return true;
  }
  if (!locales || locales.length === 0) {
    return false;
  }

  for (const locale of locales) {
    const localePathname = path.posix.join('/', locale, pathname.slice(1));
    if (
      prerenderRoutes.has(localePathname) ||
      prerenderDynamicRoutes.has(localePathname)
    ) {
      return true;
    }
  }

  return false;
}

async function collectMissingDynamicMetadataFunctionOutputs({
  ctx,
  existingFunctionOutputs,
}: {
  ctx: BuildCompleteContext;
  existingFunctionOutputs: readonly BunRuntimeFunctionOutput[];
}): Promise<BunRuntimeFunctionOutput[]> {
  const absoluteDistDir = path.isAbsolute(ctx.distDir)
    ? ctx.distDir
    : path.join(ctx.projectDir, ctx.distDir);
  const appPathsManifestPath = path.join(
    absoluteDistDir,
    'server',
    'app-paths-manifest.json'
  );
  if (!existsSync(appPathsManifestPath)) {
    return [];
  }

  let appPathsManifest: Record<string, string>;
  try {
    appPathsManifest = (await Bun.file(appPathsManifestPath).json()) as Record<
      string,
      string
    >;
  } catch {
    return [];
  }

  const prerenderManifestPath = path.join(absoluteDistDir, 'prerender-manifest.json');
  let prerenderManifest:
    | {
        routes?: Record<string, unknown>;
        dynamicRoutes?: Record<string, unknown>;
      }
    | null = null;
  try {
    prerenderManifest = (await Bun.file(prerenderManifestPath).json()) as {
      routes?: Record<string, unknown>;
      dynamicRoutes?: Record<string, unknown>;
    };
  } catch {
    prerenderManifest = null;
  }

  const prerenderRoutes = new Set(Object.keys(prerenderManifest?.routes ?? {}));
  const prerenderDynamicRoutes = new Set(
    Object.keys(prerenderManifest?.dynamicRoutes ?? {})
  );
  const existingPathnames = new Set(
    existingFunctionOutputs.map((output) => output.pathname)
  );

  const missingOutputs: BunRuntimeFunctionOutput[] = [];
  const maybePushOutput = (output: BunRuntimeFunctionOutput): void => {
    if (existingPathnames.has(output.pathname)) {
      return;
    }
    existingPathnames.add(output.pathname);
    missingOutputs.push(output);
  };

  for (const [sourcePage, relativeModulePath] of Object.entries(appPathsManifest)) {
    if (!sourcePage.endsWith('/route')) {
      continue;
    }

    const pathname = sourcePage.slice(0, -'/route'.length) || '/';
    if (!isStaticMetadataRoutePathname(pathname)) {
      continue;
    }

    if (
      isPrerenderedMetadataRoutePathname({
        pathname,
        prerenderRoutes,
        prerenderDynamicRoutes,
        locales: ctx.config.i18n?.locales,
      })
    ) {
      continue;
    }

    const filePath = path.isAbsolute(relativeModulePath)
      ? relativeModulePath
      : path.join(absoluteDistDir, 'server', relativeModulePath);
    if (!existsSync(filePath)) {
      continue;
    }

    maybePushOutput({
      id: pathname,
      pathname,
      sourcePage,
      runtime: 'nodejs',
      filePath,
    });
    maybePushOutput({
      id: `${pathname}${RSC_SUFFIX}`,
      pathname: `${pathname}${RSC_SUFFIX}`,
      sourcePage,
      runtime: 'nodejs',
      filePath,
    });
  }

  return missingOutputs;
}

function resolveSourcePath(repoRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
}

async function seedPrerenderCache({
  outDir,
  prerenders,
  repoRoot,
}: {
  outDir: string;
  prerenders: AdapterOutput['PRERENDER'][];
  repoRoot: string;
}): Promise<void> {
  const seedable = prerenders.filter((p) => p.fallback?.filePath);
  if (seedable.length === 0) return;
  const explicitCacheKeys = new Set(seedable.map((entry) => entry.pathname));

  const sourcePathByPathname = new Map<string, string>();
  for (const prerender of seedable) {
    const fallback = prerender.fallback!;
    sourcePathByPathname.set(
      prerender.pathname,
      resolveSourcePath(repoRoot, fallback.filePath!)
    );
  }

  const dbPath = path.join(outDir, 'cache.db');
  const db = new Database(dbPath);

  try {
    db.run('PRAGMA journal_mode = WAL');
    db.run(SCHEMA_SQL);

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

    const entries: Array<{
      cacheKey: string;
      pathname: string;
      groupId: number;
      status: number;
      headers: string;
      body: Uint8Array;
      tags: string[];
      revalidateAt: number | null;
      expiresAt: number | null;
    }> = [];

    for (const prerender of seedable) {
      const fallback = prerender.fallback!;
      const sourcePath = resolveSourcePath(repoRoot, fallback.filePath!);

      const body = await Bun.file(sourcePath).bytes();

      const cacheKey = prerender.pathname;

      const tags = collectTags(prerender.config, fallback.initialHeaders);
      const headers = flattenHeaders(fallback.initialHeaders ?? null);
      if (tags.length > 0) {
        headers['x-next-cache-tags'] = tags.join(',');
      }

      const status = fallback.initialStatus ?? 200;
      const contentTypeHeader = getHeaderValueIgnoreCase(headers, 'content-type');
      const isHtmlEntry =
        typeof contentTypeHeader === 'string' &&
        contentTypeHeader.toLowerCase().startsWith('text/html');

      let storedBody = body;
      const seededAppPageValue = await buildSeededAppPageCacheValue({
        cacheKey,
        sourcePath,
        htmlBody: body,
        headers,
        status,
        sourcePathByPathname,
      });
      if (seededAppPageValue) {
        storedBody = Buffer.from(encodeCacheValue(seededAppPageValue), 'utf8');
      }

      let revalidateAt: number | null = null;
      if (typeof fallback.initialRevalidate === 'number' && fallback.initialRevalidate > 0) {
        revalidateAt = createdAt + fallback.initialRevalidate * 1000;
      }

      let expiresAt: number | null = null;
      if (typeof fallback.initialExpiration === 'number' && fallback.initialExpiration > 0) {
        expiresAt = createdAt + fallback.initialExpiration * 1000;
      }

      const entryBase = {
        groupId: prerender.groupId,
        status,
        headers: JSON.stringify(headers),
        body: storedBody,
        tags,
        revalidateAt,
        expiresAt,
      };

      entries.push({
        ...entryBase,
        cacheKey,
        pathname: cacheKey,
      });

      if (isHtmlEntry) {
        for (const aliasCacheKey of getSeededCacheKeyCandidates(cacheKey)) {
          if (aliasCacheKey === cacheKey || explicitCacheKeys.has(aliasCacheKey)) {
            continue;
          }

          entries.push({
            ...entryBase,
            cacheKey: aliasCacheKey,
            pathname: aliasCacheKey,
          });
        }
      }
    }

    db.transaction(() => {
      for (const entry of entries) {
        insertEntry.run(
          entry.cacheKey,
          entry.pathname,
          entry.groupId,
          entry.status,
          entry.headers,
          entry.body,
          'binary',
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

  const staticAssets = await stageStaticAssets({
    outputs: ctx.outputs,
    projectDir: ctx.projectDir,
    basePath: ctx.config.basePath,
    outDir,
  });

  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const previewProps = await readPreviewProps(ctx);
  const cacheRuntime = createRuntimeCacheConfig(options);
  const runtimeRouting = toRuntimeRoutingConfig(ctx);
  let runtimeFunctionOutputs = collectRuntimeFunctionOutputs(ctx.outputs);
  const missingDynamicMetadataOutputs =
    await collectMissingDynamicMetadataFunctionOutputs({
      ctx,
      existingFunctionOutputs: runtimeFunctionOutputs,
    });
  if (missingDynamicMetadataOutputs.length > 0) {
    runtimeFunctionOutputs = [
      ...runtimeFunctionOutputs,
      ...missingDynamicMetadataOutputs,
    ];
  }
  const runtimeMiddleware = ctx.outputs.middleware
    ? toRuntimeFunctionOutput({
        output: ctx.outputs.middleware,
        includeAssets: ctx.outputs.middleware.runtime === 'edge',
      })
    : undefined;
  const resolvedPathnameToSourcePage = collectResolvedPathnameToSourcePage({
    outputs: ctx.outputs,
    runtimeFunctionOutputs,
  });

  const deploymentManifest = buildDeploymentManifest({
    adapterName: ADAPTER_NAME,
    adapterOutDir: configuredOutDir,
    ctx,
    generatedAt,
    pathnames,
    staticAssets,
    port,
    hostname,
    previewProps,
    cacheRuntime,
    routing: runtimeRouting,
    middlewareOutput: runtimeMiddleware,
    functionOutputs: runtimeFunctionOutputs,
    resolvedPathnameToSourcePage,
  });

  await writeJsonFile(
    path.join(outDir, 'deployment-manifest.json'),
    deploymentManifest
  );

  await stageRuntimeModules(outDir);
  await seedPrerenderCache({
    outDir,
    prerenders: ctx.outputs.prerenders,
    repoRoot: ctx.repoRoot,
  });
  await writeRuntimeNextConfig(outDir, ctx.config);
  await writeServerEntry(outDir);
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

      // Inject the IncrementalCache handler runtime.
      const handlerModules = getRuntimeHandlerModuleNames(options);

      // Stage the cache handler runtime into the output dir so the path is
      // inside the project tree (Turbopack rejects absolute paths that leave
      // the project root). The files are small and this is idempotent.
      const runtimeDir = path.resolve(configuredOutDir, 'runtime');
      if (!existsSync(runtimeDir)) {
        mkdirSync(runtimeDir, { recursive: true });
      }
      const sourceDir = path.join(import.meta.dirname, 'runtime');
      for (const mod of CACHE_RUNTIME_MODULES) {
        const dest = path.join(runtimeDir, mod);
        copyFileSync(path.join(sourceDir, mod), dest);
      }
      const incrementalCacheHandlerPath = path.resolve(
        configuredOutDir,
        'runtime',
        handlerModules.incremental
      );

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
        cacheHandler: incrementalCacheHandlerPath,
      } as typeof config;
    },
    async onBuildComplete(ctx) {
      await onBuildComplete(ctx, configuredOutDir, options);
    },
  };
}
