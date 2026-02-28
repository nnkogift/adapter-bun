import { draftMode } from 'next/headers';
import { redirect } from 'next/navigation';

function getReturnPath(formData: FormData): string {
  const value = formData.get('returnPath');
  if (typeof value !== 'string') {
    return '/';
  }
  if (!value.startsWith('/')) {
    return '/';
  }
  return value;
}

async function enableDraftModeAction(formData: FormData): Promise<void> {
  'use server';
  const returnPath = getReturnPath(formData);
  const draft = await draftMode();
  draft.enable();
  redirect(returnPath);
}

async function disableDraftModeAction(formData: FormData): Promise<void> {
  'use server';
  const returnPath = getReturnPath(formData);
  const draft = await draftMode();
  draft.disable();
  redirect(returnPath);
}

type AppDraftModePanelProps = {
  returnPath: string;
};

export async function AppDraftModePanel({ returnPath }: AppDraftModePanelProps) {
  const { isEnabled } = await draftMode();

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
        <strong style={{ color: isEnabled ? '#0b6b2e' : '#5a5a5a' }}>
          {isEnabled ? 'Enabled' : 'Disabled'}
        </strong>
      </p>
      {isEnabled ? (
        <p style={{ marginTop: 8, marginBottom: 0, color: '#0b6b2e' }}>
          Draft mode is currently active for this route.
        </p>
      ) : null}
      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <form action={enableDraftModeAction}>
          <input type="hidden" name="returnPath" value={returnPath} />
          <button
            type="submit"
            disabled={isEnabled}
            style={{
              border: '1px solid #bbb',
              background: '#f4f4f4',
              borderRadius: 6,
              padding: '7px 10px',
              cursor: isEnabled ? 'not-allowed' : 'pointer',
            }}
          >
            Enable draft mode
          </button>
        </form>
        <form action={disableDraftModeAction}>
          <input type="hidden" name="returnPath" value={returnPath} />
          <button
            type="submit"
            disabled={!isEnabled}
            style={{
              border: '1px solid #bbb',
              background: '#f4f4f4',
              borderRadius: 6,
              padding: '7px 10px',
              cursor: !isEnabled ? 'not-allowed' : 'pointer',
            }}
          >
            Disable draft mode
          </button>
        </form>
      </div>
    </section>
  );
}
