'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import { OperatorProfile } from './OperatorProfile'
import { ModalShell } from './ui/ModalShell'
import {
  DEMO_PROJECT_PERMISSIONS, demoProjectManagementKey, parseDemoProjectManagement,
  replaceDemoProjectRole, validateDemoProjectDelegates, validateDemoProjectDetails,
  validateDemoProjectManagement, validateDemoProjectSplits,
  type DemoProjectDelegate, type DemoProjectDetails, type DemoProjectManagement, type DemoProjectSplit,
} from '@/lib/demo-project-management'

const inputClass = 'min-h-11 w-full rounded border border-[#bfc9b5] bg-transparent px-3 py-2'
const demoNotice = <p className="text-sm text-smoke-600"><strong>Demo.</strong> Changes are saved in this browser. They do not publish metadata or send transactions.</p>

export function useDemoProjectManagement(projectKey: string, initial: DemoProjectManagement, resetKey: number) {
  const [state, setState] = useState(initial)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const key = demoProjectManagementKey(projectKey)
  useEffect(() => {
    const read = () => {
      try { setState(parseDemoProjectManagement(localStorage.getItem(key)) ?? initial); setError('') }
      catch { setState(initial); setError('This browser cannot save project previews.') }
      setReady(true)
    }
    read()
    const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) read() }
    window.addEventListener('storage', storage)
    return () => window.removeEventListener('storage', storage)
  }, [key, initial, resetKey])

  const save = (next: DemoProjectManagement) => {
    if (!ready) throw new Error('Wait for this project preview to load.')
    const validated = validateDemoProjectManagement(next)
    try { localStorage.setItem(key, JSON.stringify(validated)) }
    catch { setError('This browser could not save your changes.'); throw new Error('This browser could not save your changes.') }
    setState(validated)
    setError('')
  }
  return { state, ready, error, save }
}

function Field({ label, value, onChange, multiline = false, limit = 160 }: {
  label: string; value: string; onChange: (value: string) => void; multiline?: boolean; limit?: number
}) {
  const id = useId()
  return <div className="grid gap-2"><label htmlFor={id}>{label}</label>{multiline
    ? <textarea id={id} className={inputClass} rows={4} value={value} maxLength={limit} onChange={event => onChange(event.target.value)} />
    : <input id={id} className={inputClass} value={value} maxLength={limit} onChange={event => onChange(event.target.value)} />}</div>
}

function PreviewEditor({ title, children, onClose, onSave, onBack, review }: {
  title: string; children: ReactNode; onClose: () => void; onSave: () => void; onBack: () => void; review: boolean
}) {
  const form = useId()
  return <ModalShell title={review ? `Review ${title.toLowerCase()}` : title} subtitle="Demo project preview" onClose={onClose} footer={<div className="flex flex-wrap justify-end gap-3">
    <button type="button" className="btn-secondary min-h-11 px-4 py-2" onClick={review ? onBack : onClose}>{review ? 'Back' : 'Cancel'}</button>
    <button type="submit" form={form} className="btn-primary min-h-11 px-4 py-2">{review ? 'Save demo changes' : 'Review changes'}</button>
  </div>}><form id={form} className="space-y-5" onSubmit={event => { event.preventDefault(); onSave() }}>{demoNotice}{children}</form></ModalShell>
}

export function DemoProjectDetailsEditor({ state, ready, onSave }: { state: DemoProjectManagement; ready: boolean; onSave: (state: DemoProjectManagement) => void }) {
  const [draft, setDraft] = useState<DemoProjectDetails | null>(null)
  const [review, setReview] = useState(false)
  const [error, setError] = useState('')
  const field = (key: keyof DemoProjectDetails, label: string, multiline = false) => draft && <Field label={label} value={draft[key]} multiline={multiline} limit={key === 'description' ? 10_000 : multiline ? 1200 : key === 'photo' || key.endsWith('Photo') ? 1_500_000 : 160} onChange={value => setDraft({ ...draft, [key]: value })} />
  return <>
    <button type="button" className="btn-secondary min-h-11 px-4 py-2" disabled={!ready} onClick={() => { setDraft({ ...state.details }); setReview(false); setError('') }}>Edit project details</button>
    {draft && <PreviewEditor title="Project details" review={review} onClose={() => setDraft(null)} onBack={() => setReview(false)} onSave={() => {
      try {
        const validated = validateDemoProjectDetails(draft)
        if (!review) { setDraft(validated); setReview(true) }
        else { onSave({ ...state, details: validated }); setDraft(null) }
        setError('')
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the project details.') }
    }}>
      {error && <p role="alert">{error}</p>}
      {review ? <>
        <h3>{draft.name}</h3><p>{draft.location}</p><p className="whitespace-pre-wrap">{draft.description}</p>
        {draft.photo && <p className="break-all">Project image: {draft.photo.startsWith('data:') ? 'Saved project image' : draft.photo}</p>}
        <OperatorProfile role="Owner" name={draft.ownerName} introduction={draft.ownerIntroduction} photoUrl={draft.ownerPhoto} address={state.ownerAddress || null} />
        <OperatorProfile name={draft.operatorName} introduction={draft.operatorIntroduction} photoUrl={draft.operatorPhoto} address={state.operatorAddress || null} />
      </> : <>
        {field('name', 'Project name')}{field('location', 'Location')}{field('description', 'About the project', true)}{field('photo', 'Project image URL')}
        <fieldset className="space-y-4"><legend className="mb-3 font-medium">Owner introduction</legend>{field('ownerName', 'Owner name')}{field('ownerIntroduction', 'About the Owner', true)}{field('ownerPhoto', 'Owner photo URL')}</fieldset>
        <fieldset className="space-y-4"><legend className="mb-3 font-medium">Operator introduction</legend>{field('operatorName', 'Operator name')}{field('operatorIntroduction', 'About the Operator', true)}{field('operatorPhoto', 'Operator photo URL')}</fieldset>
      </>}
    </PreviewEditor>}
  </>
}

export function DemoProjectControl({ state, ready, onSave }: { state: DemoProjectManagement; ready: boolean; onSave: (state: DemoProjectManagement) => void }) {
  const [role, setRole] = useState<'owner' | 'operator' | null>(null)
  const [address, setAddress] = useState('')
  const [review, setReview] = useState(false)
  const [error, setError] = useState('')
  return <section className="demo-section space-y-5">
    <h2>Project control</h2>{demoNotice}
    <p>The Owner controls the project. This is separate from holders’ FUND and INCOME balances.</p>
    <OperatorProfile role="Owner" name={state.details.ownerName} address={state.ownerAddress || null} />
    <button type="button" className="btn-secondary min-h-11 px-4 py-2" disabled={!ready} onClick={() => { setRole('owner'); setAddress(''); setReview(false); setError('') }}>Transfer project ownership</button>
    <OperatorProfile name={state.details.operatorName} address={state.operatorAddress || null} />
    <button type="button" className="btn-secondary min-h-11 px-4 py-2" disabled={!ready} onClick={() => { setRole('operator'); setAddress(''); setReview(false); setError('') }}>Replace Operator</button>
    {role && <PreviewEditor title={role === 'owner' ? 'Project ownership' : 'Operator replacement'} review={review} onClose={() => setRole(null)} onBack={() => setReview(false)} onSave={() => {
      try {
        const next = replaceDemoProjectRole(state, role, address)
        if (!review) { setAddress(next[role === 'owner' ? 'ownerAddress' : 'operatorAddress']); setReview(true) }
        else { onSave(next); setRole(null) }
        setError('')
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the address.') }
    }}>
      {error && <p role="alert">{error}</p>}
      {review ? <><p>New {role === 'owner' ? 'Owner' : 'Operator'}:</p><p className="break-all">{address}</p><p>The previous introduction is cleared when the account changes. You can write a new introduction in Overview.</p>{role === 'owner' && <p>Delegated permissions from the previous Owner are cleared from this preview.</p>}</> : <Field label={role === 'owner' ? 'New Owner address' : 'New Operator address'} value={address} onChange={setAddress} limit={42} />}
    </PreviewEditor>}
  </section>
}

export function DemoProjectPermissions({ state, ready, onSave }: { state: DemoProjectManagement; ready: boolean; onSave: (state: DemoProjectManagement) => void }) {
  const [draft, setDraft] = useState<DemoProjectDelegate[] | null>(null)
  const [review, setReview] = useState(false)
  const [error, setError] = useState('')
  return <section className="demo-section space-y-5">
    <h2>Permissions</h2>{demoNotice}<p>Preview which accounts can manage this project for its current Owner.</p>
    {state.delegates.length ? <div className="space-y-4">{state.delegates.map(delegate => <div key={delegate.address}><p className="break-all">{delegate.address}</p><p>{delegate.permissions.join(', ')}</p></div>)}</div> : <p>No delegated accounts.</p>}
    <button type="button" className="btn-secondary min-h-11 px-4 py-2" disabled={!ready} onClick={() => { setDraft(state.delegates.map(delegate => ({ ...delegate, permissions: [...delegate.permissions] }))); setReview(false); setError('') }}>Edit permissions</button>
    {draft && <PreviewEditor title="Project permissions" review={review} onClose={() => setDraft(null)} onBack={() => setReview(false)} onSave={() => {
      try {
        const delegates = validateDemoProjectDelegates(draft)
        if (!review) { setDraft(delegates); setReview(true) }
        else { onSave({ ...state, delegates }); setDraft(null) }
        setError('')
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the delegated accounts.') }
    }}>
      {error && <p role="alert">{error}</p>}
      {review ? <>{draft.length ? draft.map(delegate => <div key={delegate.address}><p className="break-all">{delegate.address}</p><p>{delegate.permissions.join(', ')}</p></div>) : <p>Remove all delegated accounts from this preview.</p>}</> : <>
        {draft.map((delegate, index) => <fieldset key={index} className="space-y-3 rounded border border-smoke-200 p-4"><legend>Account {index + 1}</legend>
          <Field label={`Account ${index + 1} address`} value={delegate.address} limit={42} onChange={value => setDraft(draft.map((entry, position) => position === index ? { ...entry, address: value } : entry))} />
          {DEMO_PROJECT_PERMISSIONS.map(permission => <label key={permission} className="flex items-center gap-3"><input type="checkbox" checked={delegate.permissions.includes(permission)} onChange={event => setDraft(draft.map((entry, position) => position === index ? { ...entry, permissions: event.target.checked ? [...entry.permissions, permission] : entry.permissions.filter(value => value !== permission) } : entry))} /><span>{permission}</span></label>)}
          <button type="button" className="quiet-button" onClick={() => setDraft(draft.filter((_, position) => position !== index))}>Remove account {index + 1}</button>
        </fieldset>)}
        <button type="button" className="btn-secondary min-h-11 px-4 py-2" disabled={draft.length >= 20} onClick={() => setDraft([...draft, { address: '', permissions: [] }])}>Add account</button>
      </>}
    </PreviewEditor>}
  </section>
}

export function DemoProjectSplits({ state, ready, onSave }: { state: DemoProjectManagement; ready: boolean; onSave: (state: DemoProjectManagement) => void }) {
  const [phase, setPhase] = useState<'fund' | 'income'>('fund')
  const [draft, setDraft] = useState<DemoProjectSplit[] | null>(null)
  const [review, setReview] = useState(false)
  const [error, setError] = useState('')
  const splits = state.splits[phase]
  const total = splits.reduce((sum, split) => sum + Number(split.percent), 0)
  return <section className="demo-section space-y-5" aria-label="Split recipient preview">
    <h3>Split recipients</h3>{demoNotice}
    <p>Try recipient addresses and percentages for each project. These saved previews are separate from the modeled token allocations and balances above.</p>
    <label className="grid max-w-xs gap-2">Project<select className={inputClass} value={phase} onChange={event => setPhase(event.target.value as 'fund' | 'income')}><option value="fund">FUND</option><option value="income">INCOME</option></select></label>
    {splits.length ? <div className="space-y-3">{splits.map(split => <p key={split.address} className="break-all">{split.percent}% — {split.address}</p>)}<p>{Number((100 - total).toFixed(7))}% unallocated in this preview.</p></div> : <p>No {phase.toUpperCase()} recipient preview saved.</p>}
    <button type="button" className="btn-secondary min-h-11 px-4 py-2" disabled={!ready} onClick={() => { setDraft(splits.map(split => ({ ...split }))); setReview(false); setError('') }}>Edit {phase.toUpperCase()} splits</button>
    {draft && <PreviewEditor title={`${phase.toUpperCase()} split recipients`} review={review} onClose={() => setDraft(null)} onBack={() => setReview(false)} onSave={() => {
      try {
        const validated = validateDemoProjectSplits(draft)
        if (!review) { setDraft(validated); setReview(true) }
        else { onSave({ ...state, splits: { ...state.splits, [phase]: validated } }); setDraft(null) }
        setError('')
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the split recipients.') }
    }}>
      {error && <p role="alert">{error}</p>}
      {review ? <>{draft.length ? draft.map(split => <p key={split.address} className="break-all">{split.percent}% — {split.address}</p>) : <p>Clear the {phase.toUpperCase()} recipient preview.</p>}<p>Modeling inputs and token balances stay the same.</p></> : <>
        {draft.map((split, index) => <fieldset key={index} className="space-y-3 rounded border border-smoke-200 p-4"><legend>Recipient {index + 1}</legend>
          <Field label={`Recipient ${index + 1} address`} value={split.address} limit={42} onChange={value => setDraft(draft.map((entry, position) => position === index ? { ...entry, address: value } : entry))} />
          <Field label={`Recipient ${index + 1} percent`} value={split.percent} limit={11} onChange={value => setDraft(draft.map((entry, position) => position === index ? { ...entry, percent: value } : entry))} />
          <button type="button" className="quiet-button" onClick={() => setDraft(draft.filter((_, position) => position !== index))}>Remove recipient {index + 1}</button>
        </fieldset>)}
        <button type="button" className="btn-secondary min-h-11 px-4 py-2" disabled={draft.length >= 20} onClick={() => setDraft([...draft, { address: '', percent: '' }])}>Add recipient</button>
      </>}
    </PreviewEditor>}
  </section>
}
