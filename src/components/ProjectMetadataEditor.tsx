'use client'

import Image from 'next/image'
import { useEffect, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { isAddressEqual, type PublicClient } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { useProjectAdminTx } from '@/hooks/useProjectAdminTx'
import { ProjectAdminTransactionStatus } from '@/components/ProjectAdminTransactionStatus'
import { ModalShell } from '@/components/ui/ModalShell'
import { displayChainName } from '@/lib/chainDisplay'
import { assertNoViewAs } from '@/lib/viewAs'
import {
  buildProjectMetadataEditTx, metadataFieldLabel, projectMetadataDocument, publishEditedProjectMetadata,
  readProjectMetadataDocument, readProjectMetadataEditState, reverifyProjectMetadataEdit, validateProjectMetadataDraft,
  type MetadataField, type MetadataImageKey, type ProjectMetadataDocument, type ProjectMetadataDraft,
  type ProjectMetadataEditState, type ProjectMetadataImages,
} from '@/lib/project-metadata-edit'

const message = (error: unknown) => error instanceof Error ? error.message : 'Project details could not be updated.'
type Editing = { snapshot: ProjectMetadataEditState; document: ProjectMetadataDocument; draft: ProjectMetadataDraft }
const basicFields: MetadataField[] = ['name', 'description', 'location', 'assetType']
const planFields: MetadataField[] = ['revenueDescription', 'monthlyRent', 'monthlyCosts', 'minimumRevenue', 'minimumRevenueConsequences', 'rentGrowthPercent', 'costGrowthPercent']
const multiline = new Set<MetadataField>(['description', 'revenueDescription', 'minimumRevenueConsequences', 'ownerIntroduction', 'operatorIntroduction'])
const numeric = new Set<MetadataField>(['monthlyRent', 'monthlyCosts', 'minimumRevenue', 'rentGrowthPercent', 'costGrowthPercent'])

type ProjectMetadataEditorProps = {
  chainId: number; projectId: bigint; client?: PublicClient; unavailable?: boolean; inheritedMetadataUri?: string; label?: string
}

/** Each phase/network has its own controller URI; the review names that exact project. */
export function ProjectMetadataEditor(props: ProjectMetadataEditorProps) {
  return <ProjectMetadataEditorContent key={`${props.chainId}:${props.projectId}`} {...props} />
}

function ProjectMetadataEditorContent({ chainId, projectId, client, unavailable = false, inheritedMetadataUri, label = 'Edit project details' }: ProjectMetadataEditorProps) {
  const { address } = useWallet()
  const cache = useQueryClient()
  const id = useId()
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [editing, setEditing] = useState<Editing | null>(null)
  const [images, setImages] = useState<ProjectMetadataImages>({})
  const [review, setReview] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  function requireConfirmedBlock(state: ProjectMetadataEditState) {
    const minimum = cache.getQueryData<bigint>(['project-admin-confirmed-block', chainId, projectId.toString()])
    if (minimum !== undefined && state.blockNumber < minimum) throw new Error('The RPC is behind the last confirmed project update. Wait for it to catch up before editing.')
    return state
  }
  const tx = useProjectAdminTx({ chainId, projectId, onConfirmed: async () => {
    setEditing(null); setImages({}); setReview(false)
    await cache.invalidateQueries({ queryKey: ['project-metadata-edit', chainId, projectId.toString()] })
    await cache.invalidateQueries({ queryKey: ['fund-project-metadata'] })
  } })
  const snapshot = useQuery({
    queryKey: ['project-metadata-edit', chainId, projectId.toString(), address ?? null],
    enabled: !!client && !!address && !unavailable,
    queryFn: async () => requireConfirmedBlock(await readProjectMetadataEditState(client!, { chainId, projectId, account: address! })),
    refetchInterval: 20_000, retry: 1,
  })
  const active = snapshot.data && address && isAddressEqual(snapshot.data.account, address) ? snapshot.data : undefined
  const details = useQuery({
    queryKey: ['project-metadata-edit-document', active?.projectUri, inheritedMetadataUri ?? null],
    enabled: !!active?.canEdit && !unavailable,
    queryFn: async () => {
      const document = await readProjectMetadataDocument(active!.projectUri)
      if (!document.needsInheritance || !inheritedMetadataUri || inheritedMetadataUri === active!.projectUri) return document
      const inherited = await readProjectMetadataDocument(inheritedMetadataUri)
      return projectMetadataDocument(document.raw, inherited)
    },
    staleTime: Infinity, retry: 1,
  })
  const busy = preparing || tx.busy || tx.pending || tx.phase === 'review'
  const fieldKeys = editing?.document.supportsPlan ? [...basicFields, 'ownerName', 'ownerIntroduction', 'ownerWallet', 'operatorName', 'operatorIntroduction', 'operatorWallet', ...planFields] as MetadataField[] : ['name', 'description'] as MetadataField[]

  function open() {
    if (!active?.canEdit || !details.data || busy || unavailable) return
    setEditing({ snapshot: active, document: details.data, draft: { ...details.data.draft } })
    setImages({}); setReview(false); setError(null)
  }
  function reviewDetails() {
    if (!editing) return
    try {
      const draft = validateProjectMetadataDraft(editing.document, editing.draft, images)
      setEditing({ ...editing, draft }); setReview(true); setError(null)
    } catch (reason) { setError(message(reason)) }
  }
  async function publish() {
    if (!editing || !review || !client || !address || busy || inFlight.current || unavailable || !tx.ready) return
    inFlight.current = true; setPreparing(true); setError(null)
    try {
      assertNoViewAs()
      requireConfirmedBlock(await reverifyProjectMetadataEdit(client, editing.snapshot, address))
      if (!mounted.current) return
      const pinned = await publishEditedProjectMetadata(editing.document, editing.draft, images)
      if (!mounted.current) return
      const request = buildProjectMetadataEditTx(editing.snapshot, pinned.uri)
      await tx.send(request, {
        reviewNotice: `Update the published details for project #${projectId} on ${displayChainName(chainId)}. Other phases and networks have separate project details. The published operating plan describes expectations; this transaction does not transfer ownership, change payment splits, or change contract terms.`,
        reverify: async () => {
          if (!mounted.current) throw new Error('The details editor has closed. Reopen it to review this update.')
          requireConfirmedBlock(await reverifyProjectMetadataEdit(client, editing.snapshot, address))
        },
      })
    } catch (reason) { setError(message(reason)) } finally { inFlight.current = false; setPreparing(false) }
  }
  const field = (key: MetadataField) => {
    if (!editing) return null
    const props = { id: `${id}-${key}`, value: editing.draft[key], disabled: busy, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setEditing({ ...editing, draft: { ...editing.draft, [key]: event.target.value } }); setError(null) } }
    return <div className="ds-field" key={key}><label htmlFor={props.id}>{metadataFieldLabel(key)}</label>{multiline.has(key) ? <textarea {...props} rows={3} /> : <input {...props} type="text" inputMode={numeric.has(key) ? 'decimal' : 'text'} autoComplete="off" />}</div>
  }
  const photo = (key: MetadataImageKey, title: string) => editing && <MetadataImageInput key={key} id={`${id}-${key}-image`} label={title} existing={editing.document.images[key]} value={images[key]} disabled={busy} onChange={value => { setImages(current => ({ ...current, [key]: value })); setError(null) }} />

  return <div className="grid gap-3">
    {active?.canEdit && <button type="button" className="btn-secondary min-h-11 px-4 py-2 justify-self-start" disabled={!details.data || unavailable || !tx.ready || busy} onClick={open}>{label}</button>}
    {active?.canEdit && details.isPending && <p className="text-sm" role="status">Loading the published details for editing…</p>}
    {active?.canEdit && details.isError && <p className="text-sm" role="alert">{message(details.error)} <button type="button" className="underline" onClick={() => void details.refetch()}>Retry details</button></p>}
    {address && snapshot.isError && <p className="text-sm" role="alert">{message(snapshot.error)} <button type="button" className="underline" onClick={() => void snapshot.refetch()}>Retry permissions</button></p>}
    <ProjectAdminTransactionStatus tx={tx} />
    {editing && <ModalShell title={review ? 'Review project details' : label} subtitle={`Project #${projectId} on ${displayChainName(chainId)}`} busy={preparing || (tx.busy && !tx.pending) || tx.phase === 'review'} onClose={() => { setEditing(null); setError(null) }} maxWidth="max-w-3xl" footer={<div className="flex flex-wrap justify-end gap-3">
      {review ? <><button type="button" className="btn-secondary min-h-11 px-4 py-2" disabled={busy} onClick={() => setReview(false)}>Back to details</button><button type="button" className="btn-primary min-h-11 px-4 py-2" disabled={busy || !tx.ready || unavailable} onClick={() => void publish()}>{preparing ? 'Publishing reviewed details…' : tx.pending ? 'Waiting for confirmation…' : 'Publish changes'}</button></> : <><button type="button" className="btn-secondary min-h-11 px-4 py-2" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="btn-primary min-h-11 px-4 py-2" form={`${id}-form`}>Review changes</button></>}
    </div>}>
      <div className="demo-shop-editor grid gap-6">
        <p className="text-sm">These details apply to this phase on {displayChainName(chainId)}. Other phases and networks keep their own published details.</p>
        {review ? <>
          <dl className="grid gap-4">{fieldKeys.map(key => <div key={key}><dt className="font-medium">{metadataFieldLabel(key)}</dt><dd className="whitespace-pre-line break-words">{editing.draft[key] || 'Not specified'}</dd></div>)}</dl>
          <dl className="grid gap-3 sm:grid-cols-2">{(['cover', 'logo', ...(editing.document.supportsPlan ? ['owner', 'operator'] : [])] as MetadataImageKey[]).map(key => <div key={key}><dt className="capitalize">{key} image</dt><dd>{images[key]?.remove ? 'Remove image' : <><MetadataImagePreview label={`${key} image`} file={images[key]?.file} existing={editing.document.images[key]} />{images[key]?.file ? `Upload ${images[key]!.file!.name}` : editing.document.images[key] ? 'Keep current image' : 'No image'}</>}</dd></div>)}</dl>
          <p className="text-sm">Profile addresses describe the people shown here. Ownership and payment recipients are managed separately under Owner and Operator controls. Operating estimates and minimum revenue describe the plan and do not trigger contract changes.</p>
        </> : <form id={`${id}-form`} className="grid gap-7" onSubmit={event => { event.preventDefault(); reviewDetails() }} noValidate>
          <fieldset className="grid gap-4"><legend className="mb-4 text-xl">Project details</legend>{basicFields.filter(key => editing.document.supportsPlan || key === 'name' || key === 'description').map(field)}<div className="grid gap-5 sm:grid-cols-2">{photo('cover', 'Cover image')}{photo('logo', 'Project logo')}</div></fieldset>
          {editing.document.supportsPlan && <>
            <fieldset className="grid gap-4"><legend className="mb-4 text-xl">Ownership</legend>{field('ownerName')}{field('ownerIntroduction')}{field('ownerWallet')}<p className="text-sm">Associate this introduction with the Owner’s address. Transfer ownership under Owner controls.</p>{photo('owner', 'Owner photo')}</fieldset>
            <fieldset className="grid gap-4"><legend className="mb-4 text-xl">Operator</legend>{field('operatorName')}{field('operatorIntroduction')}{field('operatorWallet')}<p className="text-sm">Associate this introduction with the Operator’s address. Change the paid Operator under Operator controls.</p>{photo('operator', 'Operator photo')}</fieldset>
            <fieldset className="grid gap-4"><legend className="mb-4 text-xl">Published operating plan</legend><p className="text-sm">Amounts are in USD. These estimates describe the plan; they do not change contract terms or automatically enforce a minimum revenue.</p>{planFields.map(field)}</fieldset>
          </>}
        </form>}
        {error && <p role="alert" className="text-sm">{error}</p>}
        <ProjectAdminTransactionStatus tx={tx} />
      </div>
    </ModalShell>}
  </div>
}

function MetadataImageInput({ id, label, existing, value, disabled, onChange }: {
  id: string; label: string; existing: string | null; value?: { file?: File; remove?: boolean }; disabled: boolean; onChange: (value: { file?: File; remove?: boolean }) => void
}) {
  return <div className="ds-field"><label htmlFor={id}>{label}</label>{!value?.remove && <MetadataImagePreview label={label} existing={existing} file={value?.file} />}
    <input id={id} type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled} onChange={event => { const file = event.target.files?.[0]; if (file) onChange({ file }); event.target.value = '' }} />
    <p className="text-sm">{value?.remove ? 'Image will be removed.' : value?.file ? value.file.name : 'JPEG, PNG, or WebP, up to 25 MB.'}</p>
    {(existing || value?.file) && !value?.remove && <button type="button" className="underline justify-self-start" disabled={disabled} onClick={() => onChange({ remove: true })}>Remove {label.toLowerCase()}</button>}
    {(value?.remove || value?.file) && <button type="button" className="underline justify-self-start" disabled={disabled} onClick={() => onChange({})}>Keep original {label.toLowerCase()}</button>}
  </div>
}

function MetadataImagePreview({ label, existing, file }: { label: string; existing: string | null; file?: File }) {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null)
  useEffect(() => {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 25 * 1024 * 1024) return
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') setPreview({ file, url: reader.result }) }
    reader.readAsDataURL(file)
    return () => { reader.onload = null; if (reader.readyState === FileReader.LOADING) reader.abort() }
  }, [file])
  const src = file ? preview?.file === file ? preview.url : null : existing
  return src ? <Image src={src} alt={`${file ? 'New' : 'Current'} ${label.toLowerCase()}`} width={160} height={120} className="max-h-32 w-auto rounded object-cover" unoptimized /> : null
}
