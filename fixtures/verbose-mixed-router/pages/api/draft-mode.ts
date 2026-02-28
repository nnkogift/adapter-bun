import type { NextApiRequest, NextApiResponse } from 'next';

type DraftModeState = {
  ok: boolean;
  enabled: boolean;
  at: string;
};

function isDraftEnabled(req: NextApiRequest): boolean {
  return req.draftMode === true || req.preview === true;
}

function setNoStore(res: NextApiResponse): void {
  res.setHeader('cache-control', 'no-store, no-cache, max-age=0, must-revalidate');
}

function toEnabledFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value === '1' || value.toLowerCase() === 'true') {
      return true;
    }
    if (value === '0' || value.toLowerCase() === 'false') {
      return false;
    }
  }
  return null;
}

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse<DraftModeState | { ok: false; error: string }>
): void {
  setNoStore(res);

  if (req.method === 'GET') {
    res.status(200).json({
      ok: true,
      enabled: isDraftEnabled(req),
      at: new Date().toISOString(),
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    res.status(405).json({
      ok: false,
      error: 'Method Not Allowed',
    });
    return;
  }

  const fromBody =
    req.body && typeof req.body === 'object'
      ? toEnabledFlag((req.body as { enabled?: unknown }).enabled)
      : null;
  const fromQuery = toEnabledFlag(req.query.enabled);
  const current = isDraftEnabled(req);
  const nextEnabled = fromBody ?? fromQuery ?? !current;

  res.setDraftMode({ enable: nextEnabled });
  res.status(200).json({
    ok: true,
    enabled: nextEnabled,
    at: new Date().toISOString(),
  });
}
