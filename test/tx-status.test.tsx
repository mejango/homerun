import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TX_STATUS_LINES, TxStatus, type TxStatusTx } from '@/components/ui/TxStatus'

const HASH = `0x${'a'.repeat(64)}`
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const tx = (fields: Partial<TxStatusTx>): TxStatusTx => ({ phase: 'idle', notice: null, held: null, error: null, hash: null, safeProposalHash: null, ...fields })
async function render(props: Parameters<typeof TxStatus>[0]) { await act(async () => root.render(<TxStatus {...props} />)) }

it.each([
  ['review', TX_STATUS_LINES.review],
  ['pending', TX_STATUS_LINES.pending],
  ['success', TX_STATUS_LINES.success],
] as const)('says the one shared line for %s', async (phase, line) => {
  await render({ tx: tx({ phase }), chainId: 1 })
  expect(host.querySelector('[role="status"]')!.textContent).toBe(line)
})

it('shows a Safe proposal until its execution hash, and links the transaction once there is one', async () => {
  await render({ tx: tx({ phase: 'held', notice: 'Held.', submissionHash: HASH }), chainId: 1 })
  expect(host.textContent).toContain(`${TX_STATUS_LINES.safeProposal} ${HASH}`)
  expect(host.querySelector('a')).toBeNull()
  await render({ tx: tx({ phase: 'success', submissionHash: HASH, hash: HASH }), chainId: 1 })
  expect(host.textContent).not.toContain(TX_STATUS_LINES.safeProposal)
  expect(host.querySelector('a')!.textContent).toBe(TX_STATUS_LINES.viewTransaction)
})

it('hides an error only when the card asks', async () => {
  await render({ tx: tx({ phase: 'error', error: 'It reverted.' }), chainId: 1 })
  expect(host.textContent).toContain('It reverted.')
  await render({ tx: tx({ phase: 'error', error: 'It reverted.' }), chainId: 1, hideError: true })
  expect(host.textContent).not.toContain('It reverted.')
})

it("retires the saved attempt when the user takes the held write's exit", async () => {
  const release = vi.fn(async () => true), retire = vi.fn(async () => undefined)
  await render({ tx: tx({ phase: 'held', notice: 'Held.', held: { kind: 'exit', line: 'Held.', label: 'Exit', release } }), chainId: 1, retire })
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Exit')!.click())
  await vi.waitFor(() => expect(retire).toHaveBeenCalledWith({ by: 'exit' }))
  expect(release).toHaveBeenCalledOnce()
})

it('is the status line of every card that shows one', async () => {
  const { readFileSync } = await import('node:fs')
  for (const name of ['ProjectPayment', 'IncomeProject', 'StickyHolder', 'FundOperatorActions', 'IncomeLoanTools', 'live-transactions']) {
    const source = readFileSync(`src/components/${name}.tsx`, 'utf8')
    expect(/<TxStatus\b/.test(source), `${name} uses TxStatus`).toBe(true)
    expect(source.includes(TX_STATUS_LINES.success), `${name} writes no success line of its own`).toBe(false)
  }
})
