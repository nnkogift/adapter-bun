import type { AdapterOutput, NextAdapter } from 'next';

export type BuildCompleteContext = Parameters<
  NonNullable<NextAdapter['onBuildComplete']>
>[0];

export type FunctionOutput =
  | AdapterOutput['PAGES']
  | AdapterOutput['PAGES_API']
  | AdapterOutput['APP_PAGE']
  | AdapterOutput['APP_ROUTE']
  | AdapterOutput['MIDDLEWARE'];

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
}

type RoutingStages = Pick<
  BuildCompleteContext['routing'],
  | 'beforeMiddleware'
  | 'beforeFiles'
  | 'afterFiles'
  | 'dynamicRoutes'
  | 'onMatch'
  | 'fallback'
>;

export interface BunRouteGraph extends RoutingStages {
  shouldNormalizeNextData: boolean;
  rsc: BuildCompleteContext['routing']['rsc'];
}

export interface BunRouterManifest {
  schemaVersion: 1;
  generatedAt: string;
  buildId: string;
  basePath: string;
  i18n: BuildCompleteContext['config']['i18n'] | null;
  pathnames: string[];
  routeGraph: BunRouteGraph;
}

export interface BunFunctionFile {
  kind: 'entrypoint' | 'asset' | 'wasm';
  relativePath: string;
  sourcePath: string;
}

export interface BunFunctionArtifact {
  bundleId: string;
  id: FunctionOutput['id'];
  type: FunctionOutput['type'];
  pathname: string;
  sourcePage: string;
  runtime: FunctionOutput['runtime'];
  config: FunctionOutput['config'];
  inventoryPath: string;
  fileCount: number;
  files: BunFunctionFile[];
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

export interface BunPrerenderSeed {
  id: AdapterOutput['PRERENDER']['id'];
  pathname: AdapterOutput['PRERENDER']['pathname'];
  parentOutputId: AdapterOutput['PRERENDER']['parentOutputId'];
  groupId: AdapterOutput['PRERENDER']['groupId'];
  tags: string[];
  parentFallbackMode: AdapterOutput['PRERENDER']['parentFallbackMode'];
  pprChainHeaders: AdapterOutput['PRERENDER']['pprChain'] extends infer Chain
    ? Chain extends { headers: infer Headers }
      ? Headers
      : null
    : null;
  config: AdapterOutput['PRERENDER']['config'];
  fallback:
    | {
        stagedPath: string | null;
        sourcePath: string | null;
        postponedStatePath: string | null;
        initialStatus: number | null;
        initialHeaders: Record<string, string | string[]> | null;
        initialExpiration: number | null;
        initialRevalidate: NonNullable<
          AdapterOutput['PRERENDER']['fallback']
        >['initialRevalidate'] | null;
      }
    | null;
}

export interface BunDeploymentManifest {
  schemaVersion: 1;
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
    i18n: BuildCompleteContext['config']['i18n'] | null;
  };
  server: {
    port: number;
    hostname: string;
  };
  artifacts: {
    routerManifestPath: string;
    staticRoot: string;
    functionRoot: string;
    prerenderSeedRoot: string;
  };
  routeGraph: BunRouteGraph;
  pathnames: string[];
  runtime?: {
    middlewareOutputId?: string | null;
    previewProps?: {
      previewModeId: string;
      previewModeSigningKey: string;
      previewModeEncryptionKey: string;
    } | null;
  };
  functionMap: BunFunctionArtifact[];
  staticAssets: BunStaticAsset[];
  prerenderSeeds: BunPrerenderSeed[];
  imageConfig?: {
    deviceSizes: number[];
    imageSizes: number[];
    formats: string[];
    minimumCacheTTL: number;
    remotePatterns: Array<{
      protocol?: string;
      hostname: string;
      port?: string;
      pathname?: string;
      search?: string;
    }>;
    localPatterns?: Array<{ pathname?: string; search?: string }>;
    dangerouslyAllowSVG?: boolean;
    qualities?: number[];
  };
  summary: {
    functionsTotal: number;
    nodeFunctions: number;
    edgeFunctions: number;
    staticAssetsTotal: number;
    prerenderSeedsTotal: number;
  };
}
