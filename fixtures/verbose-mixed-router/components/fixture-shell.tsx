import type { ReactNode } from 'react';
import Link from 'next/link';

type NavSection = {
  title: string;
  items: Array<{
    href: string;
    label: string;
  }>;
};

const navSections: NavSection[] = [
  {
    title: 'Home',
    items: [{ href: '/', label: 'Fixture home' }],
  },
  {
    title: 'App Router Pages',
    items: [
      { href: '/app-router/static', label: 'Static page' },
      { href: '/app-router/image', label: 'next/image page' },
      { href: '/app-router/dynamic', label: 'Dynamic page' },
      { href: '/app-router/ssr-dynamic/alpha', label: 'Dynamic SSR route (alpha)' },
      { href: '/app-router/ssr-dynamic/omega', label: 'Dynamic SSR route (omega)' },
      { href: '/app-router/isr-dynamic/alpha', label: 'Dynamic ISR route (prebuilt)' },
      { href: '/app-router/isr-dynamic/zeta', label: 'Dynamic ISR route (on-demand)' },
      { href: '/app-router/streaming', label: 'Streaming page' },
      { href: '/app-router/cache-path', label: 'Cache-path target' },
      { href: '/app-router/cache-tag', label: 'Cache-tag target' },
    ],
  },
  {
    title: 'Pages Router Pages',
    items: [
      { href: '/pages-router/static', label: 'Static page' },
      { href: '/pages-router/ssr', label: 'getServerSideProps' },
      { href: '/pages-router/ssr-dynamic/alpha', label: 'Dynamic getServerSideProps' },
      { href: '/pages-router/ssg', label: 'getStaticProps' },
      { href: '/pages-router/products/alpha', label: 'getStaticPaths alpha' },
      { href: '/pages-router/products/delta', label: 'getStaticPaths fallback' },
    ],
  },
  {
    title: 'API Routes (GET)',
    items: [
      { href: '/api/app-static', label: 'App route handler (static)' },
      { href: '/api/app-dynamic', label: 'App route handler (dynamic)' },
      { href: '/api/revalidate-app', label: 'App revalidate usage' },
      { href: '/api/revalidate-pages', label: 'Pages revalidate usage' },
      { href: '/api/draft-mode', label: 'Draft mode status' },
    ],
  },
  {
    title: 'Middleware + next.config',
    items: [
      { href: '/middleware-rewrite', label: 'Middleware rewrite' },
      { href: '/cfg/rewrite-order/alpha', label: 'Config rewrite order' },
      { href: '/cfg/rewrite-after/alpha', label: 'Config rewrite afterFiles' },
      { href: '/cfg/rewrite-fallback/foo/bar', label: 'Config rewrite fallback' },
      { href: '/cfg/redirect-old', label: 'Config redirect' },
      { href: '/cfg/external', label: 'Config external rewrite' },
    ],
  },
  {
    title: 'Internal Next Endpoints',
    items: [
      {
        href: '/_next/image?url=%2Fimages%2Fnextjs-logo.png&w=640&q=75',
        label: 'Image optimizer endpoint',
      },
    ],
  },
];

export function FixtureShell({ children }: { children: ReactNode }) {
  return (
    <>
      <header
        style={{
          borderBottom: '1px solid #ddd',
          padding: '16px 20px',
          background: '#fafafa',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>Verbose Mixed Router Fixture</h1>
        <p style={{ margin: '6px 0 0', color: '#444' }}>
          App Router + Pages Router + middleware + revalidation coverage.
        </p>
      </header>
      <main
        style={{
          display: 'grid',
          gridTemplateColumns: '300px 1fr',
          minHeight: 'calc(100vh - 86px)',
        }}
      >
        <aside style={{ borderRight: '1px solid #ddd', padding: 16 }}>
          <strong>Route Index</strong>
          {navSections.map((section) => (
            <div key={section.title} style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>
                {section.title}
              </div>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
                {section.items.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href} prefetch={false}>
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>
        <section style={{ padding: 20 }}>{children}</section>
      </main>
    </>
  );
}
