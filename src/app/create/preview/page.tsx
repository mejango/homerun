import type { Metadata } from 'next'
import { Brand } from '@/components/Brand'
import { WalletButton } from '@/components/WalletButton'
import CreatePreview from '@/components/CreatePreview'

export const metadata: Metadata = {
  title: 'Preview your project',
  description: 'The project page Homerun publishes, rendered from your setup before anything is created.',
  robots: { index: false, follow: false },
}

export default function CreatePreviewPage() {
  return <div className="project-page live-contract-page">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><Brand /><WalletButton /></header>
    <main id="main" className="mx-auto max-w-[1220px] px-5 py-10 sm:py-14" tabIndex={-1}><CreatePreview /></main>
  </div>
}
