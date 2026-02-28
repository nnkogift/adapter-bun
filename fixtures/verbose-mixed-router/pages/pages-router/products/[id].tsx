import type {
  GetStaticPaths,
  GetStaticProps,
  InferGetStaticPropsType,
} from 'next';
import { DraftModePanel } from '../../../components/draft-mode-panel';

type ProductPageProps = {
  id: string;
  generatedAt: string;
  source: 'prebuilt' | 'fallback-generated';
  random: number;
};

const PREBUILT_IDS = ['alpha', 'beta', 'gamma'];

export const getStaticPaths: GetStaticPaths = async () => {
  return {
    paths: PREBUILT_IDS.map((id) => ({ params: { id } })),
    fallback: 'blocking',
  };
};

export const getStaticProps: GetStaticProps<ProductPageProps> = async ({ params }) => {
  const id = typeof params?.id === 'string' ? params.id : 'unknown';

  return {
    props: {
      id,
      generatedAt: new Date().toISOString(),
      source: PREBUILT_IDS.includes(id) ? 'prebuilt' : 'fallback-generated',
      random: Math.random(),
    },
    revalidate: 1800,
  };
};

export default function ProductPage({
  id,
  generatedAt,
  source,
  random,
}: InferGetStaticPropsType<typeof getStaticProps>) {
  return (
    <main>
      <h2>Pages Router: getStaticPaths/getStaticProps page</h2>
      <DraftModePanel />
      <pre>
        {JSON.stringify(
          {
            id,
            generatedAt,
            source,
            random,
          },
          null,
          2
        )}
      </pre>
    </main>
  );
}
