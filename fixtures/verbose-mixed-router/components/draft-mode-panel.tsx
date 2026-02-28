'use client';

import { useRouter } from 'next/router';

export function DraftModePanel() {
  const router = useRouter();
  const enabled = Boolean(router.isPreview);

  return (
    <section
      style={{
        marginTop: 20,
        border: '1px solid #d7d7d7',
        borderRadius: 8,
        padding: 16,
        background: '#fcfcfc',
      }}
    >
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>Draft Mode</h3>
      <p style={{ margin: 0 }}>
        Status:{' '}
        <strong style={{ color: enabled ? '#0b6b2e' : '#5a5a5a' }}>
          {enabled ? 'Enabled' : 'Disabled'}
        </strong>
      </p>
      {enabled ? (
        <p style={{ marginTop: 8, marginBottom: 0, color: '#0b6b2e' }}>
          Draft mode is currently active for this route.
        </p>
      ) : null}
      <p style={{ marginTop: 8, marginBottom: 0 }}>
        Toggle draft mode from any App Router page that renders the draft controls.
      </p>
    </section>
  );
}
