import { unstable_cache } from "next/cache";

const getCached = unstable_cache(
  async () => ({
    generatedAt: new Date().toISOString(),
    random: Math.random(),
  }),
  ["fixture-app-static-page"],
  {
    revalidate: 60 * 15,
  },
);

export default async function AppStaticPage() {
  const payload = await getCached();

  return (
    <div>
      <h2>App Router: static page (cached)</h2>
      <p>Rendered as fully static content.</p>
      <pre>{JSON.stringify(payload, null, 2)}</pre>
    </div>
  );
}
