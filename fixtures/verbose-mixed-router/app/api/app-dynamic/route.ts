import { connection } from 'next/server';

export async function GET(): Promise<Response> {
  await connection();

  return Response.json(
    {
      kind: 'app-route-dynamic',
      generatedAt: new Date().toISOString(),
    },
    {
      headers: {
        'cache-control': 'no-store',
      },
    }
  );
}
