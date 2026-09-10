import { notFound } from 'next/navigation'
import { TransactionReviewBrowserFixture } from '@/components/TransactionReviewBrowserFixture'

export const dynamic = 'force-dynamic'

export default function RuntimeReviewCheckPage() {
  if (process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER !== 'true') notFound()
  return <TransactionReviewBrowserFixture />
}
