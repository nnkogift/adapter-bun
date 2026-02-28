import type { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import { DraftModePanel } from '../../../components/draft-mode-panel';

type PagesDynamicSsrProps = {
  id: string;
  renderedAt: string;
  random: number;
  middlewareHeader: string | null;
};

export const getServerSideProps: GetServerSideProps<PagesDynamicSsrProps> = async ({
  params,
  req,
}) => {
  const id = typeof params?.id === 'string' ? params.id : 'unknown';
  return {
    props: {
      id,
      renderedAt: new Date().toISOString(),
      random: Math.random(),
      middlewareHeader:
        typeof req.headers['x-fixture-middleware'] === 'string'
          ? req.headers['x-fixture-middleware']
          : null,
    },
  };
};

export default function PagesDynamicSsrPage({
  id,
  renderedAt,
  random,
  middlewareHeader,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <main>
      <h2>Pages Router: dynamic getServerSideProps page</h2>
      <DraftModePanel />
      <pre>
        {JSON.stringify(
          {
            id,
            renderedAt,
            random,
            middlewareHeader,
          },
          null,
          2
        )}
      </pre>
    </main>
  );
}
