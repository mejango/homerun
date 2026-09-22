import type { Metadata } from 'next'
import CreatePreview from '@/components/CreatePreview'

export const metadata: Metadata = {
  title: 'Preview your project',
  description: 'The project page Homerun publishes, rendered from your setup before anything is created.',
  robots: { index: false, follow: false },
}

export default function CreatePreviewPage() {
  return <CreatePreview />
}
