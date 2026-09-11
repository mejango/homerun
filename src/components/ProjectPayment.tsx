'use client'

import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import { buildPayTx, buildPermit2ApproveTx, uniswapV4Deployment } from '@bananapus/nana-sdk-core/v6'
import { addPermit2SignatureToDirectPaySwap, buildDirectPaySwapTx } from '@bananapus/nana-sdk-core/v6/direct-pay'
import { permit2AllowanceNeedsRefresh, permit2SignatureNeedsOnchainFallback, readPermit2Allowance, shouldUsePermit2Signature } from '@bananapus/nana-sdk-core/v6/permit2'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { erc20Abi, formatUnits, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { DisplayTokenAmount } from '@/components/DisplayTokenAmount'
import { useReviewedPermit2Signature } from '@/hooks/useReviewedPermit2Signature'
import { useSafeTx, txPhaseLabel, type TxRequest } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { parseAmount } from '@/lib/fund-contracts'
import { prepareProjectPayQuote, readProjectPayTokenOptions } from '@/lib/project-pay-quote'
import { swapDeadline } from '@/lib/safe-connector'

type PaymentTx = ReturnType<typeof useSafeTx>
type PaymentContext = { token: Address; terminal: Address; decimals: number; symbol: string }

function inputAmount(value: string, decimals: number) {
  if (!/^\d+(\.\d+)?$/.test(value.trim()) || (value.trim().split('.')[1]?.length ?? 0) > decimals) return 0n
  try { return parseAmount(value.trim(), decimals) } catch { return 0n }
}
function message(error: unknown) { return error instanceof Error ? error.message : 'The payment could not be prepared. Refresh and try again.' }
function Status({ tx, chainId }: { tx: PaymentTx; chainId: number }) {
  const url = tx.hash && !tx.safeProposalHash ? explorerTxUrl(chainId, tx.hash) : null
  return <div role="status" aria-live="polite" className="mt-3 break-words text-sm">
    {tx.safeProposalHash ? <p>Proposed to Safe. Execute the proposal in Safe before continuing.</p> : tx.phase === 'pending' ? <p>Submitted. Waiting for onchain confirmation…</p> : tx.phase === 'success' ? <p>Confirmed onchain.</p> : null}
    {tx.error && <p className="text-red-800">{tx.error}</p>}{url && <a className="underline" href={url} target="_blank" rel="noreferrer">View transaction</a>}
  </div>
}

/** Same bounded receipt lookup used by JBM's payment sequence. The useSafeTx
 * watchers remain mounted if this waiter times out or a Safe needs execution. */
async function paymentReceipt(client: PublicClient, hash: Hex) {
  try { return await client.waitForTransactionReceipt({ hash, timeout: 120_000 }) }
  catch (firstError) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try { return await client.getTransactionReceipt({ hash }) }
      catch { await new Promise(resolve => window.setTimeout(resolve, 2_000)) }
    }
    throw firstError
  }
}

/** FUND and INCOME share the reference clients' pay / direct-AMM execution
 * pipeline. The parent retains project-specific contract identity checks. */
export function ProjectPayment({ chainId, projectId, tokenLabel, title, context: accountingContext, paused, reservedPercent, rulesetId, verify }: {
  chainId: JBChainId; projectId: bigint; tokenLabel: 'FUND' | 'INCOME'; title: string
  context: PaymentContext; paused: boolean; reservedPercent: number; rulesetId: string
  verify: (account: Address, minimumBlock?: bigint) => Promise<{ blockNumber: bigint }>
}) {
  const { address, openSignIn } = useWallet()
  // The route query and all writes use the same chain-bound Wagmi client.
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const [input, setInput] = useState('')
  const [selectedToken, setSelectedToken] = useState<Address>()
  const tokenOptions = useQuery({
    queryKey: ['project-pay-tokens', chainId, projectId.toString(), accountingContext.terminal, rulesetId],
    enabled: !!client,
    queryFn: () => readProjectPayTokenOptions(client!, { chainId, projectId, terminal: accountingContext.terminal }),
    staleTime: 30_000, retry: false,
  })
  const context = tokenOptions.data?.find(option => isAddressEqual(option.token, selectedToken ?? accountingContext.token)) ?? accountingContext
  const [preparing, setPreparing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const tx = useSafeTx(chainId)
  const approval = useSafeTx(chainId)
  const routerApproval = useSafeTx(chainId)
  const { signPermit2Async } = useReviewedPermit2Signature()
  const cache = useQueryClient()
  const count = inputAmount(input, context.decimals)
  const intent = `${chainId}:${projectId}:${context.token}:${context.terminal}:${count}:${address ?? ''}:${rulesetId}:${paused}:${reservedPercent}:${tx.isSafe}`
  const currentIntent = useRef(intent)
  currentIntent.current = intent
  const confirmed = useRef(new Set<string>())
  const prerequisite = [approval, routerApproval].reduce<bigint | undefined>((latest, item) => item.phase === 'success' && item.receipt && (latest === undefined || item.receipt.blockNumber > latest) ? item.receipt.blockNumber : latest, undefined)
  useEffect(() => {
    for (const item of [tx, approval, routerApproval]) {
      if (item.phase !== 'success' || !item.receipt || confirmed.current.has(item.receipt.transactionHash)) continue
      confirmed.current.add(item.receipt.transactionHash)
      for (const prefix of ['fund-project', 'income-project', 'project-pay', 'project-pay-tokens', 'income-reserved']) void cache.invalidateQueries({ queryKey: [prefix, chainId, projectId.toString()] })
      for (const prefix of ['project-activity', 'indexed-project']) void cache.invalidateQueries({ queryKey: [prefix, chainId, projectId] })
    }
  }, [cache, chainId, projectId, tx, approval, routerApproval])
  const quote = useQuery({
    queryKey: ['project-pay', chainId, projectId.toString(), context.terminal, context.token, count.toString(), address ?? zeroAddress, rulesetId, reservedPercent],
    enabled: !!client && count > 0n && !paused,
    queryFn: () => prepareProjectPayQuote(client!, { chainId, projectId, terminal: context.terminal, token: context.token, amount: count, beneficiary: address ?? zeroAddress }),
    staleTime: 10_000, refetchInterval: 15_000, retry: false,
  })
  const minimum = quote.data?.minimumTokenCount ?? 0n
  const zeroAllocation = reservedPercent === 10_000 && quote.data?.kind === 'pay' && minimum === 0n && quote.data.reservedTokenCount > 0n
  const quoted = !!quote.data && !quote.isError && !quote.isPlaceholderData && (minimum > 0n || zeroAllocation)
  const busy = preparing || [tx, approval, routerApproval].some(item => item.busy || item.phase === 'review')
  async function submit() {
    if (!address || !client || !quoted || count <= 0n || busy) return
    const guard = () => { if (!mounted.current || currentIntent.current !== intent) throw new Error('The page, account, amount, currency, or project rules changed. Review the payment again.') }
    let latestBlock = prerequisite
    setPreparing(true); setError(null); setStatus('Finding the best available payment route…')
    try {
      guard()
      const current = await verify(address, latestBlock)
      latestBlock = current.blockNumber
      guard()
      const latest = await prepareProjectPayQuote(client, { chainId, projectId, terminal: context.terminal, token: context.token, amount: count, beneficiary: address })
      guard()
      if (latest.blockNumber < latestBlock) throw new Error('The quote RPC has not caught up with the verified project state. Refresh the quote and try again.')
      latestBlock = latest.blockNumber
      const noTokens = reservedPercent === 10_000 && latest.kind === 'pay' && latest.minimumTokenCount === 0n && latest.reservedTokenCount > 0n
      if (latest.minimumTokenCount <= 0n && !noTokens) throw new Error('No protected token output is available for this payment.')
      const swap = latest.kind === 'direct-swap' ? latest.swapQuote : undefined
      const deployment = swap ? uniswapV4Deployment(chainId) : undefined
      if (latest.kind === 'direct-swap' && (!swap || !deployment?.universalRouter)) throw new Error('The quoted swap route is unavailable on this network.')
      const spender = deployment?.permit2 ?? latest.terminal
      const native = isAddressEqual(context.token, NATIVE_TOKEN)
      const reverify = async () => { guard(); const checked = await verify(address, latestBlock); guard(); latestBlock = checked.blockNumber; return checked }
      const waitForApproval = async (action: PaymentTx, request: TxRequest) => {
        guard()
        const hash = await action.send(request, { simulationBlockNumber: latestBlock, reverify })
        if (!hash) throw new Error('Approval was cancelled. Nothing further was sent.')
        if (action.isSafe) { setStatus('Approval proposed to Safe. Execute it there, then continue the payment.'); return false }
        setStatus('Confirming approval onchain…')
        const receipt = await paymentReceipt(client, hash)
        if (receipt.status !== 'success') throw new Error('Approval reverted onchain.')
        if (latestBlock === undefined || receipt.blockNumber > latestBlock) latestBlock = receipt.blockNumber
        guard()
        return true
      }
      if (!native) {
        const allowance = await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address, spender], blockNumber: latestBlock })
        if (allowance < count) {
          setStatus(`Review ${context.symbol} access for ${swap ? 'the Uniswap route' : 'the payment terminal'}.`)
          if (!await waitForApproval(approval, { chainId, address: context.token, abi: erc20Abi, functionName: 'approve', args: [spender, count], label: `Approve exactly ${formatUnits(count, context.decimals)} ${context.symbol} for this payment` })) return
        }
      }
      let request: TxRequest
      if (swap && deployment?.universalRouter) {
        let swapRequest = buildDirectPaySwapTx({ chainId, quote: swap, amount: count, recipient: address, deadline: swapDeadline(tx.isSafe) })
        if (!native) {
          const permitClient = latestBlock === undefined ? client : { ...client, readContract: (args: Parameters<PublicClient['readContract']>[0]) => client.readContract({ ...args, blockNumber: latestBlock }) } as PublicClient
          const allowance = await readPermit2Allowance(permitClient, { chainId, owner: address, token: context.token })
          if (permit2AllowanceNeedsRefresh({ allowance, amount: count })) {
            const bytecode = await client.getBytecode({ address })
            guard()
            let onchain = !shouldUsePermit2Signature({ needsApproval: true, walletLookupSettled: true, walletBytecode: bytecode, isSafe: tx.isSafe })
            if (!onchain) {
              const signedAt = Math.floor(Date.now() / 1000)
              const authorization = { chainId, token: context.token, spender: deployment.universalRouter, amount: count, nonce: allowance.nonce, expiration: signedAt + 1_800, sigDeadline: BigInt(signedAt + 1_800) }
              try {
                setStatus('Review and sign the gasless swap authorization.')
                const signature = await signPermit2Async({ authorization, expectedAccount: address })
                guard()
                swapRequest = addPermit2SignatureToDirectPaySwap(swapRequest, authorization, signature)
              } catch (reason) {
                if (!permit2SignatureNeedsOnchainFallback(reason)) throw reason
                onchain = true
              }
            }
            if (onchain) {
              setStatus('Review the swap-router authorization.')
              if (!await waitForApproval(routerApproval, { ...buildPermit2ApproveTx({ chainId, token: context.token, amount: count, expiration: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 }), label: 'Authorize the Uniswap swap router for this exact payment amount' })) return
            }
          }
        }
        // Stamp after prerequisite approvals/signatures, preserving the exact
        // reviewed amount and protected output (JBM direct-pay-swap pattern).
        request = { ...swapRequest, args: [swapRequest.args[0], swapRequest.args[1], swapDeadline(tx.isSafe)] }
      } else request = buildPayTx({ chainId, projectId, terminal: latest.terminal, token: context.token, amount: count, beneficiary: address, minReturnedTokens: latest.minimumTokenCount, memo: `Homerun ${tokenLabel} payment` })
      const checked = await reverify()
      const route = swap ? 'Uniswap AMM' : 'Juicebox payment terminal'
      setStatus(`Review and execute the ${route} payment.`)
      await tx.send({ ...request, label: `Pay ${formatUnits(count, context.decimals)} ${context.symbol} through ${route}; minimum ${formatUnits(latest.minimumTokenCount, 18)} ${tokenLabel}` }, {
        simulationBlockNumber: latestBlock === undefined ? undefined : checked.blockNumber,
        reviewNotice: noTokens ? `You receive no ${tokenLabel} for this payment. This project allocates 100% of new tokens to its reserved recipients.` : [swap ? 'This route buys existing tokens on Uniswap. It does not add the payment to the project treasury or issue reserved tokens.' : null, latest.minimumTokenCount < minimum ? `The quote decreased. Your protected minimum is now ${formatUnits(latest.minimumTokenCount, 18)} ${tokenLabel}.` : null].filter(Boolean).join(' ') || undefined,
        reverify: async () => {
          const verified = await reverify()
          if (!native && await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address, spender], blockNumber: verified.blockNumber }) < count) throw new Error('Token approval changed. Review a new approval before paying.')
        },
      })
      setStatus(null)
    } catch (reason) { setError(message(reason)); setStatus(null) } finally { setPreparing(false) }
  }
  return <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
    <h3 className="mb-5 text-2xl">{title}</h3>
    <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
      <label className="mb-5 grid gap-2 text-sm">Pay with<select className="min-h-11 rounded border border-[#bfc9b5] bg-white px-3 pr-9" value={context.token} onChange={event => setSelectedToken(event.target.value as Address)}>{(tokenOptions.data?.length ? tokenOptions.data : [accountingContext]).map(option => <option key={option.token} value={option.token}>{option.symbol}</option>)}</select></label>
      <label className="grid gap-2 text-sm">Amount in {context.symbol}<input className="min-h-12 w-full rounded border border-[#bfc9b5] bg-white px-3 text-base" value={input} onChange={event => setInput(event.target.value)} inputMode="decimal" autoComplete="off" /></label>
    </fieldset>
    <div className="mt-5 text-sm" aria-live="polite">
      {paused ? <p>This project has paused payments.</p> : zeroAllocation ? <p>This payment gives you no {tokenLabel}. All new tokens are allocated to the reserved recipients.</p> : quoted ? <><p>Minimum <strong><DisplayTokenAmount value={minimum} /> {tokenLabel}</strong></p><p className="mt-2">{quote.data?.kind === 'direct-swap' ? 'Best quoted rate through Uniswap. Buys existing tokens; no reserved tokens are issued.' : 'Through the project payment terminal, using its current rules and buyback hook.'} 1% maximum slippage.</p></> : <p>{quote.isFetching ? 'Comparing payment and market quotes…' : `Enter an amount to see your ${tokenLabel} quote.`}</p>}
    </div>
    {quote.isError && <p role="alert" className="mt-3 text-sm">A protected payment quote is unavailable. {message(quote.error)}</p>}
    {address ? <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={busy || paused || count <= 0n || !quoted} onClick={() => void submit()}>{preparing ? 'Preparing payment…' : txPhaseLabel(tx.phase, { idle: tokenLabel === 'FUND' ? 'Review contribution' : 'Review payment', pending: 'Confirming onchain…' })}</button> : <button type="button" className="btn-primary mt-5 min-h-11 px-5" onClick={openSignIn}>Connect wallet</button>}
    {status && <p className="mt-3 text-sm" role="status">{status}</p>}{error && <p className="mt-3 text-sm text-red-800" role="alert">{error}</p>}
    <Status tx={approval} chainId={chainId} /><Status tx={routerApproval} chainId={chainId} /><Status tx={tx} chainId={chainId} />
  </section>
}
