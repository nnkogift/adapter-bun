export default function PagesStaticPage() {
  return (
    <main>
      <h2>Pages Router: fully static page</h2>
      <p>This page has no data fetching function and is fully static.</p>
      <pre>{JSON.stringify({ mode: 'pure-static', dynamicData: false }, null, 2)}</pre>
    </main>
  );
}
