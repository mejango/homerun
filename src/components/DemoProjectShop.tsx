'use client'

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ModalShell } from '@/components/ui/ModalShell'
import {
  demoShopPrice, demoShopStorageKey, MAX_DEMO_SHOP_STORAGE_LENGTH,
  newDemoShopItem, parseDemoShopStorage,
  type DemoShopCurrency, type DemoShopItem, type DemoShopPhase,
} from '@/lib/demo-shop'
import { ShopItemEditor, ShopItemReview, ShopMediaPreview, ShopIcon, type ShopItemEditorState } from '@/components/ShopItemEditor'
import './demo-project-shop.css'

type Confirmation = { kind: 'remove'; item: DemoShopItem } | { kind: 'reset' }
const MAX_DEMO_ITEMS = 100

/** Local shop drafts only. Kept separate from verified ProjectShop and all transaction hooks. */
export function DemoProjectShop({ projectKey = 'founderhaus', phase, resetKey = 0 }: { projectKey?: string; phase: DemoShopPhase; resetKey?: number }) {
  const storageKey = demoShopStorageKey(projectKey, phase)
  // A different project or phase must not inherit an open editor or confirmation.
  return <DemoShopDraft key={storageKey} storageKey={storageKey} phase={phase} resetKey={resetKey} />
}

function DemoShopDraft({ storageKey, phase, resetKey }: { storageKey: string; phase: DemoShopPhase; resetKey: number }) {
  const id = useId()
  const [tab, setTab] = useState<'inventory' | 'customers'>('inventory')
  const [currency, setCurrency] = useState<DemoShopCurrency>('USD')
  const [items, setItems] = useState<DemoShopItem[]>([])
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [editor, setEditor] = useState<ShopItemEditorState | null>(null)
  const [preview, setPreview] = useState<DemoShopItem | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [notice, setNotice] = useState('')
  const previousReset = useRef(resetKey)
  const tokenLabel = phase === 'fund' ? 'FUND' : 'INCOME'

  useEffect(() => {
    let saved: ReturnType<typeof parseDemoShopStorage> = null
    try {
      const raw = localStorage.getItem(storageKey)
      saved = parseDemoShopStorage(raw)
      setNotice(raw && !saved ? 'The saved demo shop could not be read. Start a new draft below.' : '')
    } catch { setNotice('Browser storage is unavailable. Your demo shop will stay open for this visit.') }
    setCurrency(saved?.currency ?? 'USD')
    setItems(saved?.items ?? [])
    setEditor(null)
    setPreview(null)
    setConfirmation(null)
    setLoadedKey(storageKey)
  }, [storageKey])

  useEffect(() => {
    if (resetKey === previousReset.current) return
    previousReset.current = resetKey
    try { localStorage.removeItem(storageKey) } catch { /* Session state still resets. */ }
    setItems([])
    setCurrency('USD')
    setEditor(null)
    setPreview(null)
    setConfirmation(null)
    setNotice('Demo shop cleared.')
  }, [resetKey, storageKey])

  function save(next: DemoShopItem[], nextCurrency: DemoShopCurrency, message: string) {
    setItems(next)
    setCurrency(nextCurrency)
    setNotice(message)
    try {
      const json = JSON.stringify({ version: 1, currency: nextCurrency, items: next })
      if (json.length > MAX_DEMO_SHOP_STORAGE_LENGTH) throw new Error('Storage limit')
      localStorage.setItem(storageKey, json)
    } catch {
      setNotice(`${message} Browser storage is full or unavailable, so these changes last only for this visit. Use smaller media or media URLs to save them on this device.`)
    }
  }

  function addItems() {
    if (items.length >= MAX_DEMO_ITEMS) return
    setEditor({ mode: 'add', currency, items: [newDemoShopItem()] })
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'inventory' : event.key === 'End' ? 'customers' : tab === 'inventory' ? 'customers' : 'inventory'
    setTab(next)
    document.getElementById(`${id}-${next}`)?.focus()
  }

  return <section className="demo-project-shop" aria-label={`Demo ${tokenLabel} shop`}>
    <div className="ds-toolbar">
      <div className="ds-tabs" role="tablist" aria-label="Shop">
        {(['inventory', 'customers'] as const).map(value => <button key={value} type="button" role="tab" id={`${id}-${value}`} aria-controls={`${id}-${value}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={moveTab}>{value === 'inventory' ? 'Inventory' : 'Customers'}</button>)}
      </div>
      <button type="button" className="ds-button ds-button-primary" disabled={loadedKey !== storageKey || items.length >= MAX_DEMO_ITEMS} onClick={addItems}>Add items for sale</button>
    </div>
    <p className="ds-demo-note"><span>Demo {tokenLabel} shop</span> Build and review the {phase === 'fund' ? 'Juicebox' : 'Revnet'} phase shop on this device. Items are previews and cannot be purchased.</p>
    {items.length >= MAX_DEMO_ITEMS && <p className="ds-notice">This local demo holds up to {MAX_DEMO_ITEMS} items. Remove an item to add another.</p>}
    {notice && <p className="ds-notice" role="status">{notice}</p>}
    <div role="tabpanel" id={`${id}-inventory-panel`} aria-labelledby={`${id}-inventory`} hidden={tab !== 'inventory'}>
      {items.length ? <>
        <div className="ds-inventory-heading"><p>{items.length} {items.length === 1 ? 'item' : 'items'} | Prices in {currency}</p><button type="button" className="ds-text-button" onClick={() => setConfirmation({ kind: 'reset' })}>Clear demo shop</button></div>
        {[...new Set(items.map(item => item.category.trim()))].map(category => <section className="ds-category" key={category} aria-label={category || 'All shop items'}>
          {category && <h3>{category}</h3>}
          <ul className="ds-inventory">
            {items.filter(item => item.category.trim() === category).map(item => <li key={item.id} className="ds-item-card">
              <button type="button" className="ds-card-preview" aria-label={`Preview ${item.name}`} onClick={() => setPreview(item)}>
                <ShopMediaPreview media={item.media} large />
                <div className="ds-card-copy"><span className="ds-eyebrow">Demo item</span><h3>{item.name}</h3>{item.description && <p className="ds-card-description">{item.description}</p>}<p className="ds-card-price">{demoShopPrice(item, currency)}</p><p className="ds-card-quantity">{item.supply.trim() ? `${Number(item.supply).toLocaleString('en-US')} available` : 'Unlimited quantity'}{Number(item.discountPct) > 0 ? ` | ${item.discountPct}% off` : ''}</p></div>
              </button>
              <div className="ds-card-actions"><button type="button" aria-label={`Edit ${item.name}`} onClick={() => setEditor({ mode: 'edit', currency, items: [{ ...item, splits: item.splits.map(split => ({ ...split })) }] })}>Edit draft</button><button type="button" aria-label={`Remove ${item.name}`} onClick={() => setConfirmation({ kind: 'remove', item })}>Remove</button></div>
            </li>)}
          </ul>
        </section>)}
      </> : <div className="ds-empty"><ShopIcon /><h2>No items yet</h2><p>Offer stays, experiences, merchandise, or other items alongside the project. Start with an item and review how it will appear.</p><button type="button" className="ds-button ds-button-secondary" disabled={loadedKey !== storageKey} onClick={addItems}>Add your first item</button></div>}
    </div>
    <div role="tabpanel" id={`${id}-customers-panel`} aria-labelledby={`${id}-customers`} hidden={tab !== 'customers'}>
      <div className="ds-empty"><ShopIcon /><h2>No customers in this demo</h2><p>A live shop lists the people who own its items here. Adding a demo item creates a local preview, so it does not create purchases or customer balances.</p><button type="button" className="ds-button ds-button-secondary" onClick={() => setTab('inventory')}>View inventory</button></div>
    </div>
    {editor && <ShopItemEditor
      initial={editor} categories={[...new Set(items.map(item => item.category.trim()).filter(Boolean))]}
      maximumItems={editor.mode === 'edit' ? 1 : Math.min(20, MAX_DEMO_ITEMS - items.length)}
      onClose={() => setEditor(null)}
      onSave={(reviewed, reviewedCurrency) => {
        const next = editor.mode === 'edit' ? items.map(item => item.id === reviewed[0].id ? reviewed[0] : item) : [...items, ...reviewed]
        save(next, reviewedCurrency, editor.mode === 'edit' ? 'Demo item updated on this device.' : `${reviewed.length === 1 ? 'Demo item' : `${reviewed.length} demo items`} added on this device.`)
        setEditor(null)
        setTab('inventory')
      }}
    />}
    {preview && <ModalShell title={preview.name} subtitle="Demo item preview" onClose={() => setPreview(null)} maxWidth="max-w-xl" footer={<div className="ds-footer"><p>Preview only. This item is not for sale.</p><button type="button" className="ds-button ds-button-secondary" onClick={() => setPreview(null)}>Done</button></div>}><div className="demo-shop-editor"><ShopItemReview item={preview} currency={currency} /></div></ModalShell>}
    {confirmation && <ModalShell title={confirmation.kind === 'reset' ? 'Clear the demo shop?' : `Remove ${confirmation.item.name}?`} subtitle="This changes only the shop preview saved on this device." onClose={() => setConfirmation(null)} footer={<div className="ds-footer"><button type="button" className="ds-button ds-button-secondary" onClick={() => setConfirmation(null)}>Keep {confirmation.kind === 'reset' ? 'items' : 'item'}</button><button type="button" className="ds-button ds-button-primary" onClick={() => { save(confirmation.kind === 'reset' ? [] : items.filter(item => item.id !== confirmation.item.id), confirmation.kind === 'reset' ? 'USD' : currency, confirmation.kind === 'reset' ? 'Demo shop cleared.' : 'Demo item removed.'); setConfirmation(null) }}>{confirmation.kind === 'reset' ? 'Clear demo shop' : 'Remove demo item'}</button></div>}><p className="ds-confirm-copy">{confirmation.kind === 'reset' ? 'All item drafts and their local media will be removed from this demo.' : 'The item and its local media will be removed from your demo inventory.'}</p></ModalShell>}
  </section>
}
