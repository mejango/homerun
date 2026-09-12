'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import Image from 'next/image';
import { CREATE_DEFAULTS, CREATE_DRAFT_KEY, normalizeCreateDraft, creationSummary, deploymentDraft } from '../../web/create-model.mjs';
import { NETWORK_FAMILIES } from '../../web/create-networks.mjs';
import { drawAssetSketch } from '../../web/asset-sketch.mjs';
import { CreateIncomePreview } from './CreateIncomePreview';
import { SiteIntegration } from './SiteIntegration';
import { OperatorProfile } from './OperatorProfile';

/** Validated setup values. Budget and income estimates remain modeling assumptions. */
export interface CreateValues {
  name: string;
  assetType: string;
  location: string;
  description: string;
  revenueDescription: string;
  minimumRevenue: number;
  minimumRevenueConsequences: string;
  purchaseBudget: number;
  opsReserve: number;
  monthlyRent: number;
  monthlyCosts: number;
  rentGrowthPercent: number;
  costGrowthPercent: number;
  /** Legacy draft key for the Owner’s FUND success allocation. */
  operatorFundPercent: number;
  operatorSplitPercent: number;
  /** Ongoing INCOME allocation for eligible FUND stakers using Sticky. */
  stickySplitPercent: number;
  networks: string[];
  networkEnvironment: 'production' | 'testnet';
  revnetOperatorEnabled: boolean;
  ownerWallet: string;
  operatorWallet: string;
  operatorName?: string;
  operatorIntroduction?: string;
  operatorPhoto?: string;
  photo: string;
}

type FieldName = keyof CreateValues;
type RawValues = Record<FieldName, string | number | boolean | readonly string[]>;
type Errors = Partial<Record<FieldName | 'form', string>>;
type Normalized = { valid: boolean; errors: Errors; values: CreateValues };
type Summary = { values: CreateValues; networkInputs: Record<string, unknown>; raiseGoal: number; customerSplitPercent: number; investorFundPercent: number };
export interface CreateFlowProps {
  /** Supply the live FUND creation controls from a client component. */
  renderDeploy?: (values: CreateValues) => ReactNode;
  renderIntegration?: (values: CreateValues) => ReactNode;
}

const labels = ['The asset', 'Fundraise', 'Income', 'Review & create'];
const groups: FieldName[][] = [
  ['name', 'assetType', 'location', 'description', 'photo', 'ownerWallet', 'operatorWallet', 'operatorName', 'operatorIntroduction', 'operatorPhoto'],
  ['purchaseBudget', 'opsReserve', 'operatorFundPercent'],
  ['revenueDescription', 'minimumRevenue', 'minimumRevenueConsequences', 'monthlyRent', 'monthlyCosts', 'rentGrowthPercent', 'costGrowthPercent', 'operatorSplitPercent', 'stickySplitPercent'],
  ['networks', 'networkEnvironment', 'revnetOperatorEnabled'],
];
const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
const number = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const normalize = (raw: RawValues): Normalized => normalizeCreateDraft(raw) as unknown as Normalized;
const initialValues = (): RawValues => ({ ...CREATE_DEFAULTS, networks: [...CREATE_DEFAULTS.networks] }) as RawValues;

type FieldProps = {
  name: FieldName; label: string; value: string | number | boolean | readonly string[]; error?: string;
  onChange: (name: FieldName, value: string) => void;
  onBlur?: (name: FieldName) => void;
  prefix?: string; suffix?: string; help?: string; placeholder?: string; maxLength?: number; rows?: number;
};

function Field({ name, label, value, error, onChange, onBlur, prefix, suffix, help, placeholder, maxLength, rows }: FieldProps) {
  const id = `create-${name}`;
  const displayed = typeof value === 'number' ? number(value) : String(value ?? '');
  const numeric = [...groups[1], ...groups[2]].includes(name) && !['revenueDescription', 'minimumRevenueConsequences'].includes(name);
  const common = { id, name, value: displayed, maxLength, placeholder, 'aria-invalid': Boolean(error),
    'aria-describedby': [help && `${name}-help`, error && `${name}-error`].filter(Boolean).join(' ') || undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(name, event.target.value),
    onBlur: () => onBlur?.(name) };
  return <div className="create-field">
    <label htmlFor={id}>{label}</label>
    <div className="create-input">
      {prefix && <span aria-hidden="true">{prefix}</span>}
      {rows ? <textarea {...common} rows={rows} /> : <input {...common} type="text" inputMode={numeric ? 'decimal' : undefined} autoComplete="off" />}
      {suffix && <span aria-hidden="true">{suffix}</span>}
    </div>
    {help && <p className="create-help" id={`${name}-help`}>{help}</p>}
    {error && <p className="create-error" id={`${name}-error`}>{error}</p>}
  </div>;
}

function AssetArt({ type, photo }: { type: string; photo: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (photo || !canvas.current) return;
    const element = canvas.current;
    const paint = () => drawAssetSketch(element, type);
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(element);
    return () => observer.disconnect();
  }, [type, photo]);
  return <div className="asset-art">{photo
    ? <Image id="draft-photo" src={photo} alt="Your asset cover photo" width={320} height={160} unoptimized />
    : <canvas id="asset-sketch" ref={canvas} aria-hidden="true" />}</div>;
}

function IncomeSplit({ summary }: { summary: Summary | null }) {
  if (!summary) return <p className="create-note">Enter valid allocation percentages to preview new tokens.</p>;
  const parts = [
    { label: 'Operators', share: summary.values.operatorSplitPercent, color: '#42674d' },
    { label: 'FUND stakers', share: summary.values.stickySplitPercent, color: '#b1bd91' },
    { label: 'Customers', share: summary.customerSplitPercent, color: '#b58e66' },
  ];
  const active = parts.filter(part => part.share > 0);
  const empty = parts.filter(part => part.share === 0);
  return <div id="create-income-split" className="create-split" aria-live="polite">
    <div className={`create-split-content${active.some(part => part.share < 8) ? ' is-narrow' : ''}`}>
      <div className="create-split-bar" aria-hidden="true">{active.map(part => <span key={part.label} style={{ flex: part.share, background: part.color }} />)}</div>
      <ul style={{ gridTemplateColumns: active.map(part => `${part.share}fr`).join(' ') }}>
        {active.map(part => <li key={part.label} style={{ '--share': `${part.share}%`, '--split-color': part.color } as CSSProperties}>
          <strong>{number(part.share)}%</strong><span>{part.label}</span>
        </li>)}
      </ul>
      {empty.length > 0 && <p className="zero-shares">{empty.map(part => `0% ${part.label}`).join(' | ')}</p>}
    </div>
  </div>;
}

export default function CreateFlow({ renderDeploy, renderIntegration }: CreateFlowProps) {
  const [raw, setRaw] = useState<RawValues>(initialValues);
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [errors, setErrors] = useState<Errors>({});
  const [hydrated, setHydrated] = useState(false);
  const [storageNotice, setStorageNotice] = useState('');
  const [photoBusy, setPhotoBusy] = useState({ photo: false, operatorPhoto: false });
  const heading = useRef<HTMLHeadingElement>(null);
  const photoRequest = useRef({ photo: 0, operatorPhoto: 0 });
  const photoInput = useRef<HTMLInputElement>(null);
  const operatorPhotoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const requests = photoRequest.current;
    try {
      const saved = JSON.parse(localStorage.getItem(CREATE_DRAFT_KEY) || 'null');
      if (saved?.raw && typeof saved.raw === 'object' && !Array.isArray(saved.raw)) {
        const next = initialValues();
        for (const key of Object.keys(CREATE_DEFAULTS) as FieldName[]) {
          if (Object.hasOwn(saved.raw, key)) next[key] = saved.raw[key];
        }
        if (!Object.hasOwn(saved.raw, 'ownerWallet')) next.ownerWallet = typeof saved.raw.operatorWallet === 'string' ? saved.raw.operatorWallet : '';
        if (!Object.hasOwn(saved.raw, 'networks') && typeof saved.raw.network === 'string') next.networks = [saved.raw.network];
        if (!Array.isArray(next.networks)) next.networks = [...CREATE_DEFAULTS.networks];
        if (!['production', 'testnet'].includes(String(next.networkEnvironment))) next.networkEnvironment = 'production';
        if (((saved.incomeDefaultsVersion ?? 0) < 2 && [[75, 15], [81, 6]].some(([operators, holders]) => Number(next.operatorSplitPercent) === operators && Number(next.stickySplitPercent) === holders))
          || ((saved.incomeDefaultsVersion ?? 0) < 3 && Number(next.operatorSplitPercent) === 68 && Number(next.stickySplitPercent) === 13)) {
          next.operatorSplitPercent = CREATE_DEFAULTS.operatorSplitPercent;
          next.stickySplitPercent = CREATE_DEFAULTS.stickySplitPercent;
        }
        if (next.name === 'Untitled Homerun') next.name = 'Untitled';
        next.revnetOperatorEnabled = true;
        setRaw(next);
        const savedStep = Number.isInteger(saved.step) ? Math.min(3, Math.max(0, saved.step)) : 0;
        setStep(savedStep);
        setFurthest(savedStep);
      }
    } catch { setStorageNotice('Draft saving is unavailable. Keep this tab open while you work.'); }
    setHydrated(true);
    return () => { requests.photo += 1; requests.operatorPhoto += 1; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify({ raw, step, incomeDefaultsVersion: 3 }));
      setStorageNotice('Draft saved in this browser');
    } catch { setStorageNotice('Unable to save this draft. Keep this tab open while you work.'); }
  }, [raw, step, hydrated]);

  const normalized = useMemo(() => normalize(raw), [raw]);
  const summary = useMemo(() => {
    try { return creationSummary({ ...raw, name: String(raw.name || '').trim() || 'Untitled' }) as unknown as Summary; }
    catch { return null; }
  }, [raw]);
  const photo = normalized.errors.photo ? '' : normalized.values.photo;
  const operatorPhoto = normalized.errors.operatorPhoto ? '' : normalized.values.operatorPhoto;

  function update(name: FieldName, value: RawValues[FieldName]) {
    setRaw(previous => ({ ...previous, [name]: value }));
    setErrors(previous => ({ ...previous, [name]: undefined, form: undefined }));
  }

  function navigate(index: number) {
    setStep(index);
    setFurthest(previous => Math.max(previous, index));
    requestAnimationFrame(() => heading.current?.focus());
  }

  function validateStep() {
    const next = { ...raw };
    for (const key of groups[step]) {
      if (typeof next[key] === 'string' && !String(next[key]).trim()) {
        const fallback = key === 'name' ? 'Untitled' : CREATE_DEFAULTS[key];
        if (fallback !== '') next[key] = fallback;
      }
    }
    const result = normalize(next);
    const invalid = groups[step].filter(key => result.errors[key]);
    setRaw(next);
    setErrors(result.errors);
    if (invalid.length) {
      document.getElementById(`create-${invalid[0]}`)?.focus();
      return false;
    }
    return true;
  }

  function continueStep() {
    if (validateStep() && step < 3) navigate(step + 1);
  }

  function formatField(name: FieldName) {
    if (![...groups[1], ...groups[2]].includes(name) || ['revenueDescription', 'minimumRevenueConsequences'].includes(name)) return;
    const result = normalize(raw);
    if (!result.errors[name]) update(name, number(result.values[name] as number));
  }

  async function choosePhoto(name: 'photo' | 'operatorPhoto', file: File | undefined) {
    if (!file) return;
    const request = ++photoRequest.current[name];
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setErrors(previous => ({ ...previous, [name]: 'Choose a JPG, PNG or WebP image up to 8 MB.' }));
      setPhotoBusy(previous => ({ ...previous, [name]: false }));
      return;
    }
    setPhotoBusy(previous => ({ ...previous, [name]: true }));
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, (name === 'operatorPhoto' ? 800 : 1400) / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) { bitmap.close(); throw new Error('Image processing is unavailable.'); }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const data = canvas.toDataURL('image/jpeg', 0.82);
      const checked = normalize({ ...raw, [name]: data });
      if (checked.errors[name]) throw new Error(checked.errors[name]);
      if (request === photoRequest.current[name]) update(name, data);
    } catch (error) {
      if (request === photoRequest.current[name]) setErrors(previous => ({ ...previous, [name]: error instanceof Error ? error.message : 'This image could not be read.' }));
    } finally { if (request === photoRequest.current[name]) setPhotoBusy(previous => ({ ...previous, [name]: false })); }
  }

  function removePhoto(name: 'photo' | 'operatorPhoto') {
    photoRequest.current[name] += 1;
    update(name, '');
    setPhotoBusy(previous => ({ ...previous, [name]: false }));
    const input = name === 'photo' ? photoInput.current : operatorPhotoInput.current;
    if (input) input.value = '';
  }

  function downloadDraft() {
    if (!summary) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(deploymentDraft(summary.values), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'homerun-setup-draft.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function reset() {
    photoRequest.current.photo += 1;
    photoRequest.current.operatorPhoto += 1;
    setPhotoBusy({ photo: false, operatorPhoto: false });
    setRaw(initialValues());
    setErrors({});
    setFurthest(0);
    navigate(0);
    if (photoInput.current) photoInput.current.value = '';
    if (operatorPhotoInput.current) operatorPhotoInput.current.value = '';
  }

  const field = (name: FieldName, label: string, props: Partial<FieldProps> = {}) =>
    <Field name={name} label={label} value={raw[name]} error={errors[name] || (step === 3 ? normalized.errors[name] : undefined)} onChange={update} onBlur={formatField} {...props} />;

  return <>
    <div className="create-intro"><h1>Design the rules</h1></div>
    <div id="create-workspace" className="create-workspace">
      <section className="create-editor" aria-label="Design the rules">
        <nav className="create-steps" aria-label="Setup steps">
          {labels.map((label, index) => <button key={label} type="button" data-create-step={index}
            disabled={index > furthest || photoBusy.photo || photoBusy.operatorPhoto} aria-current={index === step ? 'step' : undefined}
            data-complete={index < step} onClick={() => { if (index <= step || validateStep()) navigate(index); }}><span>{index + 1}</span>{label}</button>)}
        </nav>
        <form id="create-form" noValidate onSubmit={event => { event.preventDefault(); continueStep(); }}>
          <section className="create-step" data-step-panel={step} aria-labelledby={`step-title-${step}`}>
            <h2 id={`step-title-${step}`} tabIndex={-1} ref={heading}>{['Asset', 'Fundraise', 'Income', 'Review'][step]}</h2>
            {step === 0 && <>
              {field('name', 'Title', { placeholder: 'e.g. Neighborhood Workshop', maxLength: 60 })}
              <div className="create-pair">
                <div className="create-field"><label htmlFor="create-assetType">Asset type</label>
                  <select id="create-assetType" name="assetType" value={String(raw.assetType)} onChange={event => update('assetType', event.target.value)} aria-invalid={Boolean(errors.assetType)}>
                    <option value="real-estate">Real estate</option><option value="business">Business</option><option value="equipment">Equipment</option><option value="energy">Energy</option><option value="other">Other asset</option>
                  </select>{errors.assetType && <p className="create-error">{errors.assetType}</p>}
                </div>
                {field('location', 'Location (optional)', { placeholder: 'City, region', maxLength: 100 })}
              </div>
              {field('description', 'The idea (optional)', { rows: 3, maxLength: 600, help: 'A short introduction to the asset and how it earns income.' })}
              <div className="create-field"><label htmlFor="create-photo">Cover photo (optional)</label>
                <label className="photo-picker" htmlFor="create-photo"><span aria-hidden="true">＋</span><span>{photoBusy.photo ? 'Preparing photo…' : 'Choose a photo'}<small>JPG, PNG or WebP | up to 8 MB</small></span>
                  <input id="create-photo" ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" aria-describedby={errors.photo ? 'photo-error' : undefined} onChange={event => { void choosePhoto('photo', event.target.files?.[0]); }} />
                </label>
                {photo && <button id="remove-photo" className="quiet-button" type="button" onClick={() => removePhoto('photo')}>Remove photo</button>}
                {errors.photo && <p className="create-error" id="photo-error">{errors.photo}</p>}
              </div>
              <fieldset className="create-operator-profile"><legend>Owner</legend>
                {field('ownerWallet', 'Owner wallet', { placeholder: '0x…', help: 'Owns the FUND Juicebox, receives its success allocation, and controls the INCOME revnet. The Owner can change the Operator and all INCOME splits at any time.' })}
              </fieldset>
              <fieldset className="create-operator-profile"><legend>Operator</legend>
                {field('operatorWallet', 'Operator wallet', { placeholder: '0x…', help: 'Receives the INCOME token split. The Owner can replace this recipient; receiving INCOME does not grant program control.' })}
                <p className="create-help">Introduce the person or team running this project.</p>
                {field('operatorName', 'Name (optional)', { placeholder: 'Your name or team', maxLength: 80 })}
                {field('operatorIntroduction', 'Introduction (optional)', { rows: 4, maxLength: 1200, placeholder: 'Tell people about yourself, your experience, and your plans for the project.' })}
                <div className="create-field"><label htmlFor="create-operatorPhoto">Operator picture (optional)</label>
                  <label className="photo-picker" htmlFor="create-operatorPhoto"><span aria-hidden="true">＋</span><span>{photoBusy.operatorPhoto ? 'Preparing picture…' : 'Choose a picture'}<small>JPG, PNG or WebP | up to 8 MB</small></span>
                    <input id="create-operatorPhoto" ref={operatorPhotoInput} type="file" accept="image/jpeg,image/png,image/webp" aria-describedby={errors.operatorPhoto ? 'operatorPhoto-error' : undefined} onChange={event => { void choosePhoto('operatorPhoto', event.target.files?.[0]); }} />
                  </label>
                  {operatorPhoto && <><Image unoptimized src={operatorPhoto} alt="Your operator picture" width={96} height={96} className="create-operator-photo-preview" /><button id="remove-operator-photo" className="quiet-button" type="button" onClick={() => removePhoto('operatorPhoto')}>Remove picture</button></>}
                  {errors.operatorPhoto && <p className="create-error" id="operatorPhoto-error">{errors.operatorPhoto}</p>}
                </div>
              </fieldset>
            </>}
            {step === 1 && <>
              <div className="fundraise-inputs">
                <fieldset className="income-field-group modeling-inputs fundraise-modeling" aria-describedby="fundraise-modeling-note"><legend>Modeling inputs</legend>
                  <p id="fundraise-modeling-note" className="input-purpose-note">Budget assumptions for the raise goal. These do not set contract withdrawal allowances.</p>
                  <div className="income-inputs">{field('purchaseBudget', 'Asset price', { prefix: '$' })}{field('opsReserve', 'Cash reserve', { prefix: '$', help: 'Cash set aside to cover operating expenses.' })}</div>
                </fieldset>
                <fieldset className="income-field-group fundraise-contract"><legend>Contractual settings</legend>
                  {field('operatorFundPercent', 'Owner FUND ownership', { suffix: '%', help: 'Allocated to the Owner after a successful purchase. The Owner may distribute these tokens to the Operator at their discretion.' })}
                </fieldset>
                <div className="create-callout fundraise-goal"><span>Total fundraising goal</span><strong id="create-raise-goal">{summary ? money(summary.raiseGoal) : '—'}</strong>
                  <p id="create-fee-note">{summary ? `Includes ${money(summary.values.purchaseBudget)} for the asset, ${money(summary.values.opsReserve)} in reserve, and ${money(Math.round((summary.raiseGoal - summary.values.purchaseBudget - summary.values.opsReserve) * 100) / 100)} in assumed payout fees.` : 'Complete the asset and funding inputs to calculate the goal.'}</p>
                </div>
                <div className="create-callout fundraise-ownership"><span>FUND ownership after purchase</span>
                  <div id="create-fund-pie" className="fund-ownership-pie" role="img"
                    style={{ background: summary ? `conic-gradient(#42674d ${summary.values.operatorFundPercent}%, #b1bd91 0)` : '#dfe5d5' }}
                    aria-label={summary ? `Owner ${number(summary.values.operatorFundPercent)}%, contributors ${number(summary.investorFundPercent)}%.` : 'Enter valid funding inputs to preview FUND ownership.'}>
                    <strong id="create-fund-share" aria-hidden="true">{summary ? `${number(summary.values.operatorFundPercent)}%` : '—'}</strong>
                  </div>
                  <dl className="fund-ownership-legend"><div><dt><i className="fund-operator-swatch" aria-hidden="true" />Owner</dt><dd id="fund-operator-percent">{summary ? `${number(summary.values.operatorFundPercent)}%` : '—'}</dd></div>
                    <div><dt><i className="fund-contributor-swatch" aria-hidden="true" />Contributors</dt><dd id="fund-contributor-percent">{summary ? `${number(summary.investorFundPercent)}%` : '—'}</dd></div></dl>
                </div>
              </div>
              <p className="create-note">Contributors receive FUND. If the purchase succeeds, FUND represents a share of net asset-sale proceeds. A failed raise returns the remaining funds.</p>
            </>}
            {step === 2 && <>
              <fieldset className="income-field-group modeling-inputs" aria-describedby="modeling-inputs-note"><legend>Modeling inputs</legend>
                <p id="modeling-inputs-note" className="input-purpose-note">Revenue and expense assumptions for the projections. These do not set contract terms.</p>
                <div className="income-inputs">
                  {field('monthlyRent', 'Expected monthly revenue', { prefix: '$' })}{field('monthlyCosts', 'Expected monthly expenses', { prefix: '$' })}
                  {field('rentGrowthPercent', 'Target revenue growth rate (%)', { suffix: '%', help: 'Per year.' })}{field('costGrowthPercent', 'Target expense growth rate (%)', { suffix: '%', help: 'Per year.' })}
                </div>
              </fieldset>
              <fieldset className="income-field-group"><legend>Contractual settings</legend><p className="input-purpose-note">Sets how each new batch of INCOME tokens is initially shared. The Owner can change all split recipients and allocations; no split is locked. The FUND-staker allocation goes to eligible Sticky participants.</p>
                <div className="income-inputs">{field('operatorSplitPercent', 'To operators', { suffix: '%' })}{field('stickySplitPercent', 'To FUND stakers', { suffix: '%' })}</div>
              </fieldset>
              <section className="income-preview-panel" aria-labelledby="income-preview-heading"><header><h3 id="income-preview-heading">Income preview</h3><p>Based on your inputs. Move the timeline to explore ownership.</p></header>
                <h4 className="income-chart-heading">New tokens per revenue payment</h4><IncomeSplit summary={summary} />
                <p className="create-note">Customers receive the remaining new tokens. INCOME holders can cash out or borrow.</p>
                <CreateIncomePreview inputs={summary?.networkInputs || null} />
              </section>
              {field('revenueDescription', 'How will it earn revenue? (optional)', { rows: 3, maxLength: 1000, placeholder: 'Describe what customers will pay for.' })}
              <fieldset className="income-field-group"><legend>Minimum revenue</legend>
                {field('minimumRevenue', 'Minimum monthly revenue', { prefix: '$', help: 'The monthly revenue threshold for this plan. Set to 0 for no minimum.' })}
                {field('minimumRevenueConsequences', 'What happens if revenue falls below the minimum?', { rows: 4, maxLength: 2000, placeholder: 'Describe the review period, actions the Owner will take, and how contributors will be informed.', help: 'Published with the income plan. The Owner must carry out these actions; this field does not trigger automatic contract changes.' })}
              </fieldset>
              <details className="create-terms"><summary>Starting token terms</summary><p>At purchase, 500,000 initial INCOME is allocated across all FUND holders, including inactive ERC20 balances and unclaimed token credits. Claiming this initial allocation requires no activation, staking or vesting. Revenue starts by issuing 10 INCOME per USDC, shared using the percentages above. Issuance falls 5% each quarter for two years.</p><p>Ongoing FUND rewards use stock Sticky: rewards follow your share balance at each snapshot and unlock in four weekly vesting rounds after you start the reward claim. There is no minimum staking period or stake-age bonus. Staying staked longer earns additional reward rounds. Live use requires a verified deployment. Borrowing or cashing out INCOME does not sell FUND.</p></details>
            </>}
            {step === 3 && <>
              <div id="create-review">
                <section className="review-block"><div><h3>{String(raw.name || 'Untitled')}</h3><button type="button" onClick={() => navigate(0)}>Edit asset</button></div>
                  <p>{String(raw.location || 'Location not specified')}</p>{raw.description && <p>{String(raw.description)}</p>}
                </section>
                <section className="review-block"><div><h3>Owner &amp; Operator</h3><button type="button" onClick={() => navigate(0)}>Edit wallets</button></div>
                  <dl><div><dt>Owner · program control and FUND allocation</dt><dd className="break-all">{normalized.values.ownerWallet || 'Not specified'}</dd></div>
                    <div><dt>Operator · INCOME incentives</dt><dd className="break-all">{normalized.values.operatorWallet || 'Not specified'}</dd></div></dl>
                </section>
                <section className="review-block"><div><h3>Minimum revenue</h3><button type="button" onClick={() => navigate(2)}>Edit income</button></div>
                  <p>{normalized.values.minimumRevenue ? `${money(normalized.values.minimumRevenue)} per month` : 'No minimum specified'}</p>
                  {normalized.values.minimumRevenueConsequences && <p className="whitespace-pre-line">{normalized.values.minimumRevenueConsequences}</p>}
                </section>
                {(normalized.values.operatorName || normalized.values.operatorIntroduction || operatorPhoto) && <section className="review-block"><div><h3>Operator</h3><button type="button" onClick={() => navigate(0)}>Edit operator</button></div>
                  <OperatorProfile name={normalized.values.operatorName} introduction={normalized.values.operatorIntroduction} photoUrl={operatorPhoto} showHeading={false} />
                </section>}
                <section className="review-block"><div><h3>The raise</h3><button type="button" onClick={() => navigate(1)}>Edit raise</button></div>
                  <dl><div><dt>Goal</dt><dd>{summary ? money(summary.raiseGoal) : '—'}</dd></div>
                    <div><dt>FUND ownership after purchase</dt><dd>{summary ? `${number(summary.investorFundPercent)}% contributors / ${number(summary.values.operatorFundPercent)}% Owner` : '—'}</dd></div></dl>
                </section>
              </div>
              <fieldset className="create-network-settings"><legend>Networks</legend><div className="create-network-options">
                <select id="create-networkEnvironment" className="network-environments" aria-label="Network environment" value={String(raw.networkEnvironment)}
                  onChange={event => { update('networkEnvironment', event.target.value); update('networks', NETWORK_FAMILIES.map(family => family.id)); }}>
                  <option value="production">Mainnets</option><option value="testnet">Testnets</option>
                </select>
                <div id="create-networks" className="network-symbols" role="group" aria-label="Deployment networks" aria-describedby={normalized.errors.networks ? 'networks-error' : undefined}>
                  {NETWORK_FAMILIES.map(family => {
                    const chain = family[raw.networkEnvironment === 'testnet' ? 'testnet' : 'production'];
                    const networks = Array.isArray(raw.networks) ? raw.networks : [];
                    const selected = networks.includes(family.id);
                    return <button key={family.id} type="button" data-network={family.id} title={chain.name} aria-label={chain.name} aria-pressed={selected}
                      onClick={() => update('networks', selected ? networks.filter(id => id !== family.id) : [...networks, family.id])}>
                      <Image src={family.icon} alt="" width={26} height={26} unoptimized />
                    </button>;
                  })}
                </div>
              </div>{normalized.errors.networks && <p className="create-error" id="networks-error">{normalized.errors.networks}</p>}</fieldset>

              <details className="create-terms"><summary>What creation sets up</summary><p>Creation deploys the initial FUND fundraising Juicebox. INCOME is deployed separately after a successful purchase. Review the network, contract settings, and wallet transaction before signing.</p></details>
              <div id="create-contract-actions">
                {normalized.valid ? renderDeploy?.(normalized.values) : <p className="create-error" role="status">Correct the setup fields before preparing the FUND transaction.{Object.entries(normalized.errors).map(([key, error]) => <span key={key} style={{ display: 'block' }}>{error}</span>)}</p>}
              </div>
              <details className="create-terms"><summary>Keep a setup draft</summary><p>The downloadable draft contains your modeling assumptions and planned settings. It is not a deployed project or a transaction.</p><button type="button" id="download-setup" className="quiet-button" disabled={!summary} onClick={downloadDraft}>Download setup draft</button></details>
            </>}
          </section>
          {errors.form && <p id="create-form-error" className="create-error" role="alert">{errors.form}</p>}
          <div className="create-actions">{step > 0 && <button type="button" id="create-back" className="quiet-button" onClick={() => navigate(step - 1)}>← Back</button>}
            {step < 3 && <button type="submit" id="create-next" className="create-primary" disabled={photoBusy.photo || photoBusy.operatorPhoto}>Continue <span aria-hidden="true">→</span></button>}
          </div>
        </form>
        <div className="draft-status"><span id="draft-status" role="status">{storageNotice}</span><button type="button" id="start-over" className="quiet-button" onClick={reset}>Start over</button></div>
        {summary && (renderIntegration ? renderIntegration(summary.values) : <SiteIntegration configuration={deploymentDraft(summary.values)} />)}
      </section>
      <aside className="create-aside" aria-label="Your project preview"><div className="draft-preview">
        <AssetArt type={String(raw.assetType)} photo={photo} /><h2 id="draft-name">{String(raw.name || '').trim() || 'Untitled'}</h2>
        {raw.location && <p id="draft-location">{String(raw.location)}</p>}
        <dl><div><dt>Fundraising goal</dt><dd id="draft-goal">{summary ? money(summary.raiseGoal) : '—'}</dd></div><div><dt>Monthly revenue estimate</dt><dd id="draft-revenue">{summary ? money(summary.values.monthlyRent) : '—'}</dd></div></dl>
        {summary && <div id="draft-ownership" className="draft-ownership"><div className="ownership-mini" aria-hidden="true"><span style={{ width: `${summary.investorFundPercent}%` }} /></div><p>{number(summary.investorFundPercent)}% contributor FUND <span>|</span> {number(summary.values.operatorFundPercent)}% Owner FUND</p></div>}
      </div></aside>
    </div>
  </>;
}
