'use client';

import { useState } from 'react';

type RevalidateAction = {
  id: string;
  label: string;
  description: string;
  endpoint: string;
  body: Record<string, unknown>;
};

type RevalidateResult = {
  actionId: string;
  status: number;
  ok: boolean;
  payload: unknown;
  at: string;
};

const actions: RevalidateAction[] = [
  {
    id: 'tag-immediate',
    label: 'revalidateTag()',
    description:
      'Invalidates app-router-tag immediately (modeled as expire=0).',
    endpoint: '/api/revalidate-app',
    body: {
      tag: 'app-router-tag',
      tagExpire: 0,
    },
  },
  {
    id: 'tag-stale-window',
    label: 'revalidateTag() with stale time',
    description:
      'Invalidates app-router-tag with a stale window (expire=120s).',
    endpoint: '/api/revalidate-app',
    body: {
      tag: 'app-router-tag',
      tagExpire: 120,
    },
  },
  {
    id: 'path-app',
    label: 'revalidatePath()',
    description: 'Revalidates /app-router/cache-path.',
    endpoint: '/api/revalidate-app',
    body: {
      path: '/app-router/cache-path',
    },
  },
  {
    id: 'pages-on-demand',
    label: 'res.revalidate(path)',
    description: 'Triggers Pages on-demand revalidation for /pages-router/ssg.',
    endpoint: '/api/revalidate-pages',
    body: {
      path: '/pages-router/ssg',
    },
  },
];

function stringifyPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function RevalidateControls() {
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RevalidateResult | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  async function runAction(action: RevalidateAction): Promise<void> {
    setPendingActionId(action.id);
    setLastError(null);
    try {
      const response = await fetch(action.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(action.body),
      });

      const rawResponseBody = await response.text();
      let parsedBody: unknown = rawResponseBody;
      if (rawResponseBody.length > 0) {
        try {
          parsedBody = JSON.parse(rawResponseBody);
        } catch {
          parsedBody = rawResponseBody;
        }
      }

      setLastResult({
        actionId: action.id,
        status: response.status,
        ok: response.ok,
        payload: parsedBody,
        at: new Date().toISOString(),
      });
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
      setLastResult(null);
    } finally {
      setPendingActionId(null);
    }
  }

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
      <h3 style={{ marginTop: 0 }}>Revalidate Controls</h3>
      <p style={{ marginTop: 0 }}>
        Use these to exercise App Router + Pages Router revalidation behavior.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 12,
        }}
      >
        {actions.map((action) => (
          <div
            key={action.id}
            style={{
              border: '1px solid #ddd',
              borderRadius: 6,
              padding: 12,
              background: '#fff',
            }}
          >
            <button
              type="button"
              onClick={() => void runAction(action)}
              disabled={pendingActionId !== null}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                border: '1px solid #bbb',
                background: '#f4f4f4',
                borderRadius: 6,
                padding: '8px 10px',
                cursor: pendingActionId === null ? 'pointer' : 'not-allowed',
              }}
            >
              {pendingActionId === action.id ? 'Running...' : action.label}
            </button>
            <p style={{ marginBottom: 0 }}>{action.description}</p>
          </div>
        ))}
      </div>

      {lastError ? (
        <p style={{ color: '#8d1010', marginTop: 16 }}>
          <strong>Request failed:</strong> {lastError}
        </p>
      ) : null}

      {lastResult ? (
        <div style={{ marginTop: 16 }}>
          <strong>Last response</strong>
          <pre
            style={{
              marginTop: 8,
              overflowX: 'auto',
              background: '#f6f6f6',
              border: '1px solid #e1e1e1',
              borderRadius: 6,
              padding: 12,
            }}
          >
            {stringifyPayload(lastResult)}
          </pre>
        </div>
      ) : null}
    </section>
  );
}
