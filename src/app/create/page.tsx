import type { Metadata } from 'next';
import LiveCreate from '../../components/LiveCreate';
import { Brand } from '../../components/Brand';
import { WalletButton } from '@/components/WalletButton';

export const metadata: Metadata = {
  title: 'Design the rules',
  description: 'Set up an asset raise and review the initial FUND fundraising Juicebox before deployment.',
  alternates: { canonical: '/create' },
};

export default function CreatePage() {
  return <div className="create-page"><a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><Brand /><WalletButton /></header>
    <main id="main" tabIndex={-1}><LiveCreate /></main>
  </div>;
}
