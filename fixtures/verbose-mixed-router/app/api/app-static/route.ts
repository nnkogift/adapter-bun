import { unstable_cache } from "next/cache";

const getCached = unstable_cache(
  async () => ({
    generatedAt: new Date().toISOString(),
    random: Math.random(),
  }),
  ["fixture-app-static-route"],
  {
    revalidate: 60 * 15,
  },
);

export async function GET(): Promise<Response> {
  const payload = await getCached();

  return Response.json({
    kind: "app-route-static",
    ...payload,
  });
}
