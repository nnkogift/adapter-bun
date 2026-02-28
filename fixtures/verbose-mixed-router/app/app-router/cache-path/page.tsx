import { getPathCachedRecord } from '../../lib/cache-data';
import { AppDraftModePanel } from '../../../components/app-draft-mode-panel';

export default async function AppCachePathPage() {
  const payload = await getPathCachedRecord('/app-router/cache-path');

  return (
    <div>
      <h2>App Router: cache-path target</h2>
      <p>
        Revalidate with <code>revalidatePath('/app-router/cache-path')</code> via
        <code> POST /api/revalidate-app</code>.
      </p>
      <AppDraftModePanel returnPath="/app-router/cache-path" />
      <pre>{JSON.stringify(payload, null, 2)}</pre>
    </div>
  );
}
