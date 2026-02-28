import type { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import { DraftModePanel } from '../../components/draft-mode-panel';

type SsrProps = {
  renderedAt: string;
  random: number;
  middlewareHeader: string | null;
};

export const getServerSideProps: GetServerSideProps<SsrProps> = async ({ req }) => {
  return {
    props: {
      renderedAt: new Date().toISOString(),
      random: Math.random(),
      middlewareHeader:
        typeof req.headers['x-fixture-middleware'] === 'string'
          ? req.headers['x-fixture-middleware']
          : null,
    },
  };
};

export default function PagesSsrPage({
  renderedAt,
  random,
  middlewareHeader,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <main>
      <h2>Pages Router: getServerSideProps page</h2>
      <DraftModePanel />
      <pre>
        {JSON.stringify(
          {
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
