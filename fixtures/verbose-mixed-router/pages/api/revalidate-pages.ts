import type { NextApiRequest, NextApiResponse } from 'next';

type RevalidateResult = {
  path: string;
  ok: boolean;
  error?: string;
};

type DirectProbeResult = {
  path: string;
  url: string;
  status: number | null;
  cacheHeader: string | null;
  error?: string;
};

function toStringArray(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => {
      return typeof entry === 'string' && entry.length > 0;
    });
  }

  return [];
}

function normalizePath(pathname: string): string {
  if (pathname.startsWith('/')) {
    return pathname;
  }

  return `/${pathname}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function readSingleHeader(req: NextApiRequest, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.length > 0);
    return typeof first === 'string' ? first : null;
  }
  return null;
}

function authorize(req: NextApiRequest, res: NextApiResponse): boolean {
  const configuredSecret = process.env.REVALIDATE_SECRET;
  if (!configuredSecret) {
    return true;
  }

  const providedSecret =
    (Array.isArray(req.headers['x-revalidate-secret'])
      ? req.headers['x-revalidate-secret'][0]
      : req.headers['x-revalidate-secret']) ??
    (typeof req.query.secret === 'string' ? req.query.secret : undefined);

  if (providedSecret !== configuredSecret) {
    res.status(401).json({
      ok: false,
      error: 'Unauthorized',
    });
    return false;
  }

  return true;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<void> {
  if (req.method === 'GET') {
    res.status(200).json({
      ok: true,
      usage: {
        method: 'POST',
        body: {
          path: '/pages-router/ssg',
          paths: ['/pages-router/ssg', '/pages-router/products/alpha'],
        },
      },
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    res.status(405).json({
      ok: false,
      error: 'Method Not Allowed',
    });
    return;
  }

  if (!authorize(req, res)) {
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const paths = unique([
    ...toStringArray((body as { path?: unknown }).path),
    ...toStringArray((body as { paths?: unknown }).paths),
  ]).map(normalizePath);

  const requestedPaths =
    paths.length > 0
      ? paths
      : ['/pages-router/ssg', '/pages-router/products/alpha'];

  const hostHeader = readSingleHeader(req, 'host');
  const originalHostHeader = readSingleHeader(req, 'x-cloudflare-adapter-original-host');
  const originalUrlHeader = readSingleHeader(req, 'x-cloudflare-adapter-original-url');
  const routerServerContextSymbol = Symbol.for('@next/router-server-methods');
  const routerServerContextsRaw = (
    globalThis as unknown as Record<PropertyKey, unknown>
  )[routerServerContextSymbol];
  const routerServerContexts =
    routerServerContextsRaw && typeof routerServerContextsRaw === 'object'
      ? (routerServerContextsRaw as Record<string, unknown>)
      : null;
  const routerServerContextKeys = routerServerContexts
    ? Object.keys(routerServerContexts).sort((left, right) => left.localeCompare(right))
    : [];
  const routerServerContextSummary = routerServerContextKeys.map((key) => {
    const value = routerServerContexts?.[key];
    if (!value || typeof value !== 'object') {
      return {
        key,
        hasRevalidate: false,
        hasNextConfig: false,
      };
    }
    const record = value as Record<string, unknown>;
    return {
      key,
      hasRevalidate: typeof record.revalidate === 'function',
      hasNextConfig: Boolean(record.nextConfig),
    };
  });
  const probeHost = originalHostHeader ?? hostHeader;
  const directProbes: DirectProbeResult[] = [];
  if (probeHost) {
    for (const path of requestedPaths) {
      const probeUrl = `https://${probeHost}${path}`;
      try {
        const response = await fetch(probeUrl, { method: 'HEAD' });
        directProbes.push({
          path,
          url: probeUrl,
          status: response.status,
          cacheHeader: response.headers.get('x-nextjs-cache'),
        });
      } catch (error) {
        directProbes.push({
          path,
          url: probeUrl,
          status: null,
          cacheHeader: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const results: RevalidateResult[] = [];

  for (const path of requestedPaths) {
    try {
      await res.revalidate(path);
      results.push({ path, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ path, ok: false, error: message });
    }
  }

  const allPassed = results.every((item) => item.ok);

  res.status(allPassed ? 200 : 500).json({
    ok: allPassed,
    source: 'pages-router',
    results,
    debug: {
      hostHeader,
      originalHostHeader,
      originalUrlHeader,
      probeHost,
      routerServerContextKeys,
      routerServerContextSummary,
      directProbes,
    },
    at: new Date().toISOString(),
  });
}
