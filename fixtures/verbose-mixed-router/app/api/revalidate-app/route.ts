import { revalidatePath, revalidateTag, updateTag } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';

type RevalidateBody = {
  path?: unknown;
  paths?: unknown;
  tag?: unknown;
  tags?: unknown;
  tagProfile?: unknown;
  tagExpire?: unknown;
  updateTag?: unknown;
  updateTags?: unknown;
};

function toStringArray(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => {
      return typeof entry === 'string' && entry.length > 0;
    });
  }

  return [];
}

function normalizePath(pathname: string): string {
  if (pathname.startsWith('/')) {
    return pathname;
  }
  return `/${pathname}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function toNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function authorize(request: NextRequest): NextResponse | null {
  const configuredSecret = process.env.REVALIDATE_SECRET;
  if (!configuredSecret) {
    return null;
  }

  const providedSecret =
    request.headers.get('x-revalidate-secret') ??
    request.nextUrl.searchParams.get('secret');

  if (providedSecret !== configuredSecret) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Unauthorized',
      },
      { status: 401 }
    );
  }

  return null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const authError = authorize(request);
  if (authError) {
    return authError;
  }

  const body = (await request.json().catch(() => ({}))) as RevalidateBody;

  const paths = unique([
    ...toStringArray(body.path),
    ...toStringArray(body.paths),
  ]).map(normalizePath);

  const tags = unique([...toStringArray(body.tag), ...toStringArray(body.tags)]);
  const updateTags = unique([
    ...toStringArray(body.updateTag),
    ...toStringArray(body.updateTags),
  ]);
  const tagProfileName =
    typeof body.tagProfile === 'string' && body.tagProfile.length > 0
      ? body.tagProfile
      : null;
  const tagExpire = toNonNegativeNumber(body.tagExpire);
  const tagProfile: string | { expire: number } =
    tagExpire === null ? (tagProfileName ?? 'max') : { expire: tagExpire };

  if (paths.length === 0 && tags.length === 0 && updateTags.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Provide at least one of: path, paths, tag, tags, updateTag, updateTags',
      },
      { status: 400 }
    );
  }

  for (const path of paths) {
    revalidatePath(path);
  }

  for (const tag of tags) {
    revalidateTag(tag, tagProfile);
  }

  for (const tag of updateTags) {
    updateTag(tag);
  }

  return NextResponse.json({
    ok: true,
    source: 'app-router',
    revalidatedPaths: paths,
    revalidatedTags: tags,
    revalidateTagProfile: tagProfile,
    updatedTags: updateTags,
    at: new Date().toISOString(),
  });
}

export async function GET(): Promise<Response> {
  return NextResponse.json({
    ok: true,
    usage: {
      method: 'POST',
      body: {
        path: '/app-router/cache-path',
        paths: ['/app-router/cache-path'],
        tag: 'app-router-tag',
        tags: ['app-router-tag'],
        tagProfile: 'max',
        tagExpire: 120,
        updateTag: 'app-router-tag',
        updateTags: ['app-router-tag'],
      },
    },
  });
}
