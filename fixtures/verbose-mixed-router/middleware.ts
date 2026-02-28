import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export default function middleware(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname === '/middleware-rewrite') {
    const rewritten = NextResponse.rewrite(
      new URL('/app-router/static', request.url)
    );
    rewritten.headers.set('x-fixture-middleware', 'rewrite');
    rewritten.headers.set('x-fixture-pathname', request.nextUrl.pathname);
    return rewritten;
  }

  const response = NextResponse.next();
  response.headers.set('x-fixture-middleware', 'active');
  response.headers.set('x-fixture-pathname', request.nextUrl.pathname);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
