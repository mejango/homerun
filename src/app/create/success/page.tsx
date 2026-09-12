import type { Metadata } from 'next'
import { Brand } from '@/components/Brand'
import { WalletButton } from '@/components/WalletButton'
import CreateSuccess from '@/components/CreateSuccess'

export const metadata: Metadata = { title: 'Project created', robots: { index: false, follow: false } }

export default function CreateSuccessPage() {
  return <div className="project-page live-contract-page">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><Brand /><WalletButton /></header>
    <main id="main" className="mx-auto max-w-[1220px] px-5 py-16 sm:py-24" tabIndex={-1}>
      <CreateSuccess />
    </main>
  </div>
}
