import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterOutput } from 'next';
import type {
  BunFunctionArtifact,
  BunFunctionFile,
  BunPrerenderSeed,
  BunStaticAsset,
  BuildCompleteContext,
  FunctionOutput,
} from './types.ts';

const IMMUTABLE_STATIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_ROUTE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const INDEX_OBJECT_KEY = 'index';

function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/');
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(toPosixPath(value).replace(/^\/+/, ''));

  if (normalized === '.' || normalized.length === 0) {
    throw new Error(`Invalid relative path: "${value}"`);
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Path escapes target directory: "${value}"`);
  }

  return normalized;
}

function resolveInside(baseDir: string, relativePath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativePath);
  const prefix = `${resolvedBase}${path.sep}`;

  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(prefix)) {
    throw new Error(`Resolved path escapes base directory: "${relativePath}"`);
  }

  return resolvedTarget;
}

function safePathnameToObjectKey(pathname: string): string {
  const trimmed = trimSlashes(pathname);
  return trimmed.length > 0 ? trimmed : INDEX_OBJECT_KEY;
}

function buildStaticObjectKey(pathname: string, sourcePath: string): string {
  const baseKey = safePathnameToObjectKey(pathname);
  const sourceExtension = path.extname(sourcePath);
  const hasExtension = path.posix.extname(baseKey).length > 0;

  if (sourceExtension === '.html' && !hasExtension) {
    return `${baseKey}.html`;
  }

  return baseKey;
}

function sourcePathToBundlePath({
  repoRoot,
  sourcePath,
}: {
  repoRoot: string;
  sourcePath: string;
}): string {
  const relative = toPosixPath(path.relative(repoRoot, sourcePath));
  const startsOutsideRepo = relative === '..' || relative.startsWith('../');
  if (!startsOutsideRepo && !path.isAbsolute(relative)) {
    return normalizeRelativePath(relative);
  }

  const sourceBasename = path.basename(sourcePath);
  const hash = createHash('sha1').update(sourcePath).digest('hex').slice(0, 12);
  return path.posix.join('__external', hash, sourceBasename);
}

function outputAssetPathToBundlePath({
  repoRoot,
  relativePath,
  sourcePath,
}: {
  repoRoot: string;
  relativePath: string;
  sourcePath: string;
}): string {
  const normalizedCandidate = path.posix.normalize(
    toPosixPath(relativePath).replace(/^\/+/, '')
  );
  const escapesTarget =
    normalizedCandidate === '..' || normalizedCandidate.startsWith('../');
  const isInvalid = normalizedCandidate === '.' || normalizedCandidate.length === 0;
  if (!escapesTarget && !isInvalid) {
    return normalizedCandidate;
  }

  return sourcePathToBundlePath({
    repoRoot,
    sourcePath,
  });
}

function hasBunExportCondition(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasBunExportCondition(entry));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, 'bun')) {
      return true;
    }
    return Object.values(record).some((entry) => hasBunExportCondition(entry));
  }
  return false;
}

function stripBunExportConditions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripBunExportConditions(entry));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const nextRecord: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (key === 'bun') {
        continue;
      }
      nextRecord[key] = stripBunExportConditions(entry);
    }
    return nextRecord;
  }
  return value;
}

function resolveDirectNodeModulesPackageRoot(
  relativePath: string
): string | null {
  if (!relativePath.endsWith('/package.json')) {
    return null;
  }

  const segments = normalizeRelativePath(relativePath).split('/');
  if (segments.includes('.pnpm')) {
    return null;
  }
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (
    nodeModulesIndex === -1 ||
    nodeModulesIndex + 2 >= segments.length ||
    segments[nodeModulesIndex + 1] === '.pnpm'
  ) {
    return null;
  }

  const packageNameStart = nodeModulesIndex + 1;
  const isScoped = segments[packageNameStart]?.startsWith('@') ?? false;
  const packageNameEnd = isScoped ? packageNameStart + 1 : packageNameStart;
  if (packageNameEnd + 1 !== segments.length - 1) {
    return null;
  }

  return segments.slice(0, packageNameEnd + 1).join('/');
}

function createBundleId(id: string): string {
  const slug = id
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 48);
  const hash = createHash('sha1').update(id).digest('hex').slice(0, 10);
  return `${slug || 'output'}-${hash}`;
}

function sortByPathnameAndId<
  T extends {
    pathname: string;
    id: string;
  },
>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const byPathname = a.pathname.localeCompare(b.pathname);
    if (byPathname !== 0) return byPathname;
    return a.id.localeCompare(b.id);
  });
}

function getFunctionOutputs(
  outputs: BuildCompleteContext['outputs']
): FunctionOutput[] {
  const functionOutputs: FunctionOutput[] = [
    ...outputs.pages,
    ...outputs.pagesApi,
    ...outputs.appPages,
    ...outputs.appRoutes,
  ];

  if (outputs.middleware) {
    functionOutputs.push(outputs.middleware);
  }

  return functionOutputs;
}

async function copyToOutDir({
  sourcePath,
  outDir,
  relativePath,
}: {
  sourcePath: string;
  outDir: string;
  relativePath: string;
}): Promise<void> {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const destinationPath = resolveInside(outDir, normalizedRelativePath);
  await mkdir(path.dirname(destinationPath), { recursive: true });

  const sourceLStat = await lstat(sourcePath);
  let sourceCopyPath = sourcePath;
  let sourceStat = sourceLStat;

  if (sourceLStat.isSymbolicLink()) {
    sourceCopyPath = await realpath(sourcePath);
    sourceStat = await stat(sourceCopyPath);
  }

  if (sourceStat.isDirectory()) {
    await cp(sourceCopyPath, destinationPath, {
      recursive: true,
      force: true,
    });
    return;
  }

  if (!sourceStat.isFile()) {
    throw new Error(
      `Unsupported asset type for "${sourcePath}" while staging "${relativePath}"`
    );
  }

  await copyFile(sourceCopyPath, destinationPath);
}

async function findFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findFilesRecursively(entryPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function recordByObjectKey(
  seenByObjectKey: Map<string, string>,
  objectKey: string,
  sourcePath: string
): void {
  const existing = seenByObjectKey.get(objectKey);
  if (existing && existing !== sourcePath) {
    throw new Error(
      `Duplicate staged object key "${objectKey}" from "${existing}" and "${sourcePath}"`
    );
  }
  seenByObjectKey.set(objectKey, sourcePath);
}

function buildPublicPathname(basePath: string, fileRelativePath: string): string {
  const basePathWithoutSlashes = trimSlashes(basePath);
  if (basePathWithoutSlashes.length === 0) {
    return `/${fileRelativePath}`;
  }

  return path.posix.join('/', basePathWithoutSlashes, fileRelativePath);
}

function toAbsoluteSourcePath(repoRoot: string, sourcePath: string): string {
  if (path.isAbsolute(sourcePath)) {
    return sourcePath;
  }
  return path.resolve(repoRoot, sourcePath);
}

async function addFunctionFile({
  seenFiles,
  files,
  outDir,
  bundleRoot,
  relativePath,
  sourcePath,
  kind,
  copyToBundle = true,
}: {
  seenFiles: Map<string, string>;
  files: BunFunctionFile[];
  outDir: string;
  bundleRoot: string;
  relativePath: string;
  sourcePath: string;
  kind: BunFunctionFile['kind'];
  copyToBundle?: boolean;
}): Promise<void> {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const existingPath = seenFiles.get(normalizedRelativePath);

  if (existingPath) {
    if (existingPath !== sourcePath) {
      throw new Error(
        `Function bundle path collision at "${normalizedRelativePath}" from "${existingPath}" and "${sourcePath}"`
      );
    }
    // Already copied by a previous function — just record in this function's files
    files.push({ kind, relativePath: normalizedRelativePath, sourcePath });
    return;
  }

  seenFiles.set(normalizedRelativePath, sourcePath);
  if (copyToBundle) {
    const stagedPath = path.posix.join(bundleRoot, normalizedRelativePath);
    await copyToOutDir({
      sourcePath,
      outDir,
      relativePath: stagedPath,
    });
  }
  files.push({
    kind,
    relativePath: normalizedRelativePath,
    sourcePath,
  });
}

function isHtmlSourcePath(sourcePath: string): boolean {
  return sourcePath.endsWith('.html');
}

function resolveStaticAssetCacheControl({
  pathname,
  sourcePath,
}: {
  pathname: string;
  sourcePath: string;
}): string | null {
  if (pathname.startsWith('/_next/static/')) {
    return IMMUTABLE_STATIC_CACHE_CONTROL;
  }
  if (isHtmlSourcePath(sourcePath)) {
    return HTML_ROUTE_CACHE_CONTROL;
  }
  return null;
}

function isHtmlContentType(value: string | null): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return value.split(';', 1)[0]?.trim().toLowerCase() === 'text/html';
}

function readSingleHeaderValue(
  headers: Record<string, string | string[]> | null,
  name: string
): string | null {
  if (!headers) {
    return null;
  }
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== normalizedName) {
      continue;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value) && value.length > 0) {
      return value[0] ?? null;
    }
  }
  return null;
}

function setSingleHeaderValue(
  headers: Record<string, string | string[]>,
  name: string,
  value: string
): Record<string, string | string[]> {
  const normalizedName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === normalizedName) {
      headers[key] = value;
      return headers;
    }
  }
  headers[name] = value;
  return headers;
}

function normalizeFallbackInitialHeaders({
  sourcePath,
  initialHeaders,
}: {
  sourcePath: string | null;
  initialHeaders: Record<string, string | string[]> | null;
}): Record<string, string | string[]> | null {
  const contentType = readSingleHeaderValue(initialHeaders, 'content-type');
  const shouldForceHtmlRouteCacheControl =
    isHtmlSourcePath(sourcePath ?? '') || isHtmlContentType(contentType);
  if (!shouldForceHtmlRouteCacheControl) {
    return initialHeaders ?? null;
  }

  const headers = initialHeaders ? { ...initialHeaders } : {};
  return setSingleHeaderValue(headers, 'cache-control', HTML_ROUTE_CACHE_CONTROL);
}

function isExtensionlessRoutePathname(pathname: string): boolean {
  const normalized = trimSlashes(pathname);
  if (normalized.length === 0) {
    return true;
  }

  const segments = normalized.split('/');
  const lastSegment = segments[segments.length - 1] ?? '';
  if (lastSegment.startsWith('[') && lastSegment.endsWith(']')) {
    return true;
  }

  return path.posix.extname(lastSegment) === '';
}

export async function stageStaticAssets({
  outputs,
  projectDir,
  basePath,
  outDir,
}: {
  outputs: BuildCompleteContext['outputs'];
  projectDir: string;
  basePath: string;
  outDir: string;
}): Promise<BunStaticAsset[]> {
  const seenByObjectKey = new Map<string, string>();
  const assets: BunStaticAsset[] = [];

  for (const output of sortByPathnameAndId(outputs.staticFiles)) {
    const objectKey = buildStaticObjectKey(output.pathname, output.filePath);
    recordByObjectKey(seenByObjectKey, objectKey, output.filePath);

    const stagedPath = path.posix.join('static', objectKey);
    await copyToOutDir({
      sourcePath: output.filePath,
      outDir,
      relativePath: stagedPath,
    });

    assets.push({
      id: output.id,
      pathname: output.pathname,
      sourceType: 'next-static',
      sourcePath: output.filePath,
      stagedPath,
      objectKey,
      contentType:
        path.extname(output.filePath) === '.html' &&
        isExtensionlessRoutePathname(output.pathname)
          ? 'text/html; charset=utf-8'
          : null,
      cacheControl: resolveStaticAssetCacheControl({
        pathname: output.pathname,
        sourcePath: output.filePath,
      }),
    });
  }

  const publicDir = path.join(projectDir, 'public');
  const publicStat = await stat(publicDir).catch(() => null);
  if (publicStat?.isDirectory()) {
    const publicFiles = await findFilesRecursively(publicDir);
    publicFiles.sort((a, b) => a.localeCompare(b));

    for (const publicFilePath of publicFiles) {
      const fileRelativePath = toPosixPath(path.relative(publicDir, publicFilePath));
      const pathname = buildPublicPathname(basePath, fileRelativePath);
      const objectKey = safePathnameToObjectKey(pathname);
      recordByObjectKey(seenByObjectKey, objectKey, publicFilePath);

      const stagedPath = path.posix.join('static', objectKey);
      await copyToOutDir({
        sourcePath: publicFilePath,
        outDir,
        relativePath: stagedPath,
      });

      assets.push({
        id: `public:${fileRelativePath}`,
        pathname,
        sourceType: 'public',
        sourcePath: publicFilePath,
        stagedPath,
        objectKey,
        contentType: null,
        cacheControl: null,
      });
    }
  }

  return assets.sort((a, b) => a.objectKey.localeCompare(b.objectKey));
}

export async function stageFunctionArtifacts({
  outputs,
  repoRoot,
  outDir,
}: {
  outputs: BuildCompleteContext['outputs'];
  repoRoot: string;
  outDir: string;
}): Promise<BunFunctionArtifact[]> {
  const artifacts: BunFunctionArtifact[] = [];
  const seenFiles = new Map<string, string>();
  const bunConditionPackageRoots = new Set<string>();
  const patchedPackageJsonPaths = new Set<string>();
  const bundleRoot = 'bundle';

  for (const output of sortByPathnameAndId(getFunctionOutputs(outputs))) {
    const bundleId = createBundleId(output.id);
    const files: BunFunctionFile[] = [];

    const entrypointPath = toAbsoluteSourcePath(repoRoot, output.filePath);
    await addFunctionFile({
      seenFiles,
      files,
      outDir,
      bundleRoot,
      relativePath: sourcePathToBundlePath({
        repoRoot,
        sourcePath: entrypointPath,
      }),
      sourcePath: entrypointPath,
      kind: 'entrypoint',
    });

    for (const [relativePath, sourcePath] of Object.entries(output.assets)) {
      const absoluteSourcePath = toAbsoluteSourcePath(repoRoot, sourcePath);
      const bundlePath = outputAssetPathToBundlePath({
        repoRoot,
        relativePath,
        sourcePath: absoluteSourcePath,
      });
      await addFunctionFile({
        seenFiles,
        files,
        outDir,
        bundleRoot,
        relativePath: bundlePath,
        sourcePath: absoluteSourcePath,
        kind: 'asset',
        copyToBundle: !bundlePath.startsWith('node_modules/'),
      });

      const packageRoot = resolveDirectNodeModulesPackageRoot(bundlePath);
      if (packageRoot && !bunConditionPackageRoots.has(packageRoot)) {
        let packageJsonText: string;
        try {
          packageJsonText = await Bun.file(absoluteSourcePath).text();
        } catch {
          continue;
        }

        const packageJson = JSON.parse(packageJsonText) as {
          exports?: unknown;
        };
        if (!hasBunExportCondition(packageJson.exports)) {
          continue;
        }

        await addFunctionFile({
          seenFiles,
          files,
          outDir,
          bundleRoot,
          relativePath: packageRoot,
          sourcePath: path.dirname(absoluteSourcePath),
          kind: 'asset',
          copyToBundle: !packageRoot.startsWith('node_modules/'),
        });
        bunConditionPackageRoots.add(packageRoot);

        const stagedPackageJsonRelativePath = packageRoot.startsWith('node_modules/')
          ? path.posix.join(packageRoot, 'package.json')
          : path.posix.join(bundleRoot, packageRoot, 'package.json');
        const stagedPackageJsonPath = resolveInside(
          outDir,
          stagedPackageJsonRelativePath
        );
        if (patchedPackageJsonPaths.has(stagedPackageJsonPath)) {
          continue;
        }

        packageJson.exports = stripBunExportConditions(packageJson.exports);
        await mkdir(path.dirname(stagedPackageJsonPath), { recursive: true });
        await writeFile(
          stagedPackageJsonPath,
          `${JSON.stringify(packageJson, null, 2)}\n`,
          'utf8'
        );
        patchedPackageJsonPaths.add(stagedPackageJsonPath);
      }
    }

    for (const [wasmName, wasmPath] of Object.entries(output.wasmAssets ?? {})) {
      await addFunctionFile({
        seenFiles,
        files,
        outDir,
        bundleRoot,
        relativePath: path.posix.join('_wasm', wasmName),
        sourcePath: toAbsoluteSourcePath(repoRoot, wasmPath),
        kind: 'wasm',
      });
    }

    artifacts.push({
      bundleId,
      id: output.id,
      type: output.type,
      pathname: output.pathname,
      sourcePage: output.sourcePage,
      runtime: output.runtime,
      config: output.config,
      inventoryPath: '',
      fileCount: files.length,
      files,
    });
  }

  return artifacts;
}

type PrerenderOutput = AdapterOutput['PRERENDER'];

function sortPrerenders(outputs: PrerenderOutput[]): PrerenderOutput[] {
  return [...outputs].sort((a, b) => {
    const byPathname = a.pathname.localeCompare(b.pathname);
    if (byPathname !== 0) return byPathname;
    return a.id.localeCompare(b.id);
  });
}

function collectPrerenderSeedTags(
  config: PrerenderOutput['config'],
  fallbackInitialHeaders?: Record<string, string | string[]> | null
): string[] {
  const tags = new Set<string>();
  const record = config as Record<string, unknown>;

  function addTagValue(value: unknown): void {
    if (typeof value === 'string' && value.length > 0) {
      tags.add(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) {
          tags.add(item);
        }
      }
    }
  }

  function addHeaderTagValue(value: unknown): void {
    if (typeof value === 'string') {
      for (const item of value.split(',')) {
        const normalized = item.trim();
        if (normalized.length > 0) {
          tags.add(normalized);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        addHeaderTagValue(item);
      }
    }
  }

  addTagValue(record.tags);
  addTagValue(record.revalidateTags);
  addTagValue(record.cacheTags);

  const experimental =
    record.experimental && typeof record.experimental === 'object'
      ? (record.experimental as Record<string, unknown>)
      : null;
  if (experimental) {
    addTagValue(experimental.tags);
    addTagValue(experimental.revalidateTags);
    addTagValue(experimental.cacheTags);
  }

  if (fallbackInitialHeaders) {
    addHeaderTagValue(fallbackInitialHeaders['x-next-cache-tags']);
  }

  return [...tags].sort((left, right) => left.localeCompare(right));
}

export async function stagePrerenderSeeds({
  outputs,
  repoRoot,
  outDir,
}: {
  outputs: BuildCompleteContext['outputs'];
  repoRoot: string;
  outDir: string;
}): Promise<BunPrerenderSeed[]> {
  const seeds: BunPrerenderSeed[] = [];

  for (const prerender of sortPrerenders(outputs.prerenders)) {
    const seedKey = createBundleId(prerender.id);
    const seedRoot = path.posix.join('prerender-seeds', seedKey);
    const fallback = prerender.fallback;

    let fallbackStagedPath: string | null = null;
    let fallbackSourcePath: string | null = null;
    let postponedStatePath: string | null = null;

    if (
      typeof fallback?.postponedState === 'string' &&
      fallback.postponedState.length > 0
    ) {
      postponedStatePath = fallback.postponedState;
    }

    const isPPR = postponedStatePath !== null;

    if (fallback?.filePath) {
      const sourcePath = toAbsoluteSourcePath(repoRoot, fallback.filePath);
      fallbackSourcePath = sourcePath;
      const extension = path.extname(sourcePath) || '.payload';
      fallbackStagedPath = path.posix.join(seedRoot, `fallback${extension}`);

      await copyToOutDir({
        sourcePath,
        outDir,
        relativePath: fallbackStagedPath,
      });
    }

    seeds.push({
      id: prerender.id,
      pathname: prerender.pathname,
      parentOutputId: prerender.parentOutputId,
      groupId: prerender.groupId,
      tags: collectPrerenderSeedTags(
        prerender.config,
        fallback?.initialHeaders ?? null
      ),
      parentFallbackMode: prerender.parentFallbackMode ?? null,
      pprChainHeaders: prerender.pprChain?.headers ?? null,
      config: prerender.config,
      fallback: fallback
        ? {
            stagedPath: fallbackStagedPath,
            sourcePath: fallbackSourcePath,
            postponedStatePath,
            initialStatus: fallback.initialStatus ?? null,
            initialHeaders: normalizeFallbackInitialHeaders({
              sourcePath: fallbackSourcePath,
              initialHeaders: fallback.initialHeaders ?? null,
            }),
            initialExpiration: fallback.initialExpiration ?? null,
            initialRevalidate: fallback.initialRevalidate ?? null,
          }
        : null,
    });
  }

  return seeds;
}

export function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  return writeJson(filePath, payload);
}
