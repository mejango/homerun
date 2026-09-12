import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATE_DEFAULTS, CREATE_DRAFT_KEY, CREATED_PROJECTS_KEY, normalizeCreateDraft,
  creationSummary, deploymentDraft, saveCreatedProject, listCreatedProjects, loadCreatedProject,
} from '../web/create-model.mjs';
import { DEFAULT_NETWORK, projectNetwork } from '../web/network-model.mjs';
import { NETWORK_FAMILIES, NETWORK_ENVIRONMENTS, plannedNetworks } from '../web/create-networks.mjs';

const draft = overrides => ({ ...CREATE_DEFAULTS, name: 'Neighborhood Solar', ...overrides });
const wallet = `0x${'a1'.repeat(20)}`;
const memoryStorage = () => {
  const data = new Map();
  return {
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, String(value)); },
  };
};

test('new creation defaults require a project name and have the agreed ownership allocations', () => {
  const result = normalizeCreateDraft();
  assert.equal(result.valid, false);
  assert.deepEqual(Object.keys(result.errors), ['name']);
  assert.equal(result.values.name, '');
  assert.equal(result.values.operatorFundPercent, 20);
  assert.equal(result.values.operatorSplitPercent, 70);
  assert.equal(result.values.stickySplitPercent, 10);
  assert.equal(result.values.rentGrowthPercent, 3);
  assert.deepEqual(result.values.networks, ['ethereum', 'optimism', 'base', 'arbitrum']);
  assert.equal(result.values.networkEnvironment, 'production');
  assert.equal(result.values.revnetOperatorEnabled, true);
  assert.equal(Object.hasOwn(CREATE_DEFAULTS, 'network'), false);
  assert.ok(Object.isFrozen(CREATE_DEFAULTS.networks));
  assert.equal(CREATE_DRAFT_KEY, 'homerun:create-draft:v1');
  assert.equal(CREATED_PROJECTS_KEY, 'homerun:created-projects:v1');
});

test('normalization accepts grouped form money, trims copy, and ignores unrelated model controls', () => {
  const input = draft({
    name: '  Neighborhood Solar  ', location: '  Floripa  ', description: ' Community energy. ',
    purchaseBudget: '125,500.25', opsReserve: '10,000', monthlyRent: '1,000.01',
    monthlyCosts: '600.35', operatorFundPercent: '12.5',
    operatorWallet: `  ${wallet}  `, raisedPercent: 90, investment: 1000, phase: 'earning',
  });
  const original = structuredClone(input);
  const result = normalizeCreateDraft(input);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, {});
  assert.equal(result.values.name, 'Neighborhood Solar');
  assert.equal(result.values.location, 'Floripa');
  assert.equal(result.values.description, 'Community energy.');
  assert.equal(result.values.purchaseBudget, 125_500.25);
  assert.equal(result.values.monthlyRent, 1000.01);
  assert.equal(result.values.operatorFundPercent, 12.5);
  assert.equal(result.values.operatorWallet, wallet);
  assert.equal(Object.hasOwn(result.values, 'raisedPercent'), false);
  assert.equal(Object.hasOwn(result.values, 'investment'), false);
  assert.equal(Object.hasOwn(result.values, 'phase'), false);
  assert.deepEqual(input, original);
});

test('whole-cent money validation rejects partial parses and nonnumeric values without rounding them', () => {
  for (const bad of ['', ' ', '1,00', '100,00', '1,000 USD', '$500', '1e3', '0x10', '1.005', true, null, [], {}, NaN, Infinity]) {
    const result = normalizeCreateDraft(draft({ purchaseBudget: bad }));
    assert.equal(result.valid, false, String(bad));
    assert.ok(result.errors.purchaseBudget, String(bad));
    assert.throws(() => creationSummary(draft({ purchaseBudget: bad })), TypeError);
  }
  for (const bad of [0, -1, 1_000_000_000.01]) {
    assert.ok(normalizeCreateDraft(draft({ purchaseBudget: bad })).errors.purchaseBudget);
  }
  assert.equal(normalizeCreateDraft(draft({ purchaseBudget: '.50' })).valid, false);
  assert.equal(normalizeCreateDraft(draft({ purchaseBudget: '0.50' })).valid, true);
  assert.equal(normalizeCreateDraft(draft({ purchaseBudget: '1,000,000,000.00' })).valid, true);
  assert.equal(normalizeCreateDraft(draft({ opsReserve: 0, monthlyRent: 0, monthlyCosts: 0 })).valid, true);
});

test('copy lengths and asset categories are bounded', () => {
  for (const [field, value] of [
    ['name', 'x'], ['name', 'x'.repeat(61)], ['name', 123], ['location', 'x'.repeat(101)],
    ['description', 'x'.repeat(601)], ['assetType', 'token'],
  ]) {
    assert.ok(normalizeCreateDraft(draft({ [field]: value })).errors[field], `${field}: ${value}`);
  }
  for (const assetType of ['real-estate', 'business', 'equipment', 'energy', 'other']) {
    assert.equal(normalizeCreateDraft(draft({ assetType })).valid, true);
  }
  assert.equal(normalizeCreateDraft(draft({ name: 'x'.repeat(60) })).valid, true);
  for (const raw of [null, [], 'text', 123]) {
    assert.ok(normalizeCreateDraft(raw).errors.form);
  }
});

test('network selections resolve all four production or test chains in canonical order', () => {
  assert.deepEqual(NETWORK_ENVIRONMENTS, ['production', 'testnet']);
  assert.deepEqual(plannedNetworks(CREATE_DEFAULTS).map(network => network.chainId), [1, 10, 8453, 42161]);
  assert.deepEqual(deploymentDraft(draft({ networkEnvironment: 'testnet' })).plannedNetworks.map(network => network.chainId),
    [11155111, 11155420, 84532, 421614]);
  const raw = draft({ networks: ['arbitrum', 'ethereum'], networkEnvironment: 'testnet' });
  const original = structuredClone(raw);
  const normalized = normalizeCreateDraft(raw);
  assert.equal(normalized.valid, true);
  assert.deepEqual(normalized.values.networks, ['ethereum', 'arbitrum']);
  assert.deepEqual(raw, original);
  const exported = deploymentDraft(raw);
  assert.equal(exported.networkEnvironment, 'testnet');
  assert.deepEqual(exported.plannedNetworks, [
    { id: 'sepolia', name: 'Sepolia', chainId: 11155111 },
    { id: 'arbitrum-sepolia', name: 'Arbitrum Sepolia', chainId: 421614 },
  ]);
  exported.plannedNetworks[0].chainId = 0;
  assert.equal(NETWORK_FAMILIES[0].testnet.chainId, 11155111);
});

test('network selection rejects empty, unknown, duplicate, and mixed environment chain IDs', () => {
  for (const networks of [[], 'base', null, {}, ['unknown'], ['base', 'base'], ['base', 'base-sepolia'], ['sepolia'], [1], [' base']]) {
    const result = normalizeCreateDraft(draft({ networks }));
    assert.equal(result.valid, false, JSON.stringify(networks));
    assert.ok(result.errors.networks);
    assert.throws(() => deploymentDraft(draft({ networks })), /network/);
  }
  for (const networkEnvironment of ['mainnet', 'both', '', null, true, ['production']]) {
    assert.ok(normalizeCreateDraft(draft({ networkEnvironment })).errors.networkEnvironment);
  }
  assert.throws(() => plannedNetworks({ networks: ['base'], networkEnvironment: 'both' }), TypeError);
  assert.throws(() => plannedNetworks({ networks: ['base', 'base'], networkEnvironment: 'production' }), TypeError);
  const selected = normalizeCreateDraft(draft({ networks: ['optimism'] }));
  assert.equal(selected.valid, true);
  assert.deepEqual(selected.values.networks, ['optimism']);
});

test('legacy single-network drafts migrate without overriding explicitly selected networks', () => {
  for (const [network, chainId] of [['ethereum', 1], ['base', 8453]]) {
    const normalized = normalizeCreateDraft({ name: 'Old preview', network });
    assert.equal(normalized.valid, true);
    assert.deepEqual(normalized.values.networks, [network]);
    assert.equal(normalized.values.networkEnvironment, 'production');
    assert.equal(Object.hasOwn(normalized.values, 'network'), false);
    assert.deepEqual(deploymentDraft(normalized.values).plannedNetworks.map(item => item.chainId), [chainId]);
  }
  assert.ok(normalizeCreateDraft({ name: 'Old preview', network: 'unknown' }).errors.networks);
  const explicit = normalizeCreateDraft(draft({ network: 'base', networks: ['ethereum'], networkEnvironment: 'testnet' }));
  assert.deepEqual(explicit.values.networks, ['ethereum']);
  assert.equal(explicit.values.networkEnvironment, 'testnet');
  assert.ok(normalizeCreateDraft(draft({ network: 'base', networks: [] })).errors.networks);
});

test('ownership percentages and combined INCOME issuance stay within available supply', () => {
  for (const operatorFundPercent of [-1, 99.01, 100, NaN]) {
    assert.ok(normalizeCreateDraft(draft({ operatorFundPercent })).errors.operatorFundPercent);
  }
  for (const field of ['operatorSplitPercent', 'stickySplitPercent']) {
    for (const value of [-0.01, 100.01, '1,000', false]) {
      assert.ok(normalizeCreateDraft(draft({ [field]: value })).errors[field]);
    }
  }
  const invalid = normalizeCreateDraft(draft({ operatorSplitPercent: 90, stickySplitPercent: 11 }));
  assert.ok(invalid.errors.operatorSplitPercent);
  assert.ok(invalid.errors.stickySplitPercent);
  assert.equal(creationSummary(draft({ operatorSplitPercent: 80, stickySplitPercent: 20 })).customerSplitPercent, 0);
  assert.equal(creationSummary(draft({ operatorSplitPercent: 0, stickySplitPercent: 0 })).customerSplitPercent, 100);
  assert.equal(creationSummary(draft({ operatorFundPercent: 99 })).investorFundPercent, 1);
});

test('the shared operator address is validated regardless of optional INCOME controls', () => {
  for (const operatorWallet of ['', wallet, `0x${'AB'.repeat(20)}`]) {
    assert.equal(normalizeCreateDraft(draft({ revnetOperatorEnabled: true, operatorWallet })).valid, true);
  }
  for (const operatorWallet of [`0x${'0'.repeat(40)}`, 'name.eth', '0x1234', `${wallet}x`, {}, null]) {
    assert.ok(normalizeCreateDraft(draft({ revnetOperatorEnabled: true, operatorWallet })).errors.operatorWallet);
    assert.ok(normalizeCreateDraft(draft({ revnetOperatorEnabled: false, operatorWallet })).errors.operatorWallet);
  }
  for (const revnetOperatorEnabled of ['true', 1, null, [], {}]) {
    assert.ok(normalizeCreateDraft(draft({ revnetOperatorEnabled })).errors.revnetOperatorEnabled);
  }
});

test('revnet operator controls are separate from economic FUND ownership and have no assigned permissions', () => {
  const disabled = deploymentDraft(draft({ ownerWallet: wallet, operatorWallet: wallet, revnetOperatorEnabled: false }));
  assert.deepEqual(disabled.operator, { name: '', introduction: '', photo: '', address: wallet });
  assert.equal(disabled.funding.ownerAddress, wallet);
  assert.equal(disabled.funding.ownershipAssigned, false);
  assert.equal(disabled.revnetOperator.enabled, false);
  assert.equal(disabled.revnetOperator.address, null);
  assert.equal(disabled.revnetOperator.status, 'disabled');
  const unspecified = deploymentDraft(draft({ revnetOperatorEnabled: true }));
  assert.equal(unspecified.revnetOperator.status, 'not-specified');
  assert.equal(unspecified.revnetOperator.address, null);
  const enabled = deploymentDraft(draft({
    revnetOperatorEnabled: true, ownerWallet: wallet, operatorWallet: wallet, networks: ['base', 'ethereum'], networkEnvironment: 'testnet',
  }));
  assert.equal(enabled.revnetOperator.address, wallet);
  assert.equal(enabled.revnetOperator.status, 'specified');
  assert.equal(enabled.revnetOperator.scope, 'INCOME');
  assert.deepEqual(enabled.revnetOperator.chainIds, [11155111, 84532]);
  assert.equal(enabled.revnetOperator.permissionsAssigned, false);
  assert.deepEqual(enabled.operator, disabled.operator);
  assert.deepEqual(enabled.income.issuanceAllocationPercent, disabled.income.issuanceAllocationPercent);
});

test('legacy nonblank operator addresses enable revnet controls unless explicitly disabled', () => {
  const legacy = normalizeCreateDraft({ name: 'Existing preview', operatorWallet: ` ${wallet} ` });
  assert.equal(legacy.valid, true);
  assert.equal(legacy.values.revnetOperatorEnabled, true);
  assert.equal(legacy.values.operatorWallet, wallet);
  assert.equal(normalizeCreateDraft({ name: 'Existing preview', operatorWallet: '' }).values.revnetOperatorEnabled, false);
  assert.ok(normalizeCreateDraft({ name: 'Existing preview', operatorWallet: 'bad' }).errors.operatorWallet);
  assert.equal(normalizeCreateDraft(draft({ operatorWallet: wallet })).values.revnetOperatorEnabled, true);
});

test('photos allow only bounded encoded raster data and reject remote or active content', () => {
  for (const field of ['photo', 'operatorPhoto']) {
    for (const type of ['jpeg', 'png', 'webp']) {
      assert.equal(normalizeCreateDraft(draft({ [field]: `data:image/${type};base64,YWJjZA==` })).valid, true);
    }
    for (const photo of [
      'https://example.com/house.jpg', 'javascript:alert(1)', 'data:image/svg+xml;base64,YWJjZA==',
      'data:text/html;base64,YWJjZA==', 'data:image/png;base64,', 'data:image/png;base64,%%AA',
      'data:image/png;base64,YWJjZ', 'data:image/png;base64,Y=JjZA==', {}, null,
      `data:image/png;base64,${'A'.repeat(1_500_000)}`,
    ]) assert.ok(normalizeCreateDraft(draft({ [field]: photo })).errors[field], String(photo).slice(0, 80));
    // A large legitimate encoding must be handled without recursive-regex stack overflow.
    assert.equal(normalizeCreateDraft(draft({ [field]: `data:image/png;base64,${'A'.repeat(1_400_000)}` })).valid, true);
  }
});

test('optional operator profiles are bounded and survive local save and download', () => {
  const operatorPhoto = 'data:image/webp;base64,YWJjZA==';
  const raw = draft({ operatorName: '  Solar Co-op  ', operatorIntroduction: '  We run the neighborhood solar garden.  ', operatorPhoto });
  const { valid, values } = normalizeCreateDraft(raw);
  assert.equal(valid, true);
  assert.equal(values.operatorName, 'Solar Co-op');
  assert.equal(values.operatorIntroduction, 'We run the neighborhood solar garden.');
  const exported = deploymentDraft(values);
  assert.deepEqual(exported.operator, {
    name: values.operatorName, introduction: values.operatorIntroduction, photo: operatorPhoto,
    address: null,
  });
  const storage = memoryStorage();
  const saved = saveCreatedProject(raw, storage);
  assert.deepEqual(loadCreatedProject(saved.id, storage).values, values);
  assert.deepEqual(loadCreatedProject(saved.id, storage).deployment.operator, exported.operator);
  for (const [field, limit] of [['operatorName', 80], ['operatorIntroduction', 1200]]) {
    assert.equal(normalizeCreateDraft(draft({ [field]: 'x'.repeat(limit) })).valid, true);
    for (const invalid of ['x'.repeat(limit + 1), null, {}, 12]) {
      assert.ok(normalizeCreateDraft(draft({ [field]: invalid })).errors[field]);
    }
  }
  const legacy = normalizeCreateDraft({ name: 'Existing asset' });
  assert.equal(legacy.valid, true);
  for (const field of ['operatorName', 'operatorIntroduction', 'operatorPhoto']) assert.equal(legacy.values[field], '');
});

test('summary starts with no prior funding, preserves existing economic assumptions, and covers the acquisition', () => {
  const summary = creationSummary(draft());
  assert.equal(summary.raiseGoal, 615_384.62);
  assert.equal(summary.investorFundPercent, 80);
  assert.equal(summary.customerSplitPercent, 20);
  assert.equal(summary.networkInputs.investment, 0);
  assert.equal(summary.networkInputs.raisedPercent, 0);
  assert.equal(summary.networkInputs.precloseSpent, 0);
  assert.equal(summary.networkInputs.closingCosts, 0);
  assert.equal(summary.networkInputs.payoutFeePercent, DEFAULT_NETWORK.payoutFeePercent);
  assert.equal(summary.networkInputs.revenuePremint, DEFAULT_NETWORK.revenuePremint);
  const projected = projectNetwork(summary.networkInputs, 'raising');
  assert.equal(projected.raised, 0);
  assert.equal(projected.escrowCash, 0);
  assert.equal(projected.fundSupply, 0);
  assert.equal(projected.revSupply, 0);
  assert.ok(summary.raiseGoal * 0.975 >= 600_000);
});

test('custom assumptions flow through the same projection and align later operator issuance', () => {
  const input = draft({
    purchaseBudget: 120_000.25, opsReserve: 12_000, monthlyRent: 1500.35, monthlyCosts: 400,
    operatorFundPercent: 10, operatorSplitPercent: 65, stickySplitPercent: 25,
  });
  const { networkInputs, raiseGoal, customerSplitPercent, investorFundPercent } = creationSummary(input);
  assert.equal(networkInputs.ongoingOperatorSplitPercent, 65);
  assert.equal(networkInputs.monthlyRent, 1500.35);
  assert.equal(networkInputs.salePrice, input.purchaseBudget);
  assert.equal(investorFundPercent, 90);
  assert.equal(customerSplitPercent, 10);
  assert.equal(raiseGoal, Math.ceil((120_000.25 + 12_000) * 100 / 0.975) / 100);
  const afterPurchase = projectNetwork(networkInputs, 'earning');
  assert.equal(afterPurchase.currentOperatorSplitPercent, 65);
  assert.equal(afterPurchase.operatorFundPercent, 10);
});

test('target revenue growth accepts finite annual percentages between minus and plus 100', () => {
  for (const [input, expected] of [[-100, -100], ['-12.5', -12.5], [0, 0], [' 10.25 ', 10.25], [100, 100]]) {
    const normalized = normalizeCreateDraft(draft({ rentGrowthPercent: input }));
    assert.equal(normalized.valid, true);
    assert.equal(normalized.values.rentGrowthPercent, expected);
    assert.equal(creationSummary(normalized.values).networkInputs.rentGrowthPercent, expected);
  }
  for (const rentGrowthPercent of [-100.01, 100.01, NaN, Infinity, -Infinity, null, true, {}, [], '', 'NaN', '1e2', '1,000', '10%']) {
    const normalized = normalizeCreateDraft(draft({ rentGrowthPercent }));
    assert.equal(normalized.valid, false, String(rentGrowthPercent));
    assert.match(normalized.errors.rentGrowthPercent, /Target revenue growth rate must be between -100 and 100/);
    assert.throws(() => deploymentDraft(draft({ rentGrowthPercent })), /Target revenue growth rate/);
  }
});

test('revenue growth compounds annually starting at month 13 independently of quarterly issuance cuts', () => {
  const projections = new Map([0, 10, -100].map(rentGrowthPercent => [
    rentGrowthPercent, projectNetwork(creationSummary(draft({ rentGrowthPercent })).networkInputs, 'earning'),
  ]));
  for (const projection of projections.values()) {
    assert.equal(projection.history[1].lastMonthRent, 10_000);
    assert.equal(projection.history[3].lastMonthRent, 10_000);
    assert.equal(projection.history[12].lastMonthRent, 10_000);
    assert.equal(projection.history[2].issuanceCutsApplied, 0);
    assert.equal(projection.history[3].issuanceCutsApplied, 1);
    assert.equal(projection.history[12].issuanceCutsApplied, 4);
    assert.equal(projection.history[13].issuanceCutsApplied, 4);
    assert.equal(projection.history[24].issuanceCutsApplied, 8);
    assert.equal(projection.history[25].issuanceCutsApplied, 8);
    assert.equal(projection.costGrowthPercent, DEFAULT_NETWORK.costGrowthPercent);
    assert.equal(projection.history[13].lastMonthCosts, 6_180);
  }
  assert.equal(projections.get(0).history[13].lastMonthRent, 10_000);
  assert.equal(projections.get(0).history[25].lastMonthRent, 10_000);
  assert.equal(projections.get(10).history[13].lastMonthRent, 11_000);
  assert.equal(projections.get(10).history[24].lastMonthRent, 11_000);
  assert.equal(projections.get(10).history[25].lastMonthRent, 12_100);
  assert.equal(projections.get(-100).history[13].lastMonthRent, 0);
  assert.equal(projections.get(-100).history[25].lastMonthRent, 0);
  for (const projection of projections.values()) {
    assert.deepEqual(projection.history.map(row => row.currentIssuanceRate), projections.get(0).history.map(row => row.currentIssuanceRate));
  }
});

test('selected revenue growth persists and exports while legacy previews retain the existing default', () => {
  const storage = memoryStorage();
  const created = saveCreatedProject(draft({ rentGrowthPercent: -2.5 }), storage);
  const loaded = loadCreatedProject(created.id, storage);
  assert.equal(loaded.values.rentGrowthPercent, -2.5);
  assert.equal(loaded.deployment.income.annualRevenueGrowthPercentAssumption, -2.5);
  assert.equal(creationSummary(loaded.values).networkInputs.rentGrowthPercent, -2.5);
  delete created.values.rentGrowthPercent;
  delete created.deployment.income.annualRevenueGrowthPercentAssumption;
  storage.setItem(CREATED_PROJECTS_KEY, JSON.stringify([created]));
  const legacy = loadCreatedProject(created.id, storage);
  assert.equal(legacy.values.rentGrowthPercent, DEFAULT_NETWORK.rentGrowthPercent);
  assert.equal(legacy.deployment.income.annualRevenueGrowthPercentAssumption, 3);
  assert.equal(normalizeCreateDraft({ name: 'Legacy draft' }).values.rentGrowthPercent, 3);
  assert.equal(creationSummary(legacy.values).networkInputs.costGrowthPercent, DEFAULT_NETWORK.costGrowthPercent);
});

test('deployment export remains a JSON-safe local plan and separates FUND launch from later INCOME preparation', () => {
  const result = deploymentDraft(draft({ networks: ['ethereum'], revnetOperatorEnabled: true, ownerWallet: wallet, operatorWallet: wallet }));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(result.kind, 'homerun-deployment-preview');
  assert.equal(result.schemaVersion, 5);
  assert.equal(result.execution.enabled, false);
  assert.equal(result.execution.status, 'not-deployed');
  assert.equal(result.networkEnvironment, 'production');
  assert.deepEqual(result.plannedNetworks, [{ id: 'ethereum', name: 'Ethereum', chainId: 1 }]);
  assert.equal(Object.hasOwn(result, 'plannedNetwork'), false);
  assert.equal(result.revnetOperator.address, wallet);
  assert.equal(result.operator.address, wallet);
  assert.equal(result.funding.ownerAddress, wallet);
  assert.equal(result.funding.ownershipAssigned, false);
  assert.equal(result.funding.startingAmountRaised, 0);
  assert.equal(result.funding.token, 'FUND');
  assert.equal(result.income.token, 'INCOME');
  assert.deepEqual(result.income.issuanceAllocationPercent, { operators: 70, fundStakers: 10, customers: 20 });
  assert.equal(result.preparation[0].stage, 'fundraise');
  assert.match(result.preparation[1].description, /After purchase.*INCOME.*all FUND holders.*ongoing Sticky/);
  const keys = [];
  const visit = object => {
    for (const [key, value] of Object.entries(object)) {
      keys.push(key);
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(result);
  assert.equal(keys.some(key => /calldata|txhash|contractaddress|transactionhash/i.test(key)), false);
  assert.equal(deploymentDraft(draft()).revnetOperator.address, null);
  assert.equal(deploymentDraft(draft()).plannedNetworks.length, 4);
});

test('saved projects round-trip independently, carry unique IDs, and preserve earlier entries', () => {
  const storage = memoryStorage();
  const first = saveCreatedProject(draft(), storage);
  const second = saveCreatedProject(draft({
    name: 'Corner Shop', assetType: 'business', networks: ['optimism', 'base'], networkEnvironment: 'testnet',
    revnetOperatorEnabled: true, ownerWallet: wallet, operatorWallet: wallet,
  }), storage);
  assert.notEqual(first.id, second.id);
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
  assert.deepEqual(loadCreatedProject(first.id, storage), first);
  assert.deepEqual(loadCreatedProject(second.id, storage), second);
  assert.deepEqual(listCreatedProjects(storage), [first, second]);
  assert.equal(loadCreatedProject('missing', storage), null);
  assert.equal(loadCreatedProject(null, storage), null);
  const detached = loadCreatedProject(first.id, storage);
  detached.values.name = 'Changed in memory';
  assert.equal(loadCreatedProject(first.id, storage).values.name, 'Neighborhood Solar');
  assert.deepEqual(loadCreatedProject(second.id, storage).deployment.plannedNetworks.map(network => network.chainId), [11155420, 84532]);
  assert.equal(loadCreatedProject(second.id, storage).deployment.revnetOperator.address, wallet);
});

test('legacy saved projects rebuild the multi-network planning schema and operator role from original values', () => {
  const storage = memoryStorage();
  const entry = saveCreatedProject(draft(), storage);
  delete entry.values.networks;
  delete entry.values.networkEnvironment;
  delete entry.values.revnetOperatorEnabled;
  delete entry.values.ownerWallet;
  entry.values.network = 'base';
  entry.values.operatorWallet = wallet;
  entry.deployment = { schemaVersion: 1, plannedNetwork: { chainId: 1 }, execution: { enabled: true } };
  storage.setItem(CREATED_PROJECTS_KEY, JSON.stringify([entry]));
  const loaded = loadCreatedProject(entry.id, storage);
  assert.deepEqual(loaded.values.networks, ['base']);
  assert.equal(loaded.values.revnetOperatorEnabled, true);
  assert.equal(loaded.deployment.schemaVersion, 5);
  assert.deepEqual(loaded.deployment.plannedNetworks, [{ id: 'base', name: 'Base', chainId: 8453 }]);
  assert.equal(loaded.deployment.execution.enabled, false);
  assert.equal(loaded.deployment.revnetOperator.address, wallet);
  assert.equal(Object.hasOwn(loaded.deployment, 'plannedNetwork'), false);
  assert.equal(Object.hasOwn(loaded.values, 'network'), false);
});

test('creation has no fundraising deadline and ignores legacy fundraising windows', () => {
  assert.equal(Object.hasOwn(CREATE_DEFAULTS, 'raiseDays'), false);
  const normalized = normalizeCreateDraft(draft({ raiseDays: 'invalid legacy value' }));
  assert.equal(normalized.valid, true);
  assert.equal(Object.hasOwn(normalized.values, 'raiseDays'), false);
  assert.equal(Object.hasOwn(deploymentDraft(normalized.values).funding, 'durationDays'), false);

  const storage = memoryStorage();
  const entry = saveCreatedProject(draft(), storage);
  entry.values.raiseDays = 60;
  entry.deployment.funding.durationDays = 60;
  storage.setItem(CREATED_PROJECTS_KEY, JSON.stringify([entry]));
  const loaded = loadCreatedProject(entry.id, storage);
  assert.equal(Object.hasOwn(loaded.values, 'raiseDays'), false);
  assert.equal(Object.hasOwn(loaded.deployment.funding, 'durationDays'), false);
  assert.equal(loaded.deployment.funding.raiseGoal, entry.deployment.funding.raiseGoal);
  assert.equal(loaded.deployment.execution.enabled, false);
});

test('storage reads ignore malformed entries and recompute deployment flags instead of trusting stored claims', () => {
  const storage = memoryStorage();
  const entry = saveCreatedProject(draft(), storage);
  const forged = structuredClone(entry);
  forged.deployment.execution.enabled = true;
  forged.deployment.txHash = 'not-a-transaction';
  forged.values.raisedPercent = 100;
  storage.setItem(CREATED_PROJECTS_KEY, JSON.stringify([
    null, {}, { ...entry, id: '../other' }, { ...entry, createdAt: 'invalid' },
    { ...entry, values: { name: 'x' } }, forged,
  ]));
  const loaded = listCreatedProjects(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].deployment.execution.enabled, false);
  assert.equal(Object.hasOwn(loaded[0].deployment, 'txHash'), false);
  assert.equal(Object.hasOwn(loaded[0].values, 'raisedPercent'), false);
  assert.equal(loaded[0].deployment.funding.startingAmountRaised, 0);
  for (const serialized of ['{broken', '{}', 'null', '42', '"text"']) {
    storage.setItem(CREATED_PROJECTS_KEY, serialized);
    assert.deepEqual(listCreatedProjects(storage), []);
    assert.equal(loadCreatedProject(entry.id, storage), null);
  }
});

test('storage failures are safe to read and fail explicitly on save without claiming success', () => {
  let writes = 0;
  const blocked = {
    getItem() { throw new Error('Access denied'); },
    setItem() { writes++; },
  };
  assert.deepEqual(listCreatedProjects(blocked), []);
  assert.throws(() => saveCreatedProject(draft(), blocked), /storage is unavailable/);
  assert.equal(writes, 0);
  assert.throws(() => saveCreatedProject(draft(), null), /storage is unavailable/);
  const full = {
    getItem() { return '[]'; },
    setItem() { throw new Error('Quota exceeded'); },
  };
  assert.throws(() => saveCreatedProject(draft(), full), /could not save/);
});

test('invalid input never changes saved projects, and malformed old JSON can be replaced by a valid preview', () => {
  const storage = memoryStorage();
  const first = saveCreatedProject(draft(), storage);
  const before = storage.getItem(CREATED_PROJECTS_KEY);
  assert.throws(() => saveCreatedProject(draft({ name: '' }), storage), /Project name/);
  assert.equal(storage.getItem(CREATED_PROJECTS_KEY), before);
  assert.deepEqual(loadCreatedProject(first.id, storage), first);
  storage.setItem(CREATED_PROJECTS_KEY, '{bad');
  const repaired = saveCreatedProject(draft({ name: 'Repaired preview' }), storage);
  assert.deepEqual(listCreatedProjects(storage), [repaired]);
});

test('a browser that throws when accessing localStorage still returns safe reads and an explicit save error', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('Browser denied storage access'); },
  });
  try {
    assert.deepEqual(listCreatedProjects(), []);
    assert.equal(loadCreatedProject('4fdb3780-6125-4c75-8479-3655cc75f45f'), null);
    assert.throws(() => saveCreatedProject(draft()), /storage is unavailable/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});


test('creation separates unrestricted initial INCOME from opt-in ongoing Sticky rewards', () => {
  const { income, preparation } = deploymentDraft(draft());
  assert.equal(income.issuanceCutPercentAssumption, 5);
  assert.equal(income.issuanceCutPeriodMonthsAssumption, 3);
  assert.equal(income.issuanceCutDurationYearsAssumption, 2);
  assert.equal(income.numberOfIssuanceCutsAssumption, 8);
  assert.equal(income.initialAllocation.tokens, 500_000);
  assert.deepEqual(income.initialAllocation.balanceSources, ['erc20', 'unclaimed-credits']);
  assert.equal(income.initialAllocation.requiresActivation, false);
  assert.equal(income.initialAllocation.requiresStaking, false);
  assert.equal(income.initialAllocation.vestingMonths, 0);
  assert.equal(income.holderRewards.mode, 'sticky');
  assert.equal(income.holderRewards.requiresStaking, true);
  assert.equal(income.holderRewards.eligibilityPolicy, 'snapshot-share-balance');
  assert.equal(income.holderRewards.minimumStakeAgeSeconds, 0);
  assert.equal(income.holderRewards.vestingRounds, 4);
  assert.equal(income.holderRewards.roundSeconds, 604_800);
  assert.equal(Object.hasOwn(income.holderRewards, 'vestingSeconds'), false);
  assert.equal(income.holderRewards.vestingStartsAt, 'reward-claim-round');
  assert.equal(income.holderRewards.enabled, false);
  assert.equal(income.holderRewards.runtimeAvailability, 'requires-verified-deployment');
  assert.equal(Object.hasOwn(income.holderRewards, 'vestingMonths'), false);
  assert.match(income.projectionAssumption, /All FUND participates.*rewards are fully vested/);
  assert.equal(creationSummary(draft()).networkInputs.fundRewardMode, 'holders');
  assert.equal(Object.hasOwn(income, 'annualIssuanceCutPercentAssumption'), false);
  assert.equal(income.issuanceAllocationPercent.fundStakers, 10);
  assert.match(JSON.stringify(preparation), /ongoing Sticky/);
});


test('the optional revenue plan is bounded, preserved and separate from financial assumptions', () => {
  const text = 'Nightly stays and memberships.\nWeekend workshops.';
  const values = normalizeCreateDraft(draft({ revenueDescription: `  ${text}  ` })).values;
  assert.equal(values.revenueDescription, text);
  assert.equal(deploymentDraft(values).income.revenueDescription, text);
  const storage = memoryStorage();
  const entry = saveCreatedProject(values, storage);
  assert.equal(loadCreatedProject(entry.id, storage).values.revenueDescription, text);
  assert.deepEqual(creationSummary(values).networkInputs, creationSummary(draft()).networkInputs);
  assert.equal(normalizeCreateDraft(draft()).values.revenueDescription, '');
  for (const bad of [null, 123, 'a'.repeat(1001)]) {
    assert.ok(normalizeCreateDraft(draft({ revenueDescription: bad })).errors.revenueDescription);
  }
});

test('expense growth validates, compounds separately, persists and exports with legacy defaults', () => {
  for (const costGrowthPercent of [-100.01, 100.01, NaN, Infinity, null, true, '', '10%']) {
    assert.ok(normalizeCreateDraft(draft({ costGrowthPercent })).errors.costGrowthPercent);
  }
  for (const costGrowthPercent of [-100, '-2.5', 0, 10, 100]) {
    const result = normalizeCreateDraft(draft({ costGrowthPercent }));
    assert.equal(result.valid, true);
    assert.equal(result.values.costGrowthPercent, Number(costGrowthPercent));
  }
  const input = draft({ costGrowthPercent: 10, rentGrowthPercent: 0 });
  const p = projectNetwork(creationSummary(input).networkInputs, 'earning');
  assert.equal(p.history[12].lastMonthCosts, 6000);
  assert.equal(p.history[13].lastMonthCosts, 6600);
  assert.equal(p.history[25].lastMonthCosts, 7260);
  assert.equal(p.history[25].lastMonthRent, 10000);
  const storage = memoryStorage();
  const created = saveCreatedProject(input, storage);
  const loaded = loadCreatedProject(created.id, storage);
  assert.equal(loaded.values.costGrowthPercent, 10);
  assert.equal(loaded.deployment.income.annualExpenseGrowthPercentAssumption, 10);
  delete created.values.costGrowthPercent;
  storage.setItem(CREATED_PROJECTS_KEY, JSON.stringify([created]));
  assert.equal(loadCreatedProject(created.id, storage).values.costGrowthPercent, 3);
});


test('Owner authority is independent from the Operator incentive recipient', () => {
  const owner = `0x${'b2'.repeat(20)}`;
  const values = normalizeCreateDraft(draft({ ownerWallet: owner, operatorWallet: wallet })).values;
  const setup = deploymentDraft(values);
  assert.equal(setup.owner.address, owner);
  assert.equal(setup.owner.fundOwnershipPercentAfterPurchase, 20);
  assert.equal(Object.hasOwn(setup.operator, 'fundOwnershipPercentAfterPurchase'), false);
  assert.equal(setup.income.operatorAddress, wallet);
  assert.match(setup.income.operatorChangePolicy, /Owner may change the Operator at any time/);
  assert.equal(normalizeCreateDraft({ name: 'New owner', ownerWallet: owner, operatorWallet: '' }).values.revnetOperatorEnabled, true);
  assert.equal(setup.funding.ownerAddress, owner);
  assert.equal(setup.revnetOperator.address, owner);
  assert.equal(setup.operator.address, wallet);
  assert.equal(deploymentDraft(draft({ ownerWallet: '', operatorWallet: wallet })).funding.ownerAddress, null);
  assert.equal(normalizeCreateDraft({ name: 'Legacy owner', operatorWallet: wallet }).values.ownerWallet, wallet);
  for (const ownerWallet of ['0x123', `0x${'0'.repeat(40)}`, null, {}]) {
    assert.ok(normalizeCreateDraft(draft({ ownerWallet })).errors.ownerWallet);
  }
});

test('minimum revenue and written consequences persist without changing financial projections', () => {
  const consequence = 'Review three months of revenue.\nThe Owner will publish a recovery plan.';
  const configured = draft({ minimumRevenue: '5,000.25', minimumRevenueConsequences: consequence });
  const { values, networkInputs } = creationSummary(configured);
  assert.equal(values.minimumRevenue, 5000.25);
  assert.equal(values.minimumRevenueConsequences, consequence);
  assert.deepEqual(projectNetwork(networkInputs, 'earning'), projectNetwork(creationSummary(draft()).networkInputs, 'earning'));
  const storage = memoryStorage();
  const saved = saveCreatedProject(configured, storage);
  const policy = loadCreatedProject(saved.id, storage).deployment.income.minimumRevenue;
  assert.equal(policy.monthlyAmountUSD, 5000.25);
  assert.equal(policy.consequences, consequence);
  assert.match(policy.enforcement, /no automatic contract changes/);
  for (const minimumRevenue of [-1, '1.001', 'oops', Infinity]) {
    assert.ok(normalizeCreateDraft(draft({ minimumRevenue })).errors.minimumRevenue);
  }
  for (const minimumRevenueConsequences of [null, {}, 'x'.repeat(2001)]) {
    assert.ok(normalizeCreateDraft(draft({ minimumRevenueConsequences })).errors.minimumRevenueConsequences);
  }
});
