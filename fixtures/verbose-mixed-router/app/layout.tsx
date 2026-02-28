import type { ReactNode } from 'react';
import { FixtureShell } from '../components/fixture-shell';
import '../styles/global.css';

export const metadata = {
  title: 'Verbose Mixed Router Fixture',
  description: 'App + Pages Router conformance fixture for adapter-cloudflare',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <FixtureShell>{children}</FixtureShell>
      </body>
    </html>
  );
}
