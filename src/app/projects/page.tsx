import type { Metadata } from 'next'
import { Brand } from '@/components/Brand'
import { WalletButton } from '@/components/WalletButton';
import { AccountProjects } from '@/components/AccountProjects'

export const metadata: Metadata = {
  title: 'Find a project',
  description: 'Find projects you manage and tokens you hold across Juicebox V6.',
  alternates: { canonical: '/projects' },
}

export default function ProjectsPage() {
  return <div className="project-page live-contract-page">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><Brand /><WalletButton /></header>
    <main id="main" className="mx-auto max-w-[1220px] px-5 py-10 sm:py-14" tabIndex={-1}>
      <h1 className="mb-8 text-5xl sm:text-6xl">Find a project</h1>
      <AccountProjects />
    </main>
  </div>
}
