import type { NextAdapter } from 'next';

export type BuildCompleteContext = Parameters<
  NonNullable<NextAdapter['onBuildComplete']>
>[0];

export interface BunAdapterOptions {
  /**
   * Relative output path under the project directory (or absolute path).
   */
  outDir?: string;
  /**
   * Port to listen on (written into deployment manifest).
   */
  port?: number;
  /**
   * Hostname to bind to (written into deployment manifest).
   */
  hostname?: string;
  /**
   * Canonical deployed host used for Server Actions CSRF allow-listing
   * (for example `app.example.com` or `https://app.example.com`).
   */
  deploymentHost?: string;
  /**
   * Cache transport used by Next's cache handlers. `http` is the default and
   * uses fetch against a Bun-owned cache endpoint so Edge runtimes avoid direct
   * Node/Bun storage imports. `sqlite` forces direct Bun-local SQLite access.
   */
  cacheHandlerMode?: 'sqlite' | 'http';
  /**
   * Internal path used when `cacheHandlerMode` is `http`.
   */
  cacheEndpointPath?: string;
  /**
   * Shared secret for the internal cache endpoint. If omitted in `http` mode,
   * the Bun server generates a random token at startup and injects it into the
   * runtime environment for the cache handlers.
   */
  cacheAuthToken?: string;
}

export interface BunStaticAsset {
  id: string;
  pathname: string;
  sourceType: 'next-static' | 'public';
  sourcePath: string;
  stagedPath: string;
  objectKey: string;
  contentType: string | null;
  cacheControl: string | null;
}

export type BunRuntimeRouteHas =
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

export interface BunRuntimeRoute {
  sourceRegex: string;
  destination?: string;
  headers?: Record<string, string>;
  has?: BunRuntimeRouteHas[];
  missing?: BunRuntimeRouteHas[];
  status?: number;
}

export interface BunRuntimeI18nConfig {
  defaultLocale: string;
  locales: string[];
  localeDetection?: false;
  domains?: Array<{
    defaultLocale: string;
    domain: string;
    http?: true;
    locales?: string[];
  }>;
}

export interface BunRuntimeRouting {
  i18n?: BunRuntimeI18nConfig | null;
  caseSensitive?: boolean;
  beforeMiddleware: BunRuntimeRoute[];
  beforeFiles: BunRuntimeRoute[];
  afterFiles: BunRuntimeRoute[];
  dynamicRoutes: BunRuntimeRoute[];
  onMatch: BunRuntimeRoute[];
  fallback: BunRuntimeRoute[];
  shouldNormalizeNextData: boolean;
}

export interface BunRuntimeAssetBinding {
  name: string;
  filePath: string;
}

export interface BunRuntimeFunctionOutput {
  id: string;
  pathname: string;
  sourcePage: string;
  runtime: 'nodejs' | 'edge';
  filePath: string;
  edgeRuntime?: {
    modulePath: string;
    entryKey: string;
    handlerExport: string;
  };
  assets?: string[];
  assetBindings?: BunRuntimeAssetBinding[];
  wasmBindings?: BunRuntimeAssetBinding[];
  env?: Record<string, string>;
}

export interface BunResolvedPathnameSourcePageMap {
  [resolvedPathname: string]: string;
}

export interface BunRuntimeMiddlewareRouteMatcherHas {
  type: 'header' | 'cookie' | 'query' | 'host';
  key?: string;
  value?: string;
}

export interface BunRuntimeMiddlewareRouteMatcher {
  regexp: string;
  has?: BunRuntimeMiddlewareRouteMatcherHas[];
  missing?: BunRuntimeMiddlewareRouteMatcherHas[];
}

export type BunRuntimeDynamicMatcherSegment =
  | {
      type: 'static';
      value: string;
    }
  | {
      type: 'dynamic';
      key: string;
    }
  | {
      type: 'catchall';
      key: string;
    }
  | {
      type: 'optionalCatchall';
      key: string;
    };

export interface BunRuntimeDynamicMatcher {
  sourcePage: string;
  pathname: string;
  segments: BunRuntimeDynamicMatcherSegment[];
  staticSegmentCount: number;
  catchAllSegmentCount: number;
  optionalCatchAllSegmentCount: number;
}

export interface BunRuntimeLookup {
  routingPathnames: string[];
  pathnameAliasToCanonical: Record<string, string>;
  functionPathnameToOutputPathname: Record<string, string>;
  rscFunctionPathnameToOutputPathname: Record<string, string>;
  sourcePageByPathname: Record<string, string>;
  outputPathnamesBySourcePage: Record<string, string[]>;
  staticAssetPathnameToAssetPathname: Record<string, string>;
  dynamicMatchers: BunRuntimeDynamicMatcher[];
  middlewareMatchers: BunRuntimeMiddlewareRouteMatcher[] | null;
}

export interface BunDeploymentManifest {
  schemaVersion: 2;
  generatedAt: string;
  adapter: {
    name: string;
    outDir: string;
  };
  build: {
    buildId: string;
    nextVersion: string;
    projectDir: string;
    repoRoot: string;
    distDir: string;
    basePath: string;
    trailingSlash: boolean;
    i18n: BuildCompleteContext['config']['i18n'] | null;
  };
  server: {
    port: number;
    hostname: string;
  };
  pathnames: string[];
  runtime?: {
    previewProps?: {
      previewModeId: string;
      previewModeSigningKey: string;
      previewModeEncryptionKey: string;
    } | null;
    cache?: {
      handlerMode: 'sqlite' | 'http';
      endpointPath: string;
      authToken: string | null;
    } | null;
    routing?: BunRuntimeRouting | null;
    middleware?: BunRuntimeFunctionOutput | null;
    functions?: BunRuntimeFunctionOutput[];
    resolvedPathnameToSourcePage?: BunResolvedPathnameSourcePageMap;
    lookup?: BunRuntimeLookup;
  };
  staticAssets: BunStaticAsset[];
  summary: {
    staticAssetsTotal: number;
  };
}
