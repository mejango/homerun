import type { Metadata } from 'next'
import { Brand } from '@/components/Brand'
import { WalletButton } from '@/components/WalletButton';
import { FundDeploy } from '@/components/LiveCreate'

export const metadata: Metadata = { title: 'Resume a deployment', robots: { index: false, follow: false } }

export default function RecoverDeploymentPage() {
  return <div className="project-page live-contract-page">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><Brand /><WalletButton /></header>
    <main id="main" className="mx-auto max-w-[1220px] px-5 py-10 sm:py-14" tabIndex={-1}>
      <h1 className="mb-8 text-5xl sm:text-6xl">Resume a deployment</h1>
      <FundDeploy />
    </main>
  </div>
}
