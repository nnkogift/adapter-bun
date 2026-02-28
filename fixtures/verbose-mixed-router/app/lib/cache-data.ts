import { unstable_cache } from 'next/cache';

function formatNow(): string {
  return new Date().toISOString();
}

export async function getPathCachedRecord(pathKey: string): Promise<{
  kind: 'path-cache';
  pathKey: string;
  generatedAt: string;
  random: number;
}> {
  const getCached = unstable_cache(
    async () => ({
      kind: 'path-cache' as const,
      pathKey,
      generatedAt: formatNow(),
      random: Math.random(),
    }),
    ['fixture-path-cache', pathKey],
    {
      revalidate: 60 * 15,
    }
  );

  return getCached();
}

export async function getTagCachedRecord(tag: string): Promise<{
  kind: 'tag-cache';
  tag: string;
  generatedAt: string;
  random: number;
}> {
  const getCached = unstable_cache(
    async () => ({
      kind: 'tag-cache' as const,
      tag,
      generatedAt: formatNow(),
      random: Math.random(),
    }),
    ['fixture-tag-cache', tag],
    {
      revalidate: 60 * 15,
      tags: [tag],
    }
  );

  return getCached();
}
