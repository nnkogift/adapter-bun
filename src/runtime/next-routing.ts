import type { resolveRoutes as resolveRoutesType } from '@next/routing';

type NextRoutingNamespace = {
  resolveRoutes?: typeof resolveRoutesType;
  default?: {
    resolveRoutes?: typeof resolveRoutesType;
  };
};

type NextRoutingExports = {
  resolveRoutes: typeof resolveRoutesType;
};

let nextRoutingExportsPromise: Promise<NextRoutingExports> | null = null;

function readExport<T>(
  name: string,
  direct: T | undefined,
  fromDefault: T | undefined
): T {
  if (typeof direct === 'function') {
    return direct;
  }
  if (typeof fromDefault === 'function') {
    return fromDefault;
  }

  throw new Error(`[adapter-bun] Failed to resolve @next/routing export "${name}"`);
}

async function loadNextRoutingExports(): Promise<NextRoutingExports> {
  if (!nextRoutingExportsPromise) {
    nextRoutingExportsPromise = (async () => {
      const namespace = (await import('@next/routing')) as unknown as NextRoutingNamespace;
      return {
        resolveRoutes: readExport<typeof resolveRoutesType>(
          'resolveRoutes',
          namespace.resolveRoutes,
          namespace.default?.resolveRoutes
        ),
      };
    })();
  }

  return nextRoutingExportsPromise;
}

export async function resolveRoutes(
  ...args: Parameters<typeof resolveRoutesType>
): ReturnType<typeof resolveRoutesType> {
  const exports = await loadNextRoutingExports();
  return exports.resolveRoutes(...args);
}
