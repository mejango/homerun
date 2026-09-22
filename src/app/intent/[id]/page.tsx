import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Brand } from '@/components/Brand'
import { WalletButton } from '@/components/WalletButton'
import { IntentProject } from '@/components/IntentProject'

const INTENT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

type IntentRouteProps = { params: Promise<{ id: string }> }

export const metadata: Metadata = {
  title: 'Published project',
  description: 'A Homerun project published to Juicebox Center that deploys on first use.',
  robots: { index: false, follow: false },
}

export default async function IntentPage({ params }: IntentRouteProps) {
  const { id } = await params
  if (!INTENT_ID.test(id)) notFound()
  return <div className="project-page live-contract-page">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><Brand /><WalletButton /></header>
    <main id="main" className="mx-auto max-w-[1220px] px-5 py-10 sm:py-14" tabIndex={-1}>
      <IntentProject key={id} intentId={id} />
    </main>
  </div>
}
