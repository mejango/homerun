import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
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
  return <IntentProject key={id} intentId={id} />
}
