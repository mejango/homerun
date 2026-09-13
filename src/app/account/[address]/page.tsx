import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getAddress, isAddress } from 'viem'
import { AccountView } from '@/components/AccountView'
import { Brand } from '@/components/Brand'
import { WalletButton } from '@/components/WalletButton'

type Props = {
  params: Promise<{ address: string }>
  searchParams: Promise<{ network?: string }>
}

function accountAddress(input: string) {
  if (!isAddress(input, { strict: false })) notFound()
  return getAddress(input)
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const address = accountAddress((await params).address)
  return {
    title: `${address.slice(0, 6)}…${address.slice(-4)} / Account`,
    description: 'Account activity, tokens, store items, and projects across Juicebox and Revnet.',
    alternates: { canonical: `/account/${address}` },
  }
}

export default async function AccountPage({ params, searchParams }: Props) {
  const address = accountAddress((await params).address)
  const network = (await searchParams).network === 'testnet' ? 'testnet' : 'mainnet'
  return <div className="project-page live-contract-page">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><Brand /><WalletButton /></header>
    <main id="main" className="mx-auto max-w-[1220px] px-5 py-10 sm:py-14" tabIndex={-1}>
      <AccountView key={`${address}:${network}`} address={address} initialNetwork={network} />
    </main>
  </div>
}
