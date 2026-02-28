import { RevalidateControls } from '../components/revalidate-controls';

export default function HomePage() {
  return (
    <div>
      <h2>Fixture Home</h2>
      <p>
        Use the sidebar links to exercise App Router and Pages Router routes.
      </p>
      <h3>Revalidation endpoints</h3>
      <ul>
        <li>
          Dynamic SSR coverage: <code>/app-router/ssr-dynamic/[slug]</code> and{' '}
          <code>/pages-router/ssr-dynamic/[id]</code>
        </li>
        <li>
          Dynamic ISR coverage: <code>/app-router/isr-dynamic/[slug]</code> (
          <code>alpha</code> prebuilt, other slugs on-demand)
        </li>
        <li>
          <code>POST /api/revalidate-app</code> for <code>revalidatePath</code> and{' '}
          <code>revalidateTag</code> (supports <code>tagProfile</code> and{' '}
          <code>tagExpire</code>)
        </li>
        <li>
          <code>POST /api/revalidate-pages</code> for <code>res.revalidate()</code>
        </li>
        <li>
          <code>/app-router/image</code> to validate <code>next/image</code> via{' '}
          <code>/_next/image</code>
        </li>
      </ul>
      <p>
        Middleware headers should appear on most responses:{' '}
        <code>x-fixture-middleware</code> and <code>x-fixture-pathname</code>.
      </p>
      <RevalidateControls />
    </div>
  );
}
