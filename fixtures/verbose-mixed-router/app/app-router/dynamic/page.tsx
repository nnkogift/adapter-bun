import { Suspense } from 'react';
import { connection } from 'next/server';
import { AppDraftModePanel } from '../../../components/app-draft-mode-panel';

async function DynamicDetails() {
  await connection();
  await new Promise(resolve => setTimeout(resolve, 3_000))

  return (
    <pre>
      {JSON.stringify(
        {
          renderedAt: new Date().toISOString(),
          random: Math.random(),
        },
        null,
        2
      )}
    </pre>
  );
}

function DynamicDetailsFallback() {
  return <p>Loading dynamic details... with 3s delay</p>;
}

export default function AppDynamicPage() {
  return (
    <div>
      <h2>App Router: dynamic page (connection())</h2>
      <p>Rendered dynamically on every request.</p>
      <AppDraftModePanel returnPath="/app-router/dynamic" />
      <Suspense fallback={<DynamicDetailsFallback />}>
        <DynamicDetails />
      </Suspense>
    </div>
  );
}
