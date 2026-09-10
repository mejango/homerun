import { DEFAULT_NETWORK, projectNetwork } from './network-model.mjs';
import { NETWORK_ENVIRONMENTS, NETWORK_FAMILIES, plannedNetworks } from './create-networks.mjs';

export const CREATE_DRAFT_KEY = 'homerun:create-draft:v1';
export const CREATED_PROJECTS_KEY = 'homerun:created-projects:v1';

export const CREATE_DEFAULTS = Object.freeze({
  name: '',
  assetType: 'real-estate',
  location: '',
  description: '',
  revenueDescription: '',
  purchaseBudget: 500_000,
  opsReserve: 100_000,
  monthlyRent: 10_000,
  monthlyCosts: 6_000,
  rentGrowthPercent: DEFAULT_NETWORK.rentGrowthPercent,
  costGrowthPercent: DEFAULT_NETWORK.costGrowthPercent,
  operatorFundPercent: 20,
  operatorSplitPercent: 70,
  stickySplitPercent: 10,
  networks: Object.freeze(NETWORK_FAMILIES.map(family => family.id)),
  networkEnvironment: 'production',
  revnetOperatorEnabled: true,
  operatorWallet: '',
  photo: '',
});

const ASSET_TYPES = new Set(['real-estate', 'business', 'equipment', 'energy', 'other']);
const NETWORK_IDS = NETWORK_FAMILIES.map(family => family.id);
const MONEY_FIELDS = ['purchaseBudget', 'opsReserve', 'monthlyRent', 'monthlyCosts'];
const LABELS = {
  purchaseBudget: 'Asset price', opsReserve: 'Cash reserve', monthlyRent: 'Monthly revenue',
  monthlyCosts: 'Monthly expenses', operatorFundPercent: 'Operator FUND ownership',
  rentGrowthPercent: 'Target revenue growth rate',
  costGrowthPercent: 'Target expense growth rate',
  operatorSplitPercent: 'Operator INCOME allocation', stickySplitPercent: 'FUND holder INCOME allocation',
};
const MAX_DOLLARS = 1_000_000_000;
const MAX_PHOTO_LENGTH = 1_500_000;
const ADDRESS = /^0x[\da-f]{40}$/i;
const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const own = (object, key) => Object.hasOwn(object, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseNumber(raw, grouped = false) {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return NaN;
  const value = raw.trim();
  const pattern = grouped
    ? /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/
    : /^[+-]?\d+(?:\.\d+)?$/;
  return pattern.test(value) ? Number(value.replaceAll(',', '')) : NaN;
}

/** Normalize only supported creation fields. This is a local preview, not a deployable configuration. */
export function normalizeCreateDraft(raw = {}) {
  const source = isRecord(raw) ? raw : {};
  const values = { ...CREATE_DEFAULTS };
  const errors = {};
  if (!isRecord(raw)) errors.form = 'Enter the details for your asset.';

  for (const [key, min, max, label] of [
    ['name', 2, 60, 'Project name'], ['location', 0, 100, 'Location'], ['description', 0, 600, 'Description'], ['revenueDescription', 0, 1000, 'Revenue plan'],
  ]) {
    const input = own(source, key) ? source[key] : CREATE_DEFAULTS[key];
    values[key] = typeof input === 'string' ? input.trim() : '';
    if (typeof input !== 'string') errors[key] = `${label} must be text.`;
    else if (values[key].length < min) errors[key] = `${label} must contain at least ${min} characters.`;
    else if (values[key].length > max) errors[key] = `${label} must be ${max} characters or fewer.`;
  }

  for (const [key, choices, label] of [
    ['assetType', ASSET_TYPES, 'asset type'],
  ]) {
    const input = own(source, key) ? source[key] : CREATE_DEFAULTS[key];
    values[key] = typeof input === 'string' ? input.trim() : '';
    if (!choices.has(values[key])) errors[key] = `Choose a supported ${label}.`;
  }

  // Older local previews used a single production network. Preserve that selection on read.
  const networks = own(source, 'networks') ? source.networks
    : own(source, 'network') ? [source.network] : CREATE_DEFAULTS.networks;
  values.networks = NETWORK_IDS.filter(id => Array.isArray(networks) && networks.includes(id));
  if (!Array.isArray(networks) || networks.length === 0
    || new Set(networks).size !== networks.length || networks.some(id => !NETWORK_IDS.includes(id))) {
    errors.networks = 'Choose at least one supported network, without duplicates.';
  }
  values.networkEnvironment = own(source, 'networkEnvironment')
    ? source.networkEnvironment : CREATE_DEFAULTS.networkEnvironment;
  if (!NETWORK_ENVIRONMENTS.includes(values.networkEnvironment)) {
    errors.networkEnvironment = 'Choose production networks or testnets.';
  }

  for (const key of [...MONEY_FIELDS, 'rentGrowthPercent', 'costGrowthPercent', 'operatorFundPercent', 'operatorSplitPercent', 'stickySplitPercent']) {
    const input = own(source, key) ? source[key] : CREATE_DEFAULTS[key];
    const money = MONEY_FIELDS.includes(key);
    const value = parseNumber(input, money);
    values[key] = Number.isFinite(value) ? value : null;
    const min = key === 'purchaseBudget' ? 0.01 : ['rentGrowthPercent', 'costGrowthPercent'].includes(key) ? -100 : 0;
    const max = money ? MAX_DOLLARS : key === 'operatorFundPercent' ? 99 : 100;
    if (!Number.isFinite(value) || value < min || value > max) {
      errors[key] = `${LABELS[key]} must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}.`;
    } else if (money && value !== Math.round(value * 100) / 100) {
      errors[key] = `${LABELS[key]} must use whole cents.`;
    }
  }
  if (!errors.operatorSplitPercent && !errors.stickySplitPercent
    && values.operatorSplitPercent + values.stickySplitPercent > 100) {
    const message = 'Operator and FUND holder INCOME allocations cannot total more than 100%.';
    errors.operatorSplitPercent = message;
    errors.stickySplitPercent = message;
  }

  const wallet = own(source, 'operatorWallet') ? source.operatorWallet : '';
  values.operatorWallet = typeof wallet === 'string' ? wallet.trim() : '';
  values.revnetOperatorEnabled = own(source, 'revnetOperatorEnabled')
    ? source.revnetOperatorEnabled : own(source, 'operatorWallet') ? Boolean(values.operatorWallet) : CREATE_DEFAULTS.revnetOperatorEnabled;
  if (typeof values.revnetOperatorEnabled !== 'boolean') {
    errors.revnetOperatorEnabled = 'Choose whether to enable limited operator controls.';
  }
  if (typeof wallet !== 'string' || (values.operatorWallet && (
    !ADDRESS.test(values.operatorWallet) || /^0x0{40}$/i.test(values.operatorWallet)
  ))) errors.operatorWallet = 'Use a nonzero operator address beginning with 0x, or leave it blank for this preview.';

  const photo = own(source, 'photo') ? source.photo : '';
  values.photo = typeof photo === 'string' ? photo : '';
  if (typeof photo !== 'string' || (photo && !validPhoto(photo))) {
    errors.photo = 'Use a JPEG, PNG, or WebP image smaller than 1.5 MB after encoding.';
  }

  return { valid: Object.keys(errors).length === 0, errors, values };
}

function validPhoto(photo) {
  if (photo.length > MAX_PHOTO_LENGTH || !/^data:image\/(?:jpeg|png|webp);base64,/.test(photo)) return false;
  const encoded = photo.slice(photo.indexOf(',') + 1);
  return encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded);
}

export function creationSummary(raw) {
  const normalized = normalizeCreateDraft(raw);
  if (!normalized.valid) {
    const error = new TypeError(Object.values(normalized.errors).join(' '));
    error.errors = normalized.errors;
    throw error;
  }
  const { values } = normalized;
  const networkInputs = {
    ...DEFAULT_NETWORK,
    ...Object.fromEntries([...MONEY_FIELDS, 'rentGrowthPercent', 'costGrowthPercent', 'operatorFundPercent', 'operatorSplitPercent', 'stickySplitPercent']
      .map(key => [key, values[key]])),
    ongoingOperatorSplitPercent: values.operatorSplitPercent,
    investment: 0,
    raisedPercent: 0,
    salePrice: values.purchaseBudget,
  };
  const { raiseGoal } = projectNetwork(networkInputs, 'raising');
  return {
    values,
    networkInputs,
    raiseGoal,
    customerSplitPercent: 100 - (values.operatorSplitPercent + values.stickySplitPercent),
    investorFundPercent: 100 - values.operatorFundPercent,
  };
}

/** A JSON-safe planning document. It intentionally contains no transactions or contract configuration. */
export function deploymentDraft(raw) {
  const { values, networkInputs, raiseGoal, customerSplitPercent, investorFundPercent } = creationSummary(raw);
  const networks = plannedNetworks(values);
  return {
    kind: 'homerun-deployment-preview',
    schemaVersion: 2,
    execution: {
      enabled: false,
      mode: 'local-preview',
      status: 'not-deployed',
      description: 'Saved in this browser only. No wallet signature, transaction, or onchain deployment is prepared.',
    },
    asset: {
      name: values.name, type: values.assetType, location: values.location,
      description: values.description, photo: values.photo,
    },
    networkEnvironment: values.networkEnvironment,
    plannedNetworks: networks,
    operator: { address: values.operatorWallet || null, fundOwnershipPercentAfterPurchase: values.operatorFundPercent },
    revnetOperator: {
      enabled: values.revnetOperatorEnabled,
      address: values.revnetOperatorEnabled ? values.operatorWallet || null : null,
      scope: 'INCOME',
      status: values.revnetOperatorEnabled ? (values.operatorWallet ? 'specified' : 'not-specified') : 'disabled',
      chainIds: networks.map(network => network.chainId),
      permissionsAssigned: false,
      description: 'This preview does not assign operator permissions.',
    },
    funding: {
      ownerAddress: values.operatorWallet || null,
      ownershipAssigned: false,
      token: 'FUND',
      currency: 'USDC',
      assetBudget: values.purchaseBudget,
      cashReserve: values.opsReserve,
      raiseGoal,
      payoutFeePercentAssumption: networkInputs.payoutFeePercent,
      investorOwnershipPercentAfterPurchase: investorFundPercent,
      tokensPerUSDC: 10_000,
      startingAmountRaised: 0,
    },
    income: {
      token: 'INCOME',
      revenueDescription: values.revenueDescription,
      activation: 'After a successful asset purchase',
      monthlyRevenueAssumption: values.monthlyRent,
      monthlyExpenseAssumption: values.monthlyCosts,
      annualRevenueGrowthPercentAssumption: values.rentGrowthPercent,
      annualExpenseGrowthPercentAssumption: values.costGrowthPercent,
      issuanceAllocationPercent: {
        operators: values.operatorSplitPercent,
        fundHolders: values.stickySplitPercent,
        customers: customerSplitPercent,
      },
      initialTokenPremintAssumption: networkInputs.revenuePremint,
      initialTokensPerUSDC: 1 / networkInputs.revPrice,
      issuanceCutPercentAssumption: networkInputs.issuanceCutPercent,
      issuanceCutPeriodMonthsAssumption: networkInputs.issuanceCutMonths,
      issuanceCutDurationYearsAssumption: networkInputs.issuanceCutYears,
      numberOfIssuanceCutsAssumption: Math.floor(networkInputs.issuanceCutYears * 12 / networkInputs.issuanceCutMonths),
      holderRewards: {
        mode: 'automatic', requiresStaking: false, vestingMonths: 0,
        distribution: 'Pro rata to FUND holders, including operators, at each revenue payment.',
        implementationStatus: 'design-preview',
      },
    },
    preparation: [
      { stage: 'fundraise', description: 'Prepare the FUND project and fundraising terms for review.' },
      { stage: 'income', description: 'After purchase, prepare the INCOME revnet and automatic FUND-holder reward distribution for review.' },
      { stage: 'asset-sale', description: 'Prepare sale distributions when the asset is sold.' },
    ],
  };
}

function validateStoredEntry(raw) {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !UUID.test(raw.id) || typeof raw.createdAt !== 'string'
    || !Number.isFinite(Date.parse(raw.createdAt)) || !isRecord(raw.values)) return null;
  try {
    const { values } = creationSummary(raw.values);
    // Rebuild the preview from validated values; stored deployment flags are never trusted.
    return { id: raw.id, values, createdAt: raw.createdAt, deployment: deploymentDraft(values) };
  } catch {
    return null;
  }
}

function parseStoredProjects(serialized) {
  const stored = JSON.parse(serialized || '[]');
  return Array.isArray(stored) ? stored.map(validateStoredEntry).filter(Boolean) : [];
}

export function listCreatedProjects(storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    return parseStoredProjects(target.getItem(CREATED_PROJECTS_KEY));
  } catch {
    return [];
  }
}

export function loadCreatedProject(id, storage) {
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  return listCreatedProjects(storage).find(entry => entry.id === id) || null;
}

export function saveCreatedProject(raw, storage) {
  const { values } = creationSummary(raw);
  let target;
  let serialized;
  try {
    target = storage === undefined ? globalThis.localStorage : storage;
    if (!target || typeof target.getItem !== 'function' || typeof target.setItem !== 'function') throw new Error();
    serialized = target.getItem(CREATED_PROJECTS_KEY);
  } catch {
    throw new Error('Browser storage is unavailable. Download the deployment preview to keep these details.');
  }
  const entry = {
    id: globalThis.crypto.randomUUID(),
    values,
    createdAt: new Date().toISOString(),
    deployment: deploymentDraft(values),
  };
  // Preserve earlier previews. Malformed entries are discarded by the read helper.
  let existing;
  try { existing = parseStoredProjects(serialized); } catch { existing = []; }
  try {
    target.setItem(CREATED_PROJECTS_KEY, JSON.stringify([...existing, entry]));
  } catch {
    throw new Error('This browser could not save the preview. Free some storage or download the deployment preview.');
  }
  return entry;
}
