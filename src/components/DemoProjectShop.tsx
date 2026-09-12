'use client'

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ModalShell } from '@/components/ui/ModalShell'
import {
  demoShopPrice, demoShopStorageKey, MAX_DEMO_SHOP_MEDIA_BYTES, MAX_DEMO_SHOP_STORAGE_LENGTH,
  newDemoShopItem, parseDemoShopStorage, validateDemoShopItem,
  type DemoShopCurrency, type DemoShopItem, type DemoShopSplit,
} from '@/lib/demo-shop'
import './demo-project-shop.css'

type EditorState = { mode: 'add' | 'edit'; items: DemoShopItem[]; currency: DemoShopCurrency }
type Confirmation = { kind: 'remove'; item: DemoShopItem } | { kind: 'reset' }
const MAX_DEMO_ITEMS = 100

/** Local shop drafts only. Kept separate from verified ProjectShop and all transaction hooks. */
export function DemoProjectShop({ projectKey = 'founderhaus', resetKey = 0 }: { projectKey?: string; resetKey?: number }) {
  const id = useId()
  const [tab, setTab] = useState<'inventory' | 'customers'>('inventory')
  const [currency, setCurrency] = useState<DemoShopCurrency>('USD')
  const [items, setItems] = useState<DemoShopItem[]>([])
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [preview, setPreview] = useState<DemoShopItem | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [notice, setNotice] = useState('')
  const previousReset = useRef(resetKey)
  const storageKey = demoShopStorageKey(projectKey)

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

  return <section className="demo-project-shop" aria-label="Demo shop">
    <div className="ds-toolbar">
      <div className="ds-tabs" role="tablist" aria-label="Shop">
        {(['inventory', 'customers'] as const).map(value => <button key={value} type="button" role="tab" id={`${id}-${value}`} aria-controls={`${id}-${value}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={moveTab}>{value === 'inventory' ? 'Inventory' : 'Customers'}</button>)}
      </div>
      <button type="button" className="ds-button ds-button-primary" disabled={loadedKey !== storageKey || items.length >= MAX_DEMO_ITEMS} onClick={addItems}>Add items for sale</button>
    </div>
    <p className="ds-demo-note"><span>Demo shop</span> Build and review a shop on this device. Items are previews and cannot be purchased.</p>
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
                <MediaPreview media={item.media} large />
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
    {editor && <ItemEditor
      initial={editor} categories={[...new Set(items.map(item => item.category.trim()).filter(Boolean))]}
      maximumItems={editor.mode === 'edit' ? 1 : Math.min(20, MAX_DEMO_ITEMS - items.length)}
      currencyLocked={items.length > 0} onClose={() => setEditor(null)}
      onSave={(reviewed, reviewedCurrency) => {
        const next = editor.mode === 'edit' ? items.map(item => item.id === reviewed[0].id ? reviewed[0] : item) : [...items, ...reviewed]
        save(next, reviewedCurrency, editor.mode === 'edit' ? 'Demo item updated on this device.' : `${reviewed.length === 1 ? 'Demo item' : `${reviewed.length} demo items`} added on this device.`)
        setEditor(null)
        setTab('inventory')
      }}
    />}
    {preview && <ModalShell title={preview.name} subtitle="Demo item preview" onClose={() => setPreview(null)} maxWidth="max-w-xl" footer={<div className="ds-footer"><p>Preview only. This item is not for sale.</p><button type="button" className="ds-button ds-button-secondary" onClick={() => setPreview(null)}>Done</button></div>}><div className="demo-shop-editor"><ItemReview item={preview} currency={currency} /></div></ModalShell>}
    {confirmation && <ModalShell title={confirmation.kind === 'reset' ? 'Clear the demo shop?' : `Remove ${confirmation.item.name}?`} subtitle="This changes only the shop preview saved on this device." onClose={() => setConfirmation(null)} footer={<div className="ds-footer"><button type="button" className="ds-button ds-button-secondary" onClick={() => setConfirmation(null)}>Keep {confirmation.kind === 'reset' ? 'items' : 'item'}</button><button type="button" className="ds-button ds-button-primary" onClick={() => { save(confirmation.kind === 'reset' ? [] : items.filter(item => item.id !== confirmation.item.id), confirmation.kind === 'reset' ? 'USD' : currency, confirmation.kind === 'reset' ? 'Demo shop cleared.' : 'Demo item removed.'); setConfirmation(null) }}>{confirmation.kind === 'reset' ? 'Clear demo shop' : 'Remove demo item'}</button></div>}><p className="ds-confirm-copy">{confirmation.kind === 'reset' ? 'All item drafts and their local media will be removed from this demo.' : 'The item and its local media will be removed from your demo inventory.'}</p></ModalShell>}
  </section>
}

function ItemEditor({ initial, categories, currencyLocked, maximumItems, onClose, onSave }: {
  initial: EditorState; categories: string[]; currencyLocked: boolean; maximumItems: number; onClose: () => void
  onSave: (items: DemoShopItem[], currency: DemoShopCurrency) => void
}) {
  const formId = useId()
  const [items, setItems] = useState(initial.items)
  const [currency, setCurrency] = useState(initial.currency)
  const [review, setReview] = useState(false)
  const [attempted, setAttempted] = useState(0)
  const [uploading, setUploading] = useState<string | null>(null)
  const [mediaErrors, setMediaErrors] = useState<Record<string, string>>({})
  const [discard, setDiscard] = useState(false)
  const [message, setMessage] = useState('')
  const initialJson = useRef(JSON.stringify(initial))
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const dirty = JSON.stringify({ mode: initial.mode, items, currency }) !== initialJson.current
  const errors = items.map(item => ({ ...(attempted ? validateDemoShopItem(item, currency) : {}), ...(mediaErrors[item.id] ? { media: mediaErrors[item.id] } : {}) }))
  useEffect(() => {
    if (review) document.querySelector<HTMLElement>('dialog[open] .ds-item-review')?.focus({ preventScroll: true })
  }, [review])

  function update(id: string, patch: Partial<DemoShopItem>) {
    setItems(current => current.map(item => item.id === id ? { ...item, ...patch } : item))
    setMessage('')
  }

  async function upload(itemId: string, file: File | undefined) {
    if (!file) return
    if (!/^(image\/|video\/|audio\/|text\/|application\/pdf$)/.test(file.type) && !/\.(md|markdown|txt)$/i.test(file.name)) {
      setMediaErrors(current => ({ ...current, [itemId]: 'Choose an image, video, audio, PDF, or text file.' }))
      return
    }
    if (file.size > MAX_DEMO_SHOP_MEDIA_BYTES) {
      setMediaErrors(current => ({ ...current, [itemId]: 'Use a file up to 2 MB for this local demo, or add a media URL.' }))
      return
    }
    setUploading(itemId)
    setMediaErrors(current => ({ ...current, [itemId]: '' }))
    const mediaType = /^(image|video|audio)\//.test(file.type) || file.type === 'application/pdf' ? file.type
      : file.type === 'text/csv' ? 'text/csv' : /\.(md|markdown)$/i.test(file.name) ? 'text/markdown' : 'text/plain'
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The file could not be read.'))
        reader.onerror = () => reject(new Error('The file could not be read. Try selecting it again.'))
        reader.readAsDataURL(file.type === mediaType ? file : new Blob([file], { type: mediaType }))
      })
      if (mounted.current) update(itemId, { media: { url: data, type: mediaType, name: file.name } })
    } catch (error) {
      if (mounted.current) setMediaErrors(current => ({ ...current, [itemId]: error instanceof Error ? error.message : 'The file could not be read.' }))
    } finally { if (mounted.current) setUploading(null) }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (uploading) return
    setAttempted(current => current + 1)
    if (!items.length) { setMessage('Add at least one item to review.'); return }
    if (items.length > maximumItems) { setMessage(`This demo has room for ${maximumItems} more ${maximumItems === 1 ? 'item' : 'items'}. Remove a draft to continue.`); return }
    const invalid = items.findIndex(item => Object.keys(validateDemoShopItem(item, currency)).length > 0 || mediaErrors[item.id])
    if (invalid >= 0) {
      setMessage(`Check the highlighted fields for item ${invalid + 1}.`)
      requestAnimationFrame(() => {
        const field = Array.from(document.querySelectorAll<HTMLElement>(`#${CSS.escape(formId)} [aria-invalid="true"]`)).find(element => element.getClientRects().length > 0)
        field?.focus()
        field?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
      return
    }
    setMessage('')
    setReview(true)
    document.querySelector<HTMLElement>('dialog[open] [data-modal-body]')?.scrollTo({ top: 0 })
  }

  function close() {
    if (uploading) return
    if (dirty && !discard) setDiscard(true)
    else onClose()
  }

  return <ModalShell
    title={discard ? 'Discard your changes?' : review ? initial.mode === 'edit' ? 'Review item changes' : 'Review shop items' : initial.mode === 'edit' ? 'Edit demo item' : 'Add items for sale'}
    subtitle={discard ? 'Your existing demo inventory will stay as it is.' : review ? 'Check each item before saving it to your demo inventory.' : 'Stage your items, then review how they will appear in the shop.'}
    onClose={close} busy={!!uploading} maxWidth="max-w-3xl"
    footer={<div className="ds-footer">
      {discard ? <button type="button" className="ds-button ds-button-secondary" onClick={() => setDiscard(false)}>Keep editing</button>
        : review ? <><button type="button" className="ds-button ds-button-secondary" onClick={() => setReview(false)}>Back to editor</button><button type="button" className="ds-button ds-button-primary" onClick={() => onSave(items.map(item => ({ ...item, name: item.name.trim(), description: item.description.trim(), category: item.category.trim(), splits: item.splits.map(split => ({ ...split })) })), currency)}>{initial.mode === 'edit' ? 'Save demo changes' : items.length === 1 ? 'Add item to demo shop' : `Add ${items.length} items to demo shop`}</button></>
          : <><button type="button" className="ds-button ds-button-secondary" disabled={!!uploading} onClick={close}>Cancel</button><button type="submit" form={formId} className="ds-button ds-button-primary" disabled={!!uploading}>{uploading ? 'Reading media…' : 'Review items'}</button></>}
    </div>}
  >
    <div className="demo-shop-editor">
      {discard ? <p>Your unsaved item drafts will be discarded. Nothing has been published or sent onchain.</p> : <>
        <p className="ds-editor-notice"><strong>Local demo</strong> {review ? 'Saving adds previews on this device. There is no upload, wallet signature, or onchain transaction.' : 'Try the same item settings used by Juicebox shops. Nothing is uploaded or published.'}</p>
        {review ? <div className="ds-review-list">{items.map((item, index) => <section key={item.id} aria-label={`Review item ${index + 1}`} className="ds-review-item"><p className="ds-eyebrow">Item {index + 1}</p><ItemReview item={item} currency={currency} /></section>)}</div>
          : <form id={formId} onSubmit={submit} noValidate>
            <div className="ds-currency-field"><label htmlFor={`${formId}-currency`}>Shop currency</label><select id={`${formId}-currency`} value={currency} disabled={currencyLocked} onChange={event => setCurrency(event.target.value as DemoShopCurrency)}><option value="USD">USD</option><option value="ETH">ETH</option></select><p>{currencyLocked ? 'All items use the existing shop currency.' : 'All items in this shop use the same pricing currency.'}</p></div>
            {items.map((item, index) => <DraftEditor key={item.id} item={item} index={index} currency={currency} categories={[...new Set([...categories, ...items.map(entry => entry.category.trim()).filter(Boolean)])]} errors={errors[index]} validationAttempt={attempted} uploading={uploading === item.id} disabled={!!uploading} onUpdate={patch => update(item.id, patch)} onUpload={file => void upload(item.id, file)} onRemove={initial.mode === 'add' ? () => { setItems(current => current.filter(entry => entry.id !== item.id)); setMediaErrors(current => ({ ...current, [item.id]: '' })); setMessage('') } : undefined} onClearMediaError={() => setMediaErrors(current => ({ ...current, [item.id]: '' }))} />)}
            {initial.mode === 'add' && <button type="button" className="ds-add-row" disabled={!!uploading || items.length >= maximumItems} onClick={() => setItems(current => current.length < maximumItems ? [...current, newDemoShopItem()] : current)}><span aria-hidden="true">＋</span> Add an item</button>}
            {initial.mode === 'add' && items.length >= maximumItems && <p className="ds-help">{maximumItems === 20 ? 'Review up to 20 items at a time in this demo.' : `This demo has room for ${maximumItems} more ${maximumItems === 1 ? 'item' : 'items'}.`}</p>}
            {message && <p className="ds-error ds-error-summary" role="alert">{message}</p>}
          </form>}
      </>}
    </div>
  </ModalShell>
}

function DraftEditor({ item, index, currency, categories, errors, validationAttempt, uploading, disabled, onUpdate, onUpload, onRemove, onClearMediaError }: {
  item: DemoShopItem; index: number; currency: DemoShopCurrency; categories: string[]; errors: Record<string, string>; validationAttempt: number; uploading: boolean; disabled: boolean
  onUpdate: (patch: Partial<DemoShopItem>) => void; onUpload: (file: File | undefined) => void; onRemove?: () => void; onClearMediaError: () => void
}) {
  const id = useId()
  const [more, setMore] = useState(false)
  const [mediaMode, setMediaMode] = useState<'upload' | 'url'>(item.media?.url.startsWith('https://') ? 'url' : 'upload')
  const [urlType, setUrlType] = useState(item.media?.type ?? 'image/jpeg')
  const hasAdvancedErrors = ['category', 'splits', 'discountPct', 'reserveN', 'reserveBeneficiary', 'votingUnits'].some(key => errors[key])
  useEffect(() => { if (hasAdvancedErrors) setMore(true) }, [hasAdvancedErrors, validationAttempt])
  const field = (key: keyof DemoShopItem) => ({ id: `${id}-${key}`, 'aria-invalid': !!errors[key] || undefined, 'aria-describedby': errors[key] ? `${id}-${key}-error` : undefined })
  const error = (key: keyof DemoShopItem) => errors[key] ? <p id={`${id}-${key}-error`} className="ds-error">{errors[key]}</p> : null
  const numberField = (key: 'price' | 'supply' | 'discountPct' | 'reserveN' | 'votingUnits', label: string, placeholder: string, numeric = false) => <div className="ds-field"><label htmlFor={`${id}-${key}`}>{label}</label><input {...field(key)} type="text" inputMode={numeric ? 'numeric' : 'decimal'} value={item[key]} disabled={disabled} placeholder={placeholder} onChange={event => onUpdate({ [key]: event.target.value.slice(0, 80) })} />{error(key)}</div>

  return <fieldset className="ds-draft-item" disabled={disabled}>
    <legend>Item {index + 1}</legend>
    <div className="ds-draft-heading"><span className="ds-eyebrow">Item {index + 1}</span>{onRemove && <button type="button" className="ds-text-button" onClick={onRemove} aria-label={`Remove draft item ${index + 1}`}>Remove</button>}</div>
    <div className="ds-item-basics">
      <div className="ds-media-field">
        <MediaPreview media={item.media} />
        <label className="ds-upload-button">{uploading ? 'Reading media…' : item.media ? 'Change media' : 'Upload media'}<input type="file" aria-label={`Upload media for item ${index + 1}`} aria-invalid={!!errors.media || undefined} aria-describedby={errors.media ? `${id}-media-error` : undefined} accept="image/*,video/*,audio/*,application/pdf,text/*,.md,.markdown" disabled={disabled} onChange={event => { setMediaMode('upload'); onUpload(event.target.files?.[0]); event.target.value = '' }} /></label>
        {item.media && <button type="button" className="ds-text-button ds-small-button" onClick={() => { onUpdate({ media: null }); onClearMediaError() }}>Remove media</button>}
      </div>
      <div className="ds-basics-fields"><div className="ds-field"><label htmlFor={`${id}-name`}>Item name</label><input {...field('name')} type="text" autoComplete="off" placeholder="e.g. A night at Founder Haus" value={item.name} maxLength={100} onChange={event => onUpdate({ name: event.target.value })} />{error('name')}</div><div className="ds-field-pair">{numberField('price', `Price (${currency})`, currency === 'USD' ? '25' : '0.01')}{numberField('supply', 'Quantity', 'Unlimited', true)}</div><p className="ds-help">Leave quantity blank for unlimited inventory.</p></div>
    </div>
    <div className="ds-media-options"><button type="button" className="ds-text-button" aria-expanded={mediaMode === 'url'} aria-controls={`${id}-media-url`} onClick={() => setMediaMode(mediaMode === 'url' ? 'upload' : 'url')}>{mediaMode === 'url' ? 'Hide media URL' : 'Use a media URL'}</button><span>Images, video, audio, PDF, or text | Up to 2 MB locally</span></div>
    <div id={`${id}-media-url`} hidden={mediaMode !== 'url'} className="ds-media-url-grid"><div className="ds-field"><label htmlFor={`${id}-media`}>Media URL</label><input {...field('media')} type="url" inputMode="url" placeholder="https://…" value={item.media && !item.media.url.startsWith('data:') ? item.media.url : ''} onChange={event => { onUpdate({ media: event.target.value ? { url: event.target.value, type: urlType, name: item.name || 'Item media' } : null }); onClearMediaError() }} /></div><div className="ds-field"><label htmlFor={`${id}-media-type`}>Media type</label><select id={`${id}-media-type`} value={urlType} onChange={event => { setUrlType(event.target.value); if (item.media) onUpdate({ media: { ...item.media, type: event.target.value } }) }}><option value="image/jpeg">Image</option><option value="video/mp4">Video</option><option value="audio/mpeg">Audio</option><option value="application/pdf">PDF</option><option value="text/plain">Text</option></select></div></div>
    {error('media')}
    {errors.media && <button type="button" className="ds-text-button" onClick={() => { onUpdate({ media: null }); onClearMediaError() }}>Continue without media</button>}
    <div className="ds-field ds-description-field"><label htmlFor={`${id}-description`}>Description <span>(optional)</span></label><textarea {...field('description')} value={item.description} maxLength={1000} rows={2} placeholder="A short description of the item" onChange={event => onUpdate({ description: event.target.value })} />{error('description')}</div>
    <button type="button" className="ds-more-button" aria-expanded={more} aria-controls={`${id}-more`} onClick={() => setMore(!more)}>{more ? 'Fewer options' : 'More options'} <span aria-hidden="true">{more ? '↑' : '↓'}</span></button>
    <div id={`${id}-more`} hidden={!more} className="ds-advanced">
      <div className="ds-field"><label htmlFor={`${id}-category`}>Category</label><p className="ds-help">Group items into named shelves on your shop page.</p><input {...field('category')} type="text" value={item.category} maxLength={40} list={`${id}-categories`} placeholder="Default" onChange={event => onUpdate({ category: event.target.value })} /><datalist id={`${id}-categories`}>{categories.map(category => <option value={category} key={category} />)}</datalist>{error('category')}</div>
      <div><h4>Split sales</h4><p className="ds-help">Route a share of each item sale to other accounts or Juicebox projects.</p><SplitEditor splits={item.splits} onChange={splits => onUpdate({ splits })} error={errors.splits} errorId={`${id}-splits-error`} />{item.splits.length > 0 && item.allowCredits && <p className="ds-option-note">Credit purchases may bring in no new payment to divide. Turn off credit purchases if every sale must honor these splits.</p>}</div>
      <div><h4>Discount</h4><p className="ds-help">Start at a discount off the listed price.</p>{numberField('discountPct', 'Discount (%)', '0')}<p className="ds-help">0–100%, in steps of 0.5%.</p></div>
      <div><h4>Reserve inventory</h4><p className="ds-help">Reserve one item for a wallet as others buy. Leave the frequency blank to turn this off.</p><div className="ds-reserve-grid">{numberField('reserveN', '1 of every', 'Not reserved', true)}<div className="ds-field"><label htmlFor={`${id}-reserveBeneficiary`}>Reserve beneficiary</label><input {...field('reserveBeneficiary')} type="text" value={item.reserveBeneficiary} placeholder="0x…" autoComplete="off" onChange={event => onUpdate({ reserveBeneficiary: event.target.value })} />{error('reserveBeneficiary')}</div></div></div>
      <div><h4>Voting power</h4><p className="ds-help">Give each item a custom number of governance votes.</p>{numberField('votingUnits', 'Votes per item', '0', true)}</div>
      <div><h4>Item rules</h4><div className="ds-rule-options">{ITEM_RULES.map(rule => <label className="ds-check-row" key={rule.key}><input type="checkbox" checked={item[rule.key]} onChange={() => onUpdate({ [rule.key]: !item[rule.key] })} /><span><strong>{rule.title}</strong><span>{rule.description}</span></span></label>)}</div></div>
    </div>
  </fieldset>
}

const ITEM_RULES = [
  { key: 'allowOwnerMint', title: 'Project owner can mint for free', description: 'The owner or authorized operator can mint this item without paying.' },
  { key: 'transfersPausable', title: 'Allow rulesets to pause transfers', description: 'The active ruleset can pause transfers. Minting and burning stay available.' },
  { key: 'cantBeRemoved', title: 'Permanent', description: 'Once published onchain, this item can never be removed from the shop.' },
  { key: 'allowCredits', title: 'Allow credit purchases', description: 'Buyers can use leftover shop credits to obtain this item.' },
  { key: 'ownerCanEditDiscount', title: 'Discounts can change later', description: 'The project owner can raise or end the discount after launch.' },
] as const

function SplitEditor({ splits, onChange, error, errorId }: { splits: DemoShopSplit[]; onChange: (splits: DemoShopSplit[]) => void; error?: string; errorId: string }) {
  function change(id: string, patch: Partial<DemoShopSplit>) { onChange(splits.map(split => split.id === id ? { ...split, ...patch } : split)) }
  const total = splits.reduce((sum, split) => sum + (Number.isFinite(Number(split.percent)) ? Number(split.percent) : 0), 0)
  return <div className="ds-splits">
    {splits.map((split, index) => <div key={split.id} className="ds-split-row">
      <div className="ds-split-top"><div className="ds-field"><label>Percent<input type="text" inputMode="decimal" aria-label={`Sale split ${index + 1} percent`} aria-invalid={!!error || undefined} aria-describedby={error ? errorId : undefined} value={split.percent} placeholder="10" onChange={event => change(split.id, { percent: event.target.value.slice(0, 14) })} /></label></div><div className="ds-field"><label>Recipient type<select aria-label={`Sale split ${index + 1} recipient type`} value={split.kind} onChange={event => change(split.id, { kind: event.target.value as DemoShopSplit['kind'] })}><option value="address">Wallet</option><option value="project">Juicebox project</option></select></label></div><button type="button" className="ds-text-button" aria-label={`Remove sale split ${index + 1}`} onClick={() => onChange(splits.filter(entry => entry.id !== split.id))}>Remove</button></div>
      {split.kind === 'address' ? <div className="ds-field"><label>Recipient address<input type="text" autoComplete="off" aria-label={`Sale split ${index + 1} recipient address`} value={split.recipient} placeholder="0x…" onChange={event => change(split.id, { recipient: event.target.value })} /></label></div> : <div className="ds-field-pair"><div className="ds-field"><label>Project ID<input type="text" inputMode="numeric" aria-label={`Sale split ${index + 1} project ID`} value={split.projectId} placeholder="1" onChange={event => change(split.id, { projectId: event.target.value })} /></label></div><div className="ds-field"><label>Token beneficiary<input type="text" autoComplete="off" aria-label={`Sale split ${index + 1} token beneficiary`} value={split.beneficiary} placeholder="0x…" onChange={event => change(split.id, { beneficiary: event.target.value })} /></label></div></div>}
    </div>)}
    {error && <p id={errorId} className="ds-error">{error}</p>}
    <div className="ds-split-summary"><button type="button" className="ds-text-button" disabled={splits.length >= 20} onClick={() => onChange([...splits, { id: crypto.randomUUID(), kind: 'address', percent: '', recipient: '', projectId: '', beneficiary: '' }])}>＋ Add a recipient</button>{splits.length > 0 && <p>{Math.max(0, 100 - total).toLocaleString('en-US', { maximumFractionDigits: 7 })}% of sale proceeds stay with the project.</p>}</div>
  </div>
}

function ItemReview({ item, currency }: { item: DemoShopItem; currency: DemoShopCurrency }) {
  return <div className="ds-item-review" tabIndex={0} role="region" aria-label={`${item.name} details`}>
    <div className="ds-review-top"><MediaPreview media={item.media} large /><div><h3>{item.name}</h3>{item.description && <p className="ds-review-description">{item.description}</p>}<p className="ds-review-price">{demoShopPrice(item, currency)}</p>{Number(item.discountPct) > 0 && <p className="ds-help">Listed at {item.price} {currency} | {item.discountPct}% off</p>}</div></div>
    <dl className="ds-review-details"><div><dt>Quantity</dt><dd>{item.supply.trim() ? Number(item.supply).toLocaleString('en-US') : 'Unlimited'}</dd></div><div><dt>Category</dt><dd>{item.category || 'Default'}</dd></div><div><dt>Media</dt><dd>{item.media?.name || 'No media'}</dd></div><div><dt>Votes per item</dt><dd>{item.votingUnits.trim() || '0'}</dd></div><div><dt>Reserved inventory</dt><dd>{item.reserveN.trim() ? <>1 of every {item.reserveN} to <span className="ds-address">{item.reserveBeneficiary}</span></> : 'None'}</dd></div></dl>
    {item.splits.length > 0 && <div className="ds-review-splits"><h4>Split sales</h4><ul>{item.splits.map(split => <li key={split.id}><strong>{split.percent}%</strong><span>{split.kind === 'project' ? <>Project #{split.projectId}<small>Token beneficiary: {split.beneficiary}</small></> : split.recipient}</span></li>)}</ul><p className="ds-help">The remainder stays with the project.</p></div>}
    <div className="ds-review-rules"><h4>Item rules</h4><dl>{ITEM_RULES.map(rule => <div key={rule.key}><dt>{rule.title}</dt><dd>{item[rule.key] ? 'Yes' : 'No'}</dd></div>)}</dl></div>
  </div>
}

function MediaPreview({ media, large = false }: { media: DemoShopItem['media']; large?: boolean }) {
  const safeUrl = media && (/^https:\/\//.test(media.url) || /^data:(?:image|video|audio|text)\//.test(media.url) || /^data:application\/pdf[;,]/.test(media.url)) ? media.url : null
  const [failed, setFailed] = useState<string | null>(null)
  if (media && safeUrl && media.type.startsWith('image/') && failed !== safeUrl) {
    // Local data URLs and optional remote image previews do not use Next's image proxy.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={`ds-media-preview${large ? ' ds-media-large' : ''}`} src={safeUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(safeUrl)} />
  }
  const kind = media?.type.startsWith('image/') ? 'Image' : media?.type.startsWith('video/') ? 'Video' : media?.type.startsWith('audio/') ? 'Audio' : media?.type === 'application/pdf' ? 'PDF' : media ? 'Text' : null
  return <div className={`ds-media-preview ds-media-placeholder${large ? ' ds-media-large' : ''}`}><ShopIcon />{media ? <><strong>{failed === safeUrl ? 'Media preview unavailable' : kind}</strong><span>{media.name}</span></> : <span>No media yet</span>}</div>
}

function ShopIcon() {
  return <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 16h28l3 25H7l3-25Z" /><path d="M17 18V12a7 7 0 0 1 14 0v6M16 24c2 8 14 8 16 0" strokeLinecap="round" /></svg>
}
