import { Suspense } from 'react';
import { AppDraftModePanel } from '../../../components/app-draft-mode-panel';
import { connection } from 'next/server';

async function wait(ms: number): Promise<void> {
  await connection()
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function SlowChunk({ label, delayMs }: { label: string; delayMs: number }) {
  await wait(delayMs);

  return (
    <p>
      Streamed chunk <strong>{label}</strong> at {new Date().toISOString()} after {delayMs}ms
    </p>
  );
}

function SlowChunkFallback({ label }: { label: string }) {
  return <p>Loading streamed chunk {label}...</p>;
}

export default function AppStreamingPage() {
  return (
    <div>
      <h2>App Router: streaming page</h2>
      <p>
        This page streams server-rendered chunks via independent suspense boundaries.
      </p>
      <AppDraftModePanel returnPath="/app-router/streaming" />

      <Suspense fallback={<SlowChunkFallback label="A" />}>
        <SlowChunk label="A" delayMs={500} />
      </Suspense>

      <Suspense fallback={<SlowChunkFallback label="B" />}>
        <SlowChunk label="B" delayMs={1500} />
      </Suspense>

      <Suspense fallback={<SlowChunkFallback label="C" />}>
        <SlowChunk label="C" delayMs={3000} />
      </Suspense>
    </div>
  );
}
