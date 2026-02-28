import type { GetStaticProps, InferGetStaticPropsType } from 'next';
import { DraftModePanel } from '../../components/draft-mode-panel';

type SsgProps = {
  generatedAt: string;
  random: number;
};

export const getStaticProps: GetStaticProps<SsgProps> = async () => {
  return {
    props: {
      generatedAt: new Date().toISOString(),
      random: Math.random(),
    },
    revalidate: 3600,
  };
};

export default function PagesSsgPage({
  generatedAt,
  random,
}: InferGetStaticPropsType<typeof getStaticProps>) {
  return (
    <main>
      <h2>Pages Router: getStaticProps page</h2>
      <p>
        Revalidate this route with <code>POST /api/revalidate-pages</code>.
      </p>
      <DraftModePanel />
      <pre>{JSON.stringify({ generatedAt, random }, null, 2)}</pre>
    </main>
  );
}
