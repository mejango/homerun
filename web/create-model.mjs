import { DEFAULT_NETWORK, projectNetwork } from './network-model.mjs';
import { NETWORK_ENVIRONMENTS, NETWORK_FAMILIES, plannedNetworks } from './create-networks.mjs';

export const CREATE_DRAFT_KEY = 'homerun:create-draft:v1';
export const CREATED_PROJECTS_KEY = 'homerun:created-projects:v1';

export const CREATE_DEFAULTS = Object.freeze({
  name: '',
  fundTokenName: '',
  fundTicker: '',
  location: '',
  description: '',
  revenueDescription: '',
  minimumRevenue: 0,
  minimumRevenueConsequences: '',
  purchaseBudget: 500_000,
  opsReserve: 100_000,
  monthlyRent: 10_000,
  monthlyCosts: 6_000,
  rentGrowthPercent: DEFAULT_NETWORK.rentGrowthPercent,
  costGrowthPercent: DEFAULT_NETWORK.costGrowthPercent,
  // Historical draft key: this success allocation belongs to the Owner.
  operatorFundPercent: 20,
  operatorSplitPercent: 70,
  stickySplitPercent: 10,
  networks: Object.freeze(NETWORK_FAMILIES.map(family => family.id)),
  networkEnvironment: 'production',
  revnetOperatorEnabled: true,
  ownerMode: 'create',
  ownerSigners: Object.freeze(['', '', '']),
  ownerThreshold: 2,
  ownerIsOperator: true,
  operatorMode: 'create',
  operatorSigners: Object.freeze(['', '', '']),
  operatorThreshold: 2,
  ownerWallet: '',
  ownerName: '',
  ownerIntroduction: '',
  ownerPhoto: '',
  operatorWallet: '',
  operatorName: '',
  operatorIntroduction: '',
  operatorPhoto: '',
  photo: '',
});

const NETWORK_IDS = NETWORK_FAMILIES.map(family => family.id);
const MONEY_FIELDS = ['purchaseBudget', 'opsReserve', 'monthlyRent', 'monthlyCosts', 'minimumRevenue'];
const LABELS = {
  purchaseBudget: 'Asset price', opsReserve: 'Bootstrap operating budget', monthlyRent: 'Monthly revenue', minimumRevenue: 'Minimum monthly revenue',
  monthlyCosts: 'Monthly expenses', operatorFundPercent: 'Owner FUND ownership',
  rentGrowthPercent: 'Target revenue growth rate',
  costGrowthPercent: 'Target expense growth rate',
  operatorSplitPercent: 'Operator INCOME allocation', stickySplitPercent: 'FUND staker INCOME allocation',
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
    ['name', 2, 60, 'Project name'], ['fundTokenName', 0, 32, 'FUND token name'], ['fundTicker', 0, 12, 'FUND ticker'], ['location', 0, 100, 'Location'], ['description', 0, 600, 'Description'], ['revenueDescription', 0, 1000, 'Revenue plan'],
    ['minimumRevenueConsequences', 0, 2000, 'Minimum revenue consequences'],
    ['ownerName', 0, 80, 'Owner name'], ['ownerIntroduction', 0, 1200, 'Owner introduction'],
    ['operatorName', 0, 80, 'Operator name'], ['operatorIntroduction', 0, 1200, 'Operator introduction'],
  ]) {
    const input = own(source, key) ? source[key] : CREATE_DEFAULTS[key];
    values[key] = typeof input === 'string' ? input.trim() : '';
    if (typeof input !== 'string') errors[key] = `${label} must be text.`;
    else if (values[key].length < min) errors[key] = `${label} must contain at least ${min} characters.`;
    else if (values[key].length > max) errors[key] = `${label} must be ${max} characters or fewer.`;
  }
  // The FUND ERC-20 is deployed at launch, so both fields must resolve to something. Blank means the project name.
  if (!values.fundTokenName) values.fundTokenName = values.name ? `${values.name} FUND`.slice(0, 32) : '';
  values.fundTicker = values.fundTicker.toUpperCase() || 'FUND';
  if (!errors.fundTicker && !/^[A-Z0-9-]+$/.test(values.fundTicker)) errors.fundTicker = 'FUND ticker may only use letters, numbers and dashes.';


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

  // Old drafts used one wallet for authority and incentives. Migrate only when
  // the Owner field is absent; an explicitly empty Owner never inherits it.
  for (const key of ['ownerWallet', 'operatorWallet']) {
    const wallet = own(source, key) ? source[key] : key === 'ownerWallet' ? source.operatorWallet ?? '' : '';
    values[key] = typeof wallet === 'string' ? wallet.trim() : '';
    if (typeof wallet !== 'string' || (values[key] && (!ADDRESS.test(values[key]) || /^0x0{40}$/i.test(values[key])))) {
      errors[key] = `Use a nonzero ${key === 'ownerWallet' ? 'owner' : 'operator'} address beginning with 0x, or leave it blank for this preview.`;
    }
  }
  // Drafts created before the multisig editor retain their explicit addresses.
  values.ownerIsOperator = own(source, 'ownerIsOperator') ? source.ownerIsOperator : false;
  if (typeof values.ownerIsOperator !== 'boolean') errors.ownerIsOperator = 'Choose whether Owner is also Operator.';
  for (const role of ['owner', 'operator']) {
    const mode = `${role}Mode`, signers = `${role}Signers`, threshold = `${role}Threshold`;
    values[mode] = own(source, mode) ? source[mode] : 'existing';
    const list = own(source, signers) ? source[signers] : CREATE_DEFAULTS[signers];
    values[signers] = Array.isArray(list) ? list.map(value => typeof value === 'string' ? value.trim() : '') : [];
    values[threshold] = parseNumber(own(source, threshold) ? source[threshold] : CREATE_DEFAULTS[threshold]);
    if (role === 'operator' && values.ownerIsOperator === true) { delete errors.operatorWallet; continue; }
    if (!['create', 'existing'].includes(values[mode])) errors[mode] = 'Choose a new multisig or an existing address.';
    if (values[mode] === 'create') {
      delete errors[`${role}Wallet`];
      const owners = values[signers];
      if (!Array.isArray(list) || owners.length < 2 || owners.length > 20 || owners.some(owner => !ADDRESS.test(owner) || /^0x0{39}[01]$/i.test(owner)))
        errors[signers] = 'Enter 2–20 nonzero owner addresses beginning with 0x.';
      else if (new Set(owners.map(owner => owner.toLowerCase())).size !== owners.length) errors[signers] = 'Each multisig owner must have a different address.';
      if (!Number.isInteger(values[threshold]) || values[threshold] < 1 || values[threshold] > owners.length)
        errors[threshold] = 'Choose how many owners must approve: at least 1 and no more than the number of owners.';
    }
  }
  if (values.ownerIsOperator === true) values.operatorWallet = values.ownerWallet;
  values.revnetOperatorEnabled = own(source, 'revnetOperatorEnabled')
    ? source.revnetOperatorEnabled : !own(source, 'ownerWallet') && own(source, 'operatorWallet') ? Boolean(values.operatorWallet) : CREATE_DEFAULTS.revnetOperatorEnabled;
  if (typeof values.revnetOperatorEnabled !== 'boolean') {
    errors.revnetOperatorEnabled = 'Choose whether to enable limited operator controls.';
  }

  for (const key of ['photo', 'ownerPhoto', 'operatorPhoto']) {
    const photo = own(source, key) ? source[key] : '';
    values[key] = typeof photo === 'string' ? photo : '';
    if (typeof photo !== 'string' || (photo && !validPhoto(photo))) {
      errors[key] = 'Use a JPEG, PNG, or WebP image smaller than 1.5 MB after encoding.';
    }
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
    separateOwnerOperator: true,
    ...Object.fromEntries([...MONEY_FIELDS.filter(key => key !== 'minimumRevenue'), 'rentGrowthPercent', 'costGrowthPercent', 'operatorFundPercent', 'operatorSplitPercent', 'stickySplitPercent']
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
  const ownerAddress = values.ownerMode === 'create' ? null : values.ownerWallet || null;
  const operatorAddress = values.ownerIsOperator ? ownerAddress : values.operatorMode === 'create' ? null : values.operatorWallet || null;
  const multisig = role => values[`${role}Mode`] === 'create' ? { multisig: { owners: values[`${role}Signers`], threshold: values[`${role}Threshold`], status: 'planned' } } : {};
  return {
    kind: 'homerun-deployment-preview',
    schemaVersion: 5,
    execution: {
      enabled: false,
      mode: 'local-preview',
      status: 'not-deployed',
      description: 'Saved in this browser only. No wallet signature, transaction, or onchain deployment is prepared.',
    },
    asset: {
      name: values.name, location: values.location,
      description: values.description, photo: values.photo,
    },
    networkEnvironment: values.networkEnvironment,
    plannedNetworks: networks,
    owner: {
      name: values.ownerName, introduction: values.ownerIntroduction, photo: values.ownerPhoto,
      address: ownerAddress, ...multisig('owner'),
      role: 'Owns FUND, operates INCOME, and executes program changes.',
      fundOwnershipPercentAfterPurchase: values.operatorFundPercent,
      distribution: 'The Owner may distribute their FUND tokens to the Operator at their discretion.',
    },
    operator: {
      name: values.operatorName, introduction: values.operatorIntroduction, photo: values.operatorPhoto,
      address: operatorAddress, ...multisig(values.ownerIsOperator ? 'owner' : 'operator'), ...(values.ownerIsOperator ? { sharedWithOwner: true } : {}),
    },
    revnetOperator: {
      enabled: values.revnetOperatorEnabled,
      address: values.revnetOperatorEnabled ? ownerAddress : null,
      scope: 'INCOME',
      status: values.revnetOperatorEnabled ? (values.ownerWallet ? 'specified' : 'not-specified') : 'disabled',
      chainIds: networks.map(network => network.chainId),
      permissionsAssigned: false,
      description: 'This preview does not assign operator permissions.',
    },
    funding: {
      ownerAddress,
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
      operatorAddress,
      operatorChangePolicy: 'The Owner may change the Operator at any time by updating the INCOME split recipient. No split is locked; other recipients and allocations can also be changed.',
      revenueDescription: values.revenueDescription,
      minimumRevenue: {
        monthlyAmountUSD: values.minimumRevenue,
        consequences: values.minimumRevenueConsequences,
        enforcement: 'Owner-managed policy; no automatic contract changes.',
      },
      activation: 'After a successful asset purchase',
      monthlyRevenueAssumption: values.monthlyRent,
      monthlyExpenseAssumption: values.monthlyCosts,
      annualRevenueGrowthPercentAssumption: values.rentGrowthPercent,
      annualExpenseGrowthPercentAssumption: values.costGrowthPercent,
      issuanceAllocationPercent: {
        operators: values.operatorSplitPercent,
        fundStakers: values.stickySplitPercent,
        customers: customerSplitPercent,
      },
      initialTokenPremintAssumption: networkInputs.revenuePremint,
      initialTokensPerUSDC: 1 / networkInputs.revPrice,
      issuanceCutPercentAssumption: networkInputs.issuanceCutPercent,
      issuanceCutPeriodMonthsAssumption: networkInputs.issuanceCutMonths,
      issuanceCutDurationYearsAssumption: networkInputs.issuanceCutYears,
      numberOfIssuanceCutsAssumption: Math.floor(networkInputs.issuanceCutYears * 12 / networkInputs.issuanceCutMonths),
      initialAllocation: {
        tokens: networkInputs.revenuePremint,
        distribution: 'Pro rata to all FUND holders, including the Owner, inactive ERC20 balances and unclaimed token credits.',
        balanceSources: ['erc20', 'unclaimed-credits'],
        requiresActivation: false, requiresStaking: false, vestingMonths: 0,
        implementationStatus: 'design-preview',
      },
      holderRewards: {
        mode: 'sticky', requiresStaking: true,
        distribution: 'Ongoing INCOME to eligible FUND stakers using Sticky, including operators who stake.',
        eligibilityPolicy: 'snapshot-share-balance',
        minimumStakeAgeSeconds: 0,
        vestingRounds: 4,
        roundSeconds: 604_800,
        vestingStartsAt: 'reward-claim-round',
        eligibility: 'Stock Sticky rewards are proportional to share balances at each snapshot. There is no stake-age boost; longer participation earns additional rounds.',
        runtimeAvailability: 'requires-verified-deployment',
        enabled: false,
      },
      projectionAssumption: 'All FUND participates in Sticky and rewards are fully vested. The four weekly vesting rounds after reward claims are not modeled.',
    },
    preparation: [
      { stage: 'fundraise', description: 'Prepare the FUND project and fundraising terms for review.' },
      { stage: 'income', description: 'After purchase, prepare the INCOME revnet, the initial allocation to all FUND holders, and separate ongoing Sticky rewards for review. Use stock Sticky share-balance snapshots and four weekly vesting rounds starting from the reward-claim round, without a minimum staking period. Live use requires a verified deployment.' },
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

/** The project entry a stored preview holds, for a setup that is not stored. */
export function modelCreatedProject(raw, id) {
  const { values } = creationSummary(raw);
  return { id, values, createdAt: new Date(0).toISOString(), deployment: deploymentDraft(values) };
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
  const entry = { ...modelCreatedProject(values, globalThis.crypto.randomUUID()), createdAt: new Date().toISOString() };
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
