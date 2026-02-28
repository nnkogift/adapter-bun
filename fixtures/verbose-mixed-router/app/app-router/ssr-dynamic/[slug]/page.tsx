import { connection } from 'next/server';
import { AppDraftModePanel } from '../../../../components/app-draft-mode-panel';

type AppSsrDynamicPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export default async function AppSsrDynamicPage({
  params,
}: AppSsrDynamicPageProps) {
  await connection();
  const { slug } = await params;

  return (
    <div>
      <h2>App Router: dynamic SSR route</h2>
      <p>Rendered via connection() on every request.</p>
      <AppDraftModePanel returnPath={`/app-router/ssr-dynamic/${slug}`} />
      <pre>
        {JSON.stringify(
          {
            slug,
            renderedAt: new Date().toISOString(),
            random: Math.random(),
          },
          null,
          2
        )}
      </pre>
    </div>
  );
}
