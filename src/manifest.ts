import type {
  BunDeploymentManifest,
  BunFunctionArtifact,
  BunPrerenderSeed,
  BunRouteGraph,
  BunRouterManifest,
  BunStaticAsset,
  BuildCompleteContext,
} from './types.ts';

function toRouteGraph(routing: BuildCompleteContext['routing']): BunRouteGraph {
  return {
    beforeMiddleware: routing.beforeMiddleware,
    beforeFiles: routing.beforeFiles,
    afterFiles: routing.afterFiles,
    dynamicRoutes: routing.dynamicRoutes,
    onMatch: routing.onMatch,
    fallback: routing.fallback,
    shouldNormalizeNextData: routing.shouldNormalizeNextData,
    rsc: routing.rsc,
  };
}

export function collectOutputPathnames(
  outputs: BuildCompleteContext['outputs']
): string[] {
  const pathnames = new Set<string>();

  for (const output of [
    ...outputs.pages,
    ...outputs.pagesApi,
    ...outputs.appPages,
    ...outputs.appRoutes,
    ...outputs.prerenders,
    ...outputs.staticFiles,
  ]) {
    pathnames.add(output.pathname);
  }

  if (outputs.middleware) {
    pathnames.add(outputs.middleware.pathname);
  }

  // @next/routing resolves "/" by exact-matching against the pathnames list.
  // Pages Router emits the root page as "/index", so we also add "/" so the
  // route resolver can find it.
  if (pathnames.has('/index') && !pathnames.has('/')) {
    pathnames.add('/');
  }

  return [...pathnames].sort((a, b) => a.localeCompare(b));
}

export function buildRouterManifest({
  ctx,
  generatedAt,
  pathnames,
}: {
  ctx: BuildCompleteContext;
  generatedAt: string;
  pathnames: string[];
}): BunRouterManifest {
  return {
    schemaVersion: 1,
    generatedAt,
    buildId: ctx.buildId,
    basePath: ctx.config.basePath,
    i18n: ctx.config.i18n ?? null,
    pathnames,
    routeGraph: toRouteGraph(ctx.routing),
  };
}

export function buildDeploymentManifest({
  adapterName,
  adapterOutDir,
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
}: {
  adapterName: string;
  adapterOutDir: string;
  ctx: BuildCompleteContext;
  generatedAt: string;
  pathnames: string[];
  functionMap: BunFunctionArtifact[];
  staticAssets: BunStaticAsset[];
  prerenderSeeds: BunPrerenderSeed[];
  routerManifestPath: string;
  port: number;
  hostname: string;
  previewProps?: BunDeploymentManifest['runtime'] extends infer Runtime
    ? Runtime extends { previewProps?: infer Preview }
      ? Preview
      : never
    : never;
}): BunDeploymentManifest {
  const nodeFunctions = functionMap.filter(
    (artifact) => artifact.runtime === 'nodejs'
  ).length;
  const edgeFunctions = functionMap.filter(
    (artifact) => artifact.runtime === 'edge'
  ).length;
  const middlewareOutputId = ctx.outputs.middleware?.id ?? null;

  return {
    schemaVersion: 1,
    generatedAt,
    adapter: {
      name: adapterName,
      outDir: adapterOutDir,
    },
    build: {
      buildId: ctx.buildId,
      nextVersion: ctx.nextVersion,
      projectDir: ctx.projectDir,
      repoRoot: ctx.repoRoot,
      distDir: ctx.distDir,
      basePath: ctx.config.basePath,
      i18n: ctx.config.i18n ?? null,
    },
    server: {
      port,
      hostname,
    },
    artifacts: {
      routerManifestPath,
      staticRoot: 'static',
      functionRoot: 'bundle',
      prerenderSeedRoot: 'prerender-seeds',
    },
    routeGraph: toRouteGraph(ctx.routing),
    pathnames,
    runtime: {
      middlewareOutputId,
      previewProps: previewProps ?? null,
    },
    functionMap,
    staticAssets,
    prerenderSeeds,
    imageConfig: ctx.config.images ? {
      deviceSizes: ctx.config.images.deviceSizes,
      imageSizes: ctx.config.images.imageSizes,
      formats: ctx.config.images.formats as string[],
      minimumCacheTTL: ctx.config.images.minimumCacheTTL,
      remotePatterns: ctx.config.images.remotePatterns.map((p) => {
        if (p instanceof URL) {
          return {
            protocol: p.protocol.replace(/:$/, ''),
            hostname: p.hostname,
            port: p.port || undefined,
            pathname: p.pathname !== '/' ? p.pathname : undefined,
          };
        }
        return {
          protocol: p.protocol,
          hostname: p.hostname,
          port: p.port,
          pathname: p.pathname,
          search: p.search,
        };
      }),
      localPatterns: ctx.config.images.localPatterns,
      dangerouslyAllowSVG: ctx.config.images.dangerouslyAllowSVG,
      qualities: ctx.config.images.qualities,
    } : undefined,
    summary: {
      functionsTotal: functionMap.length,
      nodeFunctions,
      edgeFunctions,
      staticAssetsTotal: staticAssets.length,
      prerenderSeedsTotal: prerenderSeeds.length,
    },
  };
}
