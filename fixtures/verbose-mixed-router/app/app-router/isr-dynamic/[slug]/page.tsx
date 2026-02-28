import { unstable_cache } from 'next/cache';
import { AppDraftModePanel } from '../../../../components/app-draft-mode-panel';

const REVALIDATE_SECONDS = 60 * 15;

const getIsrDynamicPayload = unstable_cache(
  async (slug: string) => ({
    slug,
    generatedAt: new Date().toISOString(),
    random: Math.random(),
  }),
  ['fixture-app-isr-dynamic'],
  {
    revalidate: REVALIDATE_SECONDS,
    tags: ['fixture-app-isr-dynamic'],
  }
);

export const revalidate = 900;
export const dynamicParams = true;

export async function generateStaticParams(): Promise<Array<{ slug: string }>> {
  return [{ slug: 'alpha' }];
}

type AppIsrDynamicPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export default async function AppIsrDynamicPage({
  params,
}: AppIsrDynamicPageProps) {
  const { slug } = await params;
  const payload = await getIsrDynamicPayload(slug);

  return (
    <div>
      <h2>App Router: dynamic ISR route</h2>
      <p>
        <code>alpha</code> is pre-rendered at build. Other slugs are generated on
        demand and cached.
      </p>
      <AppDraftModePanel returnPath={`/app-router/isr-dynamic/${slug}`} />
      <pre>{JSON.stringify(payload, null, 2)}</pre>
    </div>
  );
}
