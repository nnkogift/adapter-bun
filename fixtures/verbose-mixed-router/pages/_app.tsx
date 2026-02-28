import type { AppProps } from 'next/app';
import { FixtureShell } from '../components/fixture-shell';
import '../styles/global.css';

export default function FixturePagesApp({ Component, pageProps }: AppProps) {
  return (
    <FixtureShell>
      <Component {...pageProps} />
    </FixtureShell>
  );
}
