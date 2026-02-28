import { getTagCachedRecord } from '../../lib/cache-data';
import { AppDraftModePanel } from '../../../components/app-draft-mode-panel';

const APP_TAG = 'app-router-tag';

export default async function AppCacheTagPage() {
  const payload = await getTagCachedRecord(APP_TAG);

  return (
    <div>
      <h2>App Router: cache-tag target</h2>
      <p>
        Revalidate with <code>revalidateTag('{APP_TAG}')</code> via
        <code> POST /api/revalidate-app</code>.
      </p>
      <AppDraftModePanel returnPath="/app-router/cache-tag" />
      <pre>{JSON.stringify(payload, null, 2)}</pre>
    </div>
  );
}
