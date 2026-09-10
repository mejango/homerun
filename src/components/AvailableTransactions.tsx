'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { ModalShell } from './ui/ModalShell'
import { transactionCatalog, transactionRoles, transactionStages, type TransactionRole, type TransactionStage } from '@/lib/transaction-catalog'

/** Browsable without a wallet; signing remains on the verified live project. */
export function AvailableTransactions({ stage = 'create' }: { stage?: TransactionStage }) {
  const [open, setOpen] = useState(false)
  const [selectedStage, setStage] = useState<TransactionStage | 'all'>(stage)
  const [role, setRole] = useState<TransactionRole | 'all'>('all')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const stageId = useId(), roleId = useId()
  useEffect(() => {
    if (!open && wasOpen.current) triggerRef.current?.focus({ preventScroll: true })
    wasOpen.current = open
  }, [open])
  const entries = transactionCatalog.filter(entry =>
    (selectedStage === 'all' || entry.stages.includes(selectedStage)) &&
    (role === 'all' || entry.role === role || entry.role === 'anyone'),
  )
  return <>
    <button ref={triggerRef} className="available-transactions-button" type="button" aria-haspopup="dialog" onClick={() => { setStage(stage); setRole('all'); setOpen(true) }}>
      Available transactions <span aria-hidden="true">↗</span>
    </button>
    {open && <ModalShell title="Available transactions" subtitle="Explore what operators and token holders can do at each stage." maxWidth="max-w-3xl" onClose={() => setOpen(false)} footer={
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm">Open a live project to review and sign.</p>
        <Link className="btn-primary min-h-11 px-4 py-2" href="/projects" prefetch={false}>Find a live project <span aria-hidden="true">→</span></Link>
      </div>
    }>
      <div className="grid gap-5">
        <p className="text-sm leading-relaxed">This is a transaction guide. Actual availability depends on the project’s contracts, balances, and your wallet’s permissions. Browsing this list sends no transactions.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2 text-sm" htmlFor={stageId}>Lifecycle stage
            <select id={stageId} className="min-h-11 w-full rounded border border-smoke-300 bg-white p-3" value={selectedStage} onChange={event => setStage(event.target.value as TransactionStage | 'all')}>
              <option value="all">All stages</option>
              {transactionStages.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label className="grid gap-2 text-sm" htmlFor={roleId}>Role
            <select id={roleId} className="min-h-11 w-full rounded border border-smoke-300 bg-white p-3" value={role} onChange={event => setRole(event.target.value as TransactionRole | 'all')}>
              <option value="all">All roles</option>
              {transactionRoles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        </div>
        <p className="text-sm text-smoke-700" role="status">{entries.length} {entries.length === 1 ? 'action' : 'actions'}{role !== 'all' && role !== 'anyone' ? ', including actions anyone can take' : ''}</p>
        <ul className="grid list-none gap-3 p-0" aria-label="Transaction guide">
          {entries.map(entry => <li key={entry.id} className="rounded-md border border-smoke-200 bg-white p-4" data-transaction={entry.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h3 className="text-base font-semibold">{entry.title}</h3>
              <span className="text-xs text-smoke-700">{transactionRoles.find(item => item.id === entry.role)?.label}</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed">{entry.description}</p>
            {entry.setup && <p className="mt-3 text-xs text-bluebs-700">Requires verified INCOME / Sticky setup</p>}
          </li>)}
        </ul>
        {!entries.length && <p className="text-sm">No actions for this selection. Choose another role or view all stages.</p>}
      </div>
    </ModalShell>}
  </>
}
