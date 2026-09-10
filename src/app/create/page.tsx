import type { Metadata } from 'next';
import Link from 'next/link';
import LiveCreate from '../../components/LiveCreate';
import { Brand } from '../../components/Brand';

export const metadata: Metadata = {
  title: 'Design the rules',
  description: 'Set up an asset raise and review the initial FUND fundraising Juicebox before deployment.',
  alternates: { canonical: '/create' },
};

export default function CreatePage() {
  return <div className="create-page"><a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><Brand /></header>
    <main id="main" tabIndex={-1}><p className="text-sm"><Link href="/create/recover">Resume a deployment ↗</Link></p><LiveCreate /></main>
  </div>;
}
