import { createHash } from 'node:crypto';
import type { BunPrerenderSeed } from '../types.ts';

type PrerenderBypassCondition =
  | {
      type: 'header' | 'cookie' | 'query';
      key: string;
      value?: string;
    }
  | {
      type: 'host';
      key?: undefined;
      value: string;
    };

export type PrerenderCacheState = 'HIT' | 'STALE' | 'MISS' | 'BYPASS';

export type PrerenderRevalidateReason =
  | 'STALE'
  | 'MISS_FALLBACK'
  | 'MANUAL_PATH'
  | 'MANUAL_TAG';

export const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags';
export const NEXT_CACHE_IMPLICIT_TAG_ID = '_N_T_';

export interface PrerenderCacheKey {
  key: string;
  pathname: string;
  query: Record<string, string[]>;
  headers: Record<string, string>;
}

export interface PrerenderTagManifestEntry {
  staleAt?: number;
  expiredAt?: number;
}

export interface PrerenderTagManifestUpdate {
  mode: 'stale' | 'expire';
  now?: number;
  expireSeconds?: number;
}

export interface PrerenderRevalidateTarget {
  cacheKey: string;
  pathname: string;
  groupId: number;
}

export interface PrerenderCacheEntry {
  cacheKey: string;
  pathname: string;
  groupId: number;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'base64';
  createdAt: number;
  revalidateAt: number | null;
  expiresAt: number | null;
  cacheQuery?: Record<string, string[]>;
  cacheHeaders?: Record<string, string>;
}

export interface PrerenderRevalidateTask {
  cacheKey: string;
  pathname: string;
  groupId: number;
  reason: PrerenderRevalidateReason;
}

export interface PrerenderCacheStore {
  get(cacheKey: string): Promise<PrerenderCacheEntry | null> | PrerenderCacheEntry | null;
  set(cacheKey: string, entry: PrerenderCacheEntry): Promise<void> | void;
  delete?(cacheKey: string): Promise<void> | void;
  acquireRevalidateLock?(
    cacheKey: string,
    ttlSeconds: number
  ): Promise<boolean> | boolean;
  getTagManifestEntries?(
    tags: string[]
  ):
    | Promise<Record<string, PrerenderTagManifestEntry>>
    | Record<string, PrerenderTagManifestEntry>;
  updateTagManifest?(
    tags: string[],
    update: PrerenderTagManifestUpdate
  ): Promise<void> | void;
  findRevalidateTargets?(query: {
    tags?: string[];
    pathnames?: string[];
  }): Promise<PrerenderRevalidateTarget[]> | PrerenderRevalidateTarget[];
}

export interface PrerenderRevalidateQueue {
  enqueue(task: PrerenderRevalidateTask): Promise<void> | void;
}

export interface PrerenderCacheRuntimeOptions {
  store: PrerenderCacheStore;
  revalidateQueue?: PrerenderRevalidateQueue;
  now?: () => number;
  revalidateLockTtlSeconds?: number;
  bypassTokenResolver?: (request: Request, seed: BunPrerenderSeed) => boolean;
  shouldCacheResponse?: (
    response: PrerenderCacheableResponse,
    seed: BunPrerenderSeed
  ) => boolean;
}

export type PrerenderCacheEvaluation =
  | {
      kind: 'miss';
      entry: null;
    }
  | {
      kind: 'fresh';
      entry: PrerenderCacheEntry;
    }
  | {
      kind: 'stale';
      entry: PrerenderCacheEntry;
    };

export interface PrerenderCacheableResponse {
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers: {
    entries(): IterableIterator<[string, string]>;
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function toConfigRecord(seed: BunPrerenderSeed): Record<string, unknown> {
  return seed.config as Record<string, unknown>;
}

function readConfigAllowList(
  seed: BunPrerenderSeed,
  key: 'allowQuery' | 'allowHeader'
): string[] {
  const config = toConfigRecord(seed);
  const value = config[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))];
}

function readBypassToken(seed: BunPrerenderSeed): string | null {
  const config = toConfigRecord(seed);
  if (
    typeof config.bypassToken === 'string' &&
    config.bypassToken.length > 0
  ) {
    return config.bypassToken;
  }

  return null;
}

function removeTrailingSlash(pathname: string): string {
  return pathname.replace(/\/$/, '') || '/';
}

export function parseCacheTagsHeader(value: string | null | undefined): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  return unique(
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  );
}

export function readCacheTagsFromHeaders(headers: Record<string, string>): string[] {
  return parseCacheTagsHeader(headers[NEXT_CACHE_TAGS_HEADER]);
}

export function toImplicitPathTags(
  originalPath: string,
  type?: 'layout' | 'page'
): string[] {
  const normalizedPath = removeTrailingSlash(
    originalPath.startsWith('/') ? originalPath : `/${originalPath}`
  );
  let implicitTag = `${NEXT_CACHE_IMPLICIT_TAG_ID}${normalizedPath}`;

  if (type) {
    implicitTag += `${implicitTag.endsWith('/') ? '' : '/'}${type}`;
  }

  const tags = [implicitTag];
  const rootTag = `${NEXT_CACHE_IMPLICIT_TAG_ID}/`;
  const indexTag = `${NEXT_CACHE_IMPLICIT_TAG_ID}/index`;
  if (implicitTag === rootTag) {
    tags.push(indexTag);
  } else if (implicitTag === indexTag) {
    tags.push(rootTag);
  }

  return unique(tags);
}

export function resolvePrerenderResumePath(
  seed: BunPrerenderSeed
): {
  pathname: string;
  search: string;
} | null {
  const rawStatePath = seed.fallback?.postponedStatePath;
  if (typeof rawStatePath !== 'string' || rawStatePath.length === 0) {
    return null;
  }

  const parsed = new URL(rawStatePath, 'https://adapter.bun.local');
  return {
    pathname: parsed.pathname || '/',
    search: parsed.search,
  };
}

export function applyPrerenderResumeHeaders(
  headers: Headers,
  seed: BunPrerenderSeed
): void {
  const rawHeaders = seed.pprChainHeaders;
  if (!rawHeaders || typeof rawHeaders !== 'object') {
    return;
  }

  for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
    if (typeof value === 'string') {
      headers.set(key, value);
      continue;
    }

    if (!Array.isArray(value)) {
      continue;
    }

    headers.delete(key);
    for (const item of value) {
      if (typeof item === 'string') {
        headers.append(key, item);
      }
    }
  }
}

function isUrlLikePostponedStatePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('http://') ||
    value.startsWith('https://')
  );
}

export function isPrerenderResumeRequest(
  seed: BunPrerenderSeed,
  request: Request
): boolean {
  const rawPostponedStatePath = seed.fallback?.postponedStatePath;
  if (
    typeof rawPostponedStatePath !== 'string' ||
    rawPostponedStatePath.length === 0
  ) {
    return false;
  }

  if (isUrlLikePostponedStatePath(rawPostponedStatePath)) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return false;
    }

    const resumePath = resolvePrerenderResumePath(seed);
    if (!resumePath) {
      return false;
    }

    const url = new URL(request.url);
    return url.pathname === resumePath.pathname && url.search === resumePath.search;
  }

  if (request.method !== 'POST') {
    return false;
  }

  const url = new URL(request.url);
  if (url.pathname !== seed.pathname) {
    return false;
  }

  const expectedChainHeaders = new Headers();
  applyPrerenderResumeHeaders(expectedChainHeaders, seed);
  for (const [key, value] of expectedChainHeaders.entries()) {
    if (request.headers.get(key) !== value) {
      return false;
    }
  }

  return true;
}

export function filterPrerenderRequestByAllowLists(
  seed: BunPrerenderSeed,
  request: Request
): Request {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return request;
  }

  const sourceUrl = new URL(request.url);
  const filteredUrl = new URL(sourceUrl.toString());
  filteredUrl.search = '';
  for (const key of readConfigAllowList(seed, 'allowQuery')) {
    for (const value of sourceUrl.searchParams.getAll(key)) {
      filteredUrl.searchParams.append(key, value);
    }
  }

  const headers = new Headers();
  for (const key of readConfigAllowList(seed, 'allowHeader')) {
    const value = request.headers.get(key);
    if (value !== null) {
      headers.set(key, value);
    }
  }

  return new Request(filteredUrl.toString(), {
    method: request.method,
    headers,
  });
}

export function evaluatePrerenderTagManifestState({
  entryCreatedAt,
  tags,
  tagManifestEntries,
  now,
}: {
  entryCreatedAt: number;
  tags: string[];
  tagManifestEntries: Record<string, PrerenderTagManifestEntry>;
  now: number;
}): 'fresh' | 'stale' | 'expired' {
  let stale = false;

  for (const tag of tags) {
    const manifestEntry = tagManifestEntries[tag];
    if (!manifestEntry) {
      continue;
    }

    const expiredAt = manifestEntry.expiredAt;
    if (
      typeof expiredAt === 'number' &&
      expiredAt > entryCreatedAt &&
      expiredAt <= now
    ) {
      return 'expired';
    }

    const staleAt = manifestEntry.staleAt;
    if (typeof staleAt === 'number' && staleAt > entryCreatedAt) {
      stale = true;
    }
  }

  return stale ? 'stale' : 'fresh';
}

function extractCookies(request: Request): Map<string, string> {
  const cookieHeader = request.headers.get('cookie');
  const cookies = new Map<string, string>();

  if (!cookieHeader) {
    return cookies;
  }

  for (const token of cookieHeader.split(';')) {
    const [namePart, ...valuePart] = token.trim().split('=');
    if (!namePart) continue;
    cookies.set(namePart, valuePart.join('='));
  }

  return cookies;
}

function getConditionInput(
  condition: PrerenderBypassCondition,
  request: Request,
  url: URL,
  cookies: Map<string, string>
): string | undefined {
  switch (condition.type) {
    case 'header':
      return request.headers.get(condition.key) ?? undefined;
    case 'cookie':
      return cookies.get(condition.key);
    case 'query':
      return url.searchParams.get(condition.key) ?? undefined;
    case 'host':
      return url.hostname;
    default:
      return undefined;
  }
}

function matchesConditionValue(
  input: string | undefined,
  expected: string | undefined
): boolean {
  if (input === undefined) {
    return false;
  }
  if (expected === undefined) {
    return true;
  }

  try {
    const regex = new RegExp(expected);
    if (regex.test(input)) {
      return true;
    }
  } catch {
    // fallback to exact equality
  }

  return input === expected;
}

function matchesBypassConditions(
  request: Request,
  url: URL,
  conditions: PrerenderBypassCondition[] | undefined
): boolean {
  if (!conditions || conditions.length === 0) {
    return false;
  }

  const cookies = extractCookies(request);
  for (const condition of conditions) {
    const input = getConditionInput(condition, request, url, cookies);
    if (matchesConditionValue(input, condition.value)) {
      return true;
    }
  }

  return false;
}

export function createPrerenderCacheKey(
  seed: BunPrerenderSeed,
  request: Request
): PrerenderCacheKey {
  const url = new URL(request.url);
  const requestPathname = removeTrailingSlash(url.pathname);
  const query: Record<string, string[]> = {};
  const headers: Record<string, string> = {};

  for (const queryKey of [...(seed.config.allowQuery ?? [])].sort((a, b) =>
    a.localeCompare(b)
  )) {
    const values = url.searchParams.getAll(queryKey);
    if (values.length > 0) {
      query[queryKey] = values;
    }
  }

  for (const headerKey of [...(seed.config.allowHeader ?? [])].sort((a, b) =>
    a.localeCompare(b)
  )) {
    // `host` is unstable across environments (random deploy/test ports) while
    // build-time prerender cache seeding is host-agnostic. Excluding it keeps
    // seeded entries addressable at runtime.
    if (headerKey.toLowerCase() === 'host') {
      continue;
    }
    const value = request.headers.get(headerKey);
    if (value !== null) {
      headers[headerKey.toLowerCase()] = value;
    }
  }

  const payload = JSON.stringify({
    seedPathname: seed.pathname,
    requestPathname,
    query,
    headers,
  });
  const hash = createHash('sha256').update(payload).digest('hex');

  return {
    key: `prerender:${seed.pathname}:${hash}`,
    pathname: requestPathname,
    query,
    headers,
  };
}

export function shouldBypassPrerenderCache(
  seed: BunPrerenderSeed,
  request: Request,
  resolver?: (request: Request, seed: BunPrerenderSeed) => boolean
): boolean {
  if (resolver) {
    return resolver(request, seed);
  }

  const url = new URL(request.url);
  const token = readBypassToken(seed);
  if (token) {
    const bypassQuery = url.searchParams.get('__prerender_bypass');
    const bypassHeader = request.headers.get('x-prerender-bypass');
    const bypassCookie = extractCookies(request).get('__prerender_bypass');

    if (bypassQuery === token || bypassHeader === token || bypassCookie === token) {
      return true;
    }
  }

  return matchesBypassConditions(
    request,
    url,
    seed.config.bypassFor as PrerenderBypassCondition[] | undefined
  );
}

export function evaluatePrerenderCacheEntry({
  entry,
  now,
}: {
  entry: PrerenderCacheEntry | null;
  now: number;
}): PrerenderCacheEvaluation {
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

function toResponseHeadersRecord(
  headers: PrerenderCacheableResponse['headers']
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

function applySeedCacheTags({
  headers,
  seed,
}: {
  headers: Record<string, string>;
  seed: BunPrerenderSeed;
}): Record<string, string> {
  const combinedTags = unique([
    ...readCacheTagsFromHeaders(headers),
    ...seed.tags,
  ]);
  if (combinedTags.length > 0) {
    headers[NEXT_CACHE_TAGS_HEADER] = combinedTags.join(',');
  }
  return headers;
}

function toRevalidateAt(
  now: number,
  revalidate: BunPrerenderSeed['fallback'] extends infer Fallback
    ? Fallback extends { initialRevalidate: infer Value }
      ? Value
      : never
    : never
): number | null {
  if (typeof revalidate === 'number' && revalidate > 0) {
    return now + revalidate * 1000;
  }
  return null;
}

function parseRevalidateSecondsFromCacheControl(
  cacheControl: string | undefined
): number | null {
  if (typeof cacheControl !== 'string' || cacheControl.length === 0) {
    return null;
  }

  const normalized = cacheControl.toLowerCase();
  const sMaxAgeMatch = normalized.match(/(?:^|,)\s*s-maxage=(\d+)/);
  if (sMaxAgeMatch?.[1]) {
    const parsed = Number.parseInt(sMaxAgeMatch[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const maxAgeMatch = normalized.match(/(?:^|,)\s*max-age=(\d+)/);
  if (maxAgeMatch?.[1]) {
    const parsed = Number.parseInt(maxAgeMatch[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function toExpiresAt(
  now: number,
  expirationSeconds: number | null | undefined
): number | null {
  if (typeof expirationSeconds === 'number' && expirationSeconds > 0) {
    return now + expirationSeconds * 1000;
  }
  return null;
}

export async function responseToPrerenderCacheEntry({
  seed,
  cacheKey,
  pathname,
  cacheQuery,
  cacheHeaders,
  response,
  now,
}: {
  seed: BunPrerenderSeed;
  cacheKey: string;
  pathname?: string;
  cacheQuery?: Record<string, string[]>;
  cacheHeaders?: Record<string, string>;
  response: PrerenderCacheableResponse;
  now: number;
}): Promise<PrerenderCacheEntry> {
  const bodyBuffer = Buffer.from(await response.arrayBuffer());
  const headers = applySeedCacheTags({
    headers: toResponseHeadersRecord(response.headers),
    seed,
  });
  const responseRevalidateSeconds = parseRevalidateSecondsFromCacheControl(
    headers['cache-control']
  );
  const revalidateSource =
    seed.fallback?.initialRevalidate ?? responseRevalidateSeconds ?? null;

  return {
    cacheKey,
    pathname: pathname ?? seed.pathname,
    groupId: seed.groupId,
    status: response.status,
    headers,
    body: bodyBuffer.toString('base64'),
    bodyEncoding: 'base64',
    createdAt: now,
    revalidateAt: toRevalidateAt(now, revalidateSource),
    expiresAt: toExpiresAt(now, seed.fallback?.initialExpiration),
    cacheQuery,
    cacheHeaders,
  };
}

export function prerenderCacheEntryToResponse(entry: PrerenderCacheEntry): Response {
  const body = Buffer.from(entry.body, 'base64');
  return new Response(body, {
    status: entry.status,
    headers: entry.headers,
  });
}

export class InMemoryPrerenderCacheStore implements PrerenderCacheStore {
  #entries = new Map<string, PrerenderCacheEntry>();
  #locks = new Map<string, number>();
  #tagManifest = new Map<string, PrerenderTagManifestEntry>();
  #targetsByCacheKey = new Map<
    string,
    PrerenderRevalidateTarget & {
      tags: string[];
    }
  >();
  #cacheKeysByTag = new Map<string, Set<string>>();
  #cacheKeysByPathname = new Map<string, Set<string>>();

  #addIndexValue(
    index: Map<string, Set<string>>,
    key: string,
    cacheKey: string
  ): void {
    const values = index.get(key) ?? new Set<string>();
    values.add(cacheKey);
    index.set(key, values);
  }

  #deleteIndexValue(
    index: Map<string, Set<string>>,
    key: string,
    cacheKey: string
  ): void {
    const values = index.get(key);
    if (!values) {
      return;
    }
    values.delete(cacheKey);
    if (values.size === 0) {
      index.delete(key);
    }
  }

  #removeTarget(cacheKey: string): void {
    const existing = this.#targetsByCacheKey.get(cacheKey);
    if (!existing) {
      return;
    }

    this.#deleteIndexValue(this.#cacheKeysByPathname, existing.pathname, cacheKey);
    for (const tag of existing.tags) {
      this.#deleteIndexValue(this.#cacheKeysByTag, tag, cacheKey);
    }
    this.#targetsByCacheKey.delete(cacheKey);
  }

  #upsertTarget(entry: PrerenderCacheEntry): void {
    this.#removeTarget(entry.cacheKey);

    const tags = readCacheTagsFromHeaders(entry.headers);
    this.#targetsByCacheKey.set(entry.cacheKey, {
      cacheKey: entry.cacheKey,
      pathname: entry.pathname,
      groupId: entry.groupId,
      tags,
    });
    this.#addIndexValue(this.#cacheKeysByPathname, entry.pathname, entry.cacheKey);
    for (const tag of tags) {
      this.#addIndexValue(this.#cacheKeysByTag, tag, entry.cacheKey);
    }
  }

  async get(cacheKey: string): Promise<PrerenderCacheEntry | null> {
    return this.#entries.get(cacheKey) ?? null;
  }

  async set(cacheKey: string, entry: PrerenderCacheEntry): Promise<void> {
    this.#entries.set(cacheKey, entry);
    this.#upsertTarget(entry);
  }

  async delete(cacheKey: string): Promise<void> {
    this.#entries.delete(cacheKey);
    this.#removeTarget(cacheKey);
  }

  async acquireRevalidateLock(
    cacheKey: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const now = Date.now();
    const existingExpiry = this.#locks.get(cacheKey);
    if (existingExpiry && existingExpiry > now) {
      return false;
    }

    this.#locks.set(cacheKey, now + ttlSeconds * 1000);
    return true;
  }

  async getTagManifestEntries(
    tags: string[]
  ): Promise<Record<string, PrerenderTagManifestEntry>> {
    const entries: Record<string, PrerenderTagManifestEntry> = {};
    for (const tag of unique(tags)) {
      const entry = this.#tagManifest.get(tag);
      if (entry) {
        entries[tag] = { ...entry };
      }
    }
    return entries;
  }

  async updateTagManifest(
    tags: string[],
    update: PrerenderTagManifestUpdate
  ): Promise<void> {
    const now = update.now ?? Date.now();
    for (const tag of unique(tags)) {
      if (!tag) {
        continue;
      }
      const existing = this.#tagManifest.get(tag) ?? {};
      if (update.mode === 'stale') {
        const nextEntry: PrerenderTagManifestEntry = {
          ...existing,
          staleAt: now,
        };
        if (
          typeof update.expireSeconds === 'number' &&
          Number.isFinite(update.expireSeconds)
        ) {
          nextEntry.expiredAt = now + update.expireSeconds * 1000;
        }
        this.#tagManifest.set(tag, nextEntry);
        continue;
      }

      this.#tagManifest.set(tag, {
        ...existing,
        expiredAt: now,
      });
    }
  }

  async findRevalidateTargets({
    tags,
    pathnames,
  }: {
    tags?: string[];
    pathnames?: string[];
  }): Promise<PrerenderRevalidateTarget[]> {
    const cacheKeys = new Set<string>();

    for (const pathname of unique(pathnames ?? [])) {
      for (const cacheKey of this.#cacheKeysByPathname.get(pathname) ?? []) {
        cacheKeys.add(cacheKey);
      }
    }

    for (const tag of unique(tags ?? [])) {
      for (const cacheKey of this.#cacheKeysByTag.get(tag) ?? []) {
        cacheKeys.add(cacheKey);
      }
    }

    const targets: PrerenderRevalidateTarget[] = [];
    for (const cacheKey of cacheKeys) {
      const target = this.#targetsByCacheKey.get(cacheKey);
      if (!target) {
        continue;
      }
      targets.push({
        cacheKey: target.cacheKey,
        pathname: target.pathname,
        groupId: target.groupId,
      });
    }

    return targets.sort((left, right) => {
      const byPathname = left.pathname.localeCompare(right.pathname);
      if (byPathname !== 0) {
        return byPathname;
      }
      return left.cacheKey.localeCompare(right.cacheKey);
    });
  }
}
