import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

export type RuntimeFunctionRuntime = 'nodejs' | 'edge';

export type RuntimeRequestMetaValue = string | string[] | undefined;
export type RuntimeRequestMetaParams = Record<string, RuntimeRequestMetaValue>;
export type RuntimeRevalidateHeaders = Record<string, string | string[]>;
export type RuntimeInternalRevalidate = (config: {
  urlPath: string;
  headers: RuntimeRevalidateHeaders;
  opts: { unstable_onlyGenerated?: boolean };
}) => Promise<void>;

export interface RuntimeRequestMeta {
  initURL?: string;
  initProtocol?: string;
  hostname?: string;
  revalidate?: RuntimeInternalRevalidate;
  isRSCRequest?: true;
  isPrefetchRSCRequest?: true;
  segmentPrefetchRSCRequest?: string;
}

export type RuntimeRouteHandlerContext = {
  waitUntil?: (prom: Promise<void>) => void;
  requestMeta?: unknown;
};

export type NodeRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RuntimeRouteHandlerContext
) => Promise<unknown>;

export type EdgeRouteHandler = (
  request: Request,
  ctx: RuntimeRouteHandlerContext & { signal?: AbortSignal }
) => Promise<Response>;

export interface RuntimeEdgeOutput {
  modulePath: string;
  entryKey: string;
  handlerExport: string;
}

export interface RuntimeAssetBinding {
  name: string;
  filePath: string;
}

export interface RuntimeFunctionOutput {
  id: string;
  pathname: string;
  sourcePage: string;
  runtime: RuntimeFunctionRuntime;
  filePath: string;
  edgeRuntime?: RuntimeEdgeOutput;
  assets?: string[];
  assetBindings?: RuntimeAssetBinding[];
  wasmBindings?: RuntimeAssetBinding[];
  env?: Record<string, string>;
}

export interface RuntimePrerenderManifestDynamicRoute {
  fallback?: string | null | false;
  fallbackRouteParams?: Array<{
    paramName: string;
    paramType: string;
  }>;
}

export interface RuntimePrerenderManifest {
  dynamicRoutes?: Record<string, RuntimePrerenderManifestDynamicRoute>;
  preview?: {
    previewModeId?: string;
    previewModeSigningKey?: string;
    previewModeEncryptionKey?: string;
  };
  routes?: Record<string, unknown>;
  notFoundRoutes?: string[];
  version?: number;
}

export interface RuntimeI18nConfig {
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

export interface RuntimeNextExperimentalConfig {
  isrFlushToDisk?: boolean;
  fetchCacheKeyPrefix?: string;
  allowedRevalidateHeaderKeys?: string[];
}

export interface RuntimeNextConfig {
  cacheHandler?: string;
  cacheMaxMemorySize?: number;
  experimental?: RuntimeNextExperimentalConfig;
}

export interface RuntimeRequiredServerFilesConfig {
  cacheHandler?: string;
  cacheMaxMemorySize?: number;
  experimental?: RuntimeNextExperimentalConfig;
}

export interface RuntimeBuildConfig {
  basePath?: string;
  i18n?: RuntimeI18nConfig | null;
  trailingSlash?: boolean;
  projectDir?: string;
  distDir?: string;
}

export type WaitUntilCollector = {
  waitUntil: (prom: Promise<void>) => void;
  drain: () => Promise<void>;
};

export type WriteFetchResponse = (
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
  options?: {
    statusOverride?: number;
    headerOverride?: Headers;
  }
) => Promise<void>;

export type AppendMutableHeader = (
  headers: IncomingHttpHeaders,
  key: string,
  value: string
) => void;
