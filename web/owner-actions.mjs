/**
 * Owner review drafts for the FH-FUND / FH-INCOME illustration.
 * These objects are NOT transactions, complete ruleset configurations, or chain
 * observations. Amounts use display dollars / token units, never ABI base units.
 * Existing and pending rulesets, addresses, permissions, timing and state must
 * be read before an owner prepares or signs a real action.
 */

const PHASES = new Set(['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated']);
const FINANCIAL_FIELDS = ['raiseGoal', 'purchaseBudget', 'opsReserve', 'escrowCash', 'precloseSpent'];
const SUPPLY_FIELDS = ['fundInvestorSupply', 'fundOperatorMint', 'fundTotalSupply'];
const BOOLEAN_FIELDS = ['operatorFundMinted', 'revenuePreminted', 'purchaseCompleted', 'saleProceedsReceived'];
const ACTIONS = Object.freeze({
  close_raise: { title: 'Close the raise', from: ['raising'], to: 'funded' },
  enable_refunds: { title: 'Enable refunds', from: ['raising', 'funded'], to: 'refunding' },
  complete_purchase: { title: 'Complete purchase and issue revenue tokens', from: ['funded'], to: 'earning' },
  enable_sale_redemptions: { title: 'Enable asset sale redemptions', from: ['earning'], to: 'liquidated' },
});

function nonnegative(field, value, max = 1e14) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new TypeError(`${field} must be a finite, nonnegative display amount no greater than ${max}.`);
  }
  return value;
}

function approximatelyEqual(left, right) {
  return Math.abs(left - right) <= Math.max(0.00001, Math.max(left, right) * Number.EPSILON * 8);
}

function validateProjection(projection) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    throw new TypeError('An economic projection is required; owner drafts cannot invent missing deal values.');
  }
  if (!PHASES.has(projection.phase)) throw new RangeError(`Unknown phase: ${String(projection.phase)}.`);
  for (const field of [...FINANCIAL_FIELDS, ...SUPPLY_FIELDS]) nonnegative(field, projection[field]);
  for (const field of ['closingCosts', 'raised']) {
    if (projection[field] !== undefined) nonnegative(field, projection[field]);
  }
  for (const field of ['revenuePremint', 'revPrice']) {
    if (projection[field] !== undefined) {
      nonnegative(field, projection[field], 1e15);
      if (field === 'revPrice' && projection[field] === 0) throw new RangeError('revPrice must be positive when supplied.');
    }
  }
  for (const field of ['issuanceCutPercent', 'operatorSplitPercent', 'ongoingOperatorSplitPercent', 'stickySplitPercent', 'personalStakePercent', 'otherStakePercent']) {
    if (projection[field] !== undefined) nonnegative(field, projection[field], 100);
  }
  if (projection.issuanceCutPercent === 100) throw new RangeError('issuanceCutPercent must be less than 100.');
  if (projection.fundRewardMode !== undefined && !['holders', 'staking'].includes(projection.fundRewardMode)) {
    throw new RangeError('fundRewardMode must be holders or staking.');
  }
  const stickyPercent = projection.stickySplitPercent;
  for (const field of ['operatorSplitPercent', 'ongoingOperatorSplitPercent']) {
    if (projection[field] !== undefined && stickyPercent !== undefined && projection[field] + stickyPercent > 100) {
      throw new RangeError(`${field} plus stickySplitPercent cannot exceed 100% of total INCOME issuance.`);
    }
  }
  if (projection.stickyVestingMonths !== undefined) {
    nonnegative('stickyVestingMonths', projection.stickyVestingMonths, 36);
    if (!Number.isInteger(projection.stickyVestingMonths)) throw new RangeError('stickyVestingMonths must be a whole model month.');
  }
  if (projection.issuanceCutYears !== undefined) {
    nonnegative('issuanceCutYears', projection.issuanceCutYears, 30);
    if (!Number.isInteger(projection.issuanceCutYears)) throw new RangeError('issuanceCutYears must be a whole number.');
  }
  if (projection.issuanceCutMonths !== undefined) {
    nonnegative('issuanceCutMonths', projection.issuanceCutMonths, 360);
    if (!Number.isInteger(projection.issuanceCutMonths) || projection.issuanceCutMonths < 1) throw new RangeError('issuanceCutMonths must be a positive whole number.');
  }
  const feePercent = projection.payoutFeePercent ?? 2.5;
  if (typeof feePercent !== 'number' || !Number.isFinite(feePercent) || feePercent < 0 || feePercent >= 100) {
    throw new RangeError('payoutFeePercent must be from zero to less than 100.');
  }
  if (projection.purchaseBudget <= 0 || projection.raiseGoal <= 0) {
    throw new RangeError('The purchase budget and raise goal must be positive.');
  }
  const percent = projection.operatorFundPercent ?? 20;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent >= 100) {
    throw new RangeError('operatorFundPercent is the post-mint operator percentage, from zero to less than 100.');
  }
  const expectedMint = projection.fundInvestorSupply * percent / (100 - percent);
  if (!approximatelyEqual(projection.fundOperatorMint, expectedMint)) {
    throw new RangeError('fundOperatorMint must match investor supply × operator percent / (100 − operator percent).');
  }
  if (!approximatelyEqual(projection.fundTotalSupply, projection.fundInvestorSupply + projection.fundOperatorMint)) {
    throw new RangeError('fundTotalSupply must include both investor supply and the planned operator mint.');
  }
  for (const field of BOOLEAN_FIELDS) {
    if (projection[field] !== undefined && typeof projection[field] !== 'boolean') {
      throw new TypeError(`${field} must be a boolean when supplied.`);
    }
  }
  if (projection.netSaleProceeds !== undefined) nonnegative('netSaleProceeds', projection.netSaleProceeds);
  if (projection.completedOwnerActions !== undefined && (
    !Array.isArray(projection.completedOwnerActions)
      || projection.completedOwnerActions.some(action => !Object.hasOwn(ACTIONS, action))
  )) throw new TypeError('completedOwnerActions must be an array of known action IDs.');
  return percent;
}

function metadata(cashOutTaxRate, allowOwnerMinting = false) {
  return { pausePay: true, cashOutTaxRate, allowOwnerMinting, reservedPercent: 0 };
}

const clearAccess = () => ({ payoutLimits: { operation: 'clear', entries: [] }, surplusAllowances: { operation: 'clear', entries: [] } });
const step = (id, title, description, patch) => ({ id, title, description, ...(patch ? { patch } : {}) });

function reservedSplits(operatorPercent, stickyPercent, fundRewardMode) {
  const rewardKey = fundRewardMode === 'staking' ? 'fundSticky' : 'fundHolders';
  const reserved = operatorPercent + stickyPercent;
  if (reserved === 0) return { denominator: 1_000_000_000, operator: 0, [rewardKey]: 0, roundingReviewRequired: true };
  const operator = Math.floor(operatorPercent / reserved * 1_000_000_000);
  return {
    denominator: 1_000_000_000,
    operator,
    [rewardKey]: 1_000_000_000 - operator,
    lockedUntil: 0,
    lockBothSplitsInEveryStage: false,
    roundingReviewRequired: true,
  };
}

function holderRewardPolicy(projection) {
  return {
    mode: 'automatic_fund_holders',
    implementationStatus: 'unimplemented_specification',
    executable: false,
    requiresStaking: false,
    createsCustodyProject: false,
    modeledVestingMonths: 0,
    token: 'FH-INCOME',
    entitlementToken: 'FH-FUND',
    percentOfTotalIssuance: projection.stickySplitPercent ?? null,
    allocation: 'proportional to current effective FUND holdings at each revenue payment',
    includesOperatorFund: true,
    includesUnclaimedFundCredits: true,
    transfersAffectFutureRewardsOnly: true,
    priorRewardsStayWithEarnedHolder: true,
    modelAssumesFixedHoldings: true,
    delivery: 'automatic; no stake or manual reward claim in the prototype',
    integration: {
      distributor: null,
      hookAddress: null,
      beneficiaryAddress: null,
      existingStickyRouteSupportsThis: false,
      requiresReview: ['transfer and token-credit accounting', 'allocation timing and replay protection', 'bounded delivery and supply conservation', 'failed delivery and rounding recovery'],
    },
  };
}

function stickyPolicy(projection) {
  return {
    project: 'separate FUND Sticky project',
    projectId: null,
    acceptedToken: 'FH-FUND',
    acceptedTokenAddress: null,
    shareToken: 'FUND Sticky SHARE ERC20',
    shareTokenAddress: null,
    stickyCashOutTaxRate: 0,
    unstakingReturnsUnderlyingFund: true,
    saleRequiresUnstakingBeforeFundRedemption: true,
    preservesExistingFundAndRentClaims: true,
    rewardRoute: {
      rewardToken: 'FH-INCOME',
      hook: 'JBTokenDistributor',
      hookAddress: null,
      splitProjectId: 0,
      beneficiary: 'FUND Sticky SHARE ERC20',
      beneficiaryAddress: null,
      notBeneficiary: ['raw FH-FUND token', 'JBStickyHook'],
    },
    eligibility: 'share ownership at each reward snapshot, not stake age',
    shortStakeCaptureResolved: false,
    productionVesting: { interval: 'weekly', rounds: 4, startsAfterMaterialization: true, requiresVerification: true },
    modeledVestingMonths: projection.stickyVestingMonths ?? null,
    modeledPersonalStakePercent: projection.personalStakePercent ?? null,
    modeledOtherStakePercent: projection.otherStakePercent ?? null,
    modelAssumesFixedParticipation: true,
    modelAutoClaimsMaturedRewards: true,
    unvestedRewardsBorrowable: false,
    operatorFundEarnsSameProRataRewards: true,
    noStakerRewards: 'model holds unallocated; eligible empty rounds may recycle next round in the actual distributor, subject to verified integration',
    pendingRewardsSurviveUnstaking: true,
    saleModelAdvancesPendingVesting: false,
  };
}

function revenuePolicy(projection) {
  const initialRate = projection.revPrice === undefined ? null : 1 / projection.revPrice;
  const stickyPercent = projection.stickySplitPercent ?? null;
  const stageFields = ['revPrice', 'issuanceCutPercent', 'issuanceCutMonths', 'issuanceCutYears', 'operatorSplitPercent', 'ongoingOperatorSplitPercent', 'stickySplitPercent'];
  const cuts = projection.issuanceCutMonths === undefined || projection.issuanceCutYears === undefined
    ? null : Math.floor(projection.issuanceCutYears * 12 / projection.issuanceCutMonths);
  const stages = [];
  if (stageFields.every(field => projection[field] !== undefined)) {
    // Relative economic months only; the deployment must review actual start
    // times and protocol units. Split changes stay on the annual boundary.
    const starts = new Set(Array.from({ length: cuts + 1 }, (_, cut) => cut * projection.issuanceCutMonths));
    if (projection.operatorSplitPercent !== projection.ongoingOperatorSplitPercent) starts.add(12);
    const months = [...starts].sort((a, b) => a - b);
    for (const [index, month] of months.entries()) {
      const operatorSplit = month < 12 ? projection.operatorSplitPercent : projection.ongoingOperatorSplitPercent;
      const totalReserved = operatorSplit + stickyPercent;
      const rate = initialRate * (1 - projection.issuanceCutPercent / 100) ** Math.min(Math.floor(month / projection.issuanceCutMonths), cuts);
      if (!(rate > 0) || !Number.isFinite(rate) || !Number.isFinite(1 / rate)) throw new RangeError('The issuance schedule exceeds the model range.');
      stages.push({
        startsAfterMonths: month,
        durationMonths: index === months.length - 1 ? null : months[index + 1] - month,
        issuanceRevPerUSDC: rate,
        issuancePriceUSDC: 1 / rate,
        operatorReservedTokenPercent: operatorSplit,
        ...(projection.fundRewardMode === 'staking' ? { fundStickyTokenPercent: stickyPercent } : { fundHolderTokenPercent: stickyPercent }),
        totalReservedTokenPercent: totalReserved,
        nativeSplitPercent: approximatelyEqual(totalReserved * 100, Math.round(totalReserved * 100)) ? Math.round(totalReserved * 100) : null,
        reservedSplitGroup: reservedSplits(operatorSplit, stickyPercent, projection.fundRewardMode),
        renterIssuedTokenPercent: 100 - totalReserved,
      });
    }
  }
  return {
    totalInitialPremint: projection.revenuePremint ?? null,
    initialIssuancePriceUSDC: projection.revPrice ?? null,
    initialIssuanceRevPerUSDC: initialRate,
    issuanceCutPercent: projection.issuanceCutPercent ?? null,
    issuanceCutMonths: projection.issuanceCutMonths ?? null,
    issuanceCutYears: projection.issuanceCutYears ?? null,
    numberOfIssuanceCuts: cuts,
    issuanceAfterLastCut: 'flat',
    firstYearOperatorReservedTokenPercent: projection.operatorSplitPercent ?? null,
    laterOperatorReservedTokenPercent: projection.ongoingOperatorSplitPercent ?? null,
    ...(projection.fundRewardMode === 'staking' ? { fundStickyPercentOfTotalIssuance: stickyPercent } : { fundHolderPercentOfTotalIssuance: stickyPercent }),
    additionalOperatorPremint: 0,
    materializeAllAutoIssuancesBeforeFundingOrLoans: true,
    atomicRevnetLaunchAndPremintRequired: projection.revenuePremint !== 0,
    claimsTransferAlreadyMintedTokens: projection.revenuePremint !== 0,
    tokenClassesHaveEqualPerTokenEconomics: true,
    premintIsSeniorWaterfall: false,
    stages,
  };
}

/**
 * Prepare a deterministic, JSON-serializable review draft without mutating the
 * projection. `eligible` only means the supplied illustration passes the listed
 * guards; `executable` is ALWAYS false, even if a caller supplies addresses.
 * fundOperatorMint / fundTotalSupply are PLANNED post-success amounts in all
 * phases; they never assert that a real mint has happened.
 */
export function ownerActionDraft(action, projection) {
  if (!Object.hasOwn(ACTIONS, action)) throw new RangeError(`Unknown owner action: ${String(action)}.`);
  const operatorPercent = validateProjection(projection);
  const actionInfo = ACTIONS[action];
  const payoutFeePercent = projection.payoutFeePercent ?? 2.5;
  const closingCosts = projection.closingCosts ?? 0;
  const netClosingBudget = projection.purchaseBudget + projection.opsReserve + closingCosts;
  // Conservative cents for a review screen. Execution must quote actual USDC
  // base units and actual fee exemptions; this is not a contract fee quote.
  const grossClosingBudget = Math.ceil(netClosingBudget / (1 - payoutFeePercent / 100) * 100) / 100;
  nonnegative('grossClosingBudget', grossClosingBudget);
  const draft = {
    id: action,
    title: actionInfo.title,
    description: '',
    executable: false,
    eligible: true,
    patchOnly: true,
    source: 'illustrative_projection',
    fromPhase: projection.phase,
    toPhase: actionInfo.to,
    units: { money: 'display USDC, not ABI base units', tokens: 'display FH-FUND units, not ABI base units' },
    budget: {
      purchaseBudget: projection.purchaseBudget,
      opsReserve: projection.opsReserve,
      closingCosts,
      netClosingBudget,
      grossClosingBudget,
      assumedProtocolFeePercent: payoutFeePercent,
      escrowCash: projection.escrowCash,
      precloseSpent: projection.precloseSpent,
    },
    steps: [],
    changes: {},
    blockedReasons: [],
    warnings: [
      'This is a review draft. It neither changes a ruleset nor signs, submits or schedules a transaction.',
      'Owner-controlled rulesets can later be changed again. These field patches do not enforce an irreversible mint cap or one-time allocation.',
    ],
    requiresVerification: [
      'Read the real chain ID, FH-FUND project ID, current controller, terminal, USDC accounting context, owner and delegated permissions.',
      'Read current AND pending rulesets, durations, approval hooks, payout limits, allowances, splits, data hooks and mint permissions. Determine when each change can actually activate.',
      'Merge these field patches into the complete reviewed configuration; preserve unrelated fields and resolve addresses, currency IDs and base-unit amounts before preparing calldata.',
    ],
  };

  if (!actionInfo.from.includes(projection.phase)) {
    draft.blockedReasons.push(`${actionInfo.title} requires phase ${actionInfo.from.join(' or ')}; current phase is ${projection.phase}.`);
  }
  if (projection.fundInvestorSupply === 0) draft.blockedReasons.push('No investor FUND units are present in this projection.');
  const completed = new Set(projection.completedOwnerActions ?? []);
  if (completed.has(action)) draft.blockedReasons.push('This action is already recorded as completed.');
  const conflictingHistory = {
    close_raise: ['enable_refunds', 'complete_purchase', 'enable_sale_redemptions'],
    enable_refunds: ['complete_purchase', 'enable_sale_redemptions'],
    complete_purchase: ['enable_refunds', 'enable_sale_redemptions'],
    enable_sale_redemptions: ['enable_refunds'],
  };
  if (conflictingHistory[action].some(id => completed.has(id))) {
    draft.blockedReasons.push('Recorded action history conflicts with this transition; reconcile the current phase before continuing.');
  }
  if (action === 'close_raise' && BOOLEAN_FIELDS.slice(0, 3).some(field => projection[field] === true)) {
    draft.blockedReasons.push('A success-only action is already recorded; do not close the raise again.');
  }
  if (action === 'close_raise' || action === 'complete_purchase') {
    if (projection.escrowCash + 0.000001 < grossClosingBudget) {
      draft.blockedReasons.push('Current escrow cash cannot cover the purchase plus operating reserve after the assumed payout fee.');
    }
    if (projection.raiseGoal + 0.000001 < grossClosingBudget + projection.precloseSpent) {
      draft.blockedReasons.push('The configured raise goal does not cover both prior gross spending and the gross closing budget.');
    }
    if (projection.raised !== undefined && projection.raised + 0.000001 < projection.raiseGoal) {
      draft.blockedReasons.push('The recorded amount raised is below the stated raise goal.');
    }
    draft.requiresVerification.push('Verify current spendable USDC after investor exits and already-paid expenses, not historical contribution volume. Preclose spending is already absent from escrowCash; do not subtract it twice.');
    draft.requiresVerification.push('Verify the stated gross raise goal was collected, including previously spent gross fundraising expenses, separately from the remaining cash needed at closing.');
  }

  if (action === 'close_raise') {
    draft.description = 'Prepare owner changes that stop new subscriptions and commit the remaining cash to the proposed purchase. The asset has not been purchased.';
    draft.changes = {
      fundRulesetMetadata: metadata(10_000),
      fundAccess: { purchaseReservation: { operation: 'replace_all_reviewed_payout_limits', grossDisplayUSDC: grossClosingBudget }, surplusAllowances: { operation: 'clear', entries: [] } },
      operatorFundMint: 0,
      revenuePremint: 0,
      releasesPurchaseCash: false,
    };
    draft.steps = [
      step('verify_closing_budget', 'Verify the funds and commitment', 'Confirm the purchase terms, remaining cash, fee budget and operating reserve before committing to a closing.'),
      step('queue_commitment', 'Queue the committed-closing ruleset', 'Pause payments and set the cash-out tax to 10000/10000. Replace existing payout limits with the reviewed gross closing reservation; do not add it on top of a prior operating reservation. Remove surplus-withdrawal allowances.', { rulesetMetadata: metadata(10_000), fundAccess: draft.changes.fundAccess }),
      step('verify_activation', 'Wait for activation and recheck balances', 'Confirm the ruleset is active and the full cash remains available before signing an off-chain purchase commitment. This draft performs no purchase payout.'),
    ];
    draft.warnings.push('A 100% cash-out tax returns zero; core can still burn tokens when the caller accepts zero output. This is not a reverting cash-out pause.');
    draft.warnings.push('Changing rulesets and committing an asset purchase are separate actions. Exits before activation can leave the closing underfunded.');
  }

  if (action === 'enable_refunds') {
    draft.description = 'Prepare proportional redemption of the cash still held for FH-FUND holders. No operator FUND mint or revenue allocation happens on this failure path.';
    draft.changes = {
      fundRulesetMetadata: metadata(0),
      fundAccess: clearAccess(),
      availableRefundCash: projection.escrowCash,
      operatorFundMint: 0,
      revenuePremint: 0,
    };
    if (projection.purchaseCompleted === true || projection.operatorFundMinted === true || projection.revenuePreminted === true) {
      draft.blockedReasons.push('The supplied state already records a purchase or success-only mint; it cannot use the failed-raise refund path.');
    }
    draft.steps = [
      step('recover_unspent_cash', 'Verify remaining cash', 'Confirm the purchase did not complete and recover any refundable closing-agent funds into the FH-FUND terminal before quoting redemptions.'),
      step('queue_refunds', 'Queue zero-tax redemption', 'Pause new payments, disable owner minting, set zero reserved issuance and cash-out tax, and remove ALL unused payout limits and surplus allowances.', { rulesetMetadata: metadata(0), fundAccess: clearAccess() }),
      step('verify_refund_quotes', 'Verify activation and holder quotes', 'Use the remaining effective FUND supply, including token credits, and net terminal fees. Each holder burns FUND for their current share of the remaining cash.'),
    ];
    draft.requiresVerification.push('Confirm no operator FUND mint, revenue premint or completed purchase exists, including pending or externally executed actions.');
    draft.warnings.push('A zero cash-out tax distributes remaining surplus proportionally; it does not restore each original subscription amount. Expenses, earlier exits and token transfers affect recovery.');
    draft.warnings.push('Unused payout limits reserve cash away from redemptions. Zero tax may still incur protocol fees on qualifying fee-free intra-terminal inflows.');
  }

  if (action === 'complete_purchase') {
    const holderRewards = projection.fundRewardMode !== 'staking';
    draft.description = 'Prepare the purchase, success-only operator FUND mint, final FUND supply review and one revenue allocation. FH-FUND remains the asset claim and is not burned to receive FH-INCOME.';
    if (projection.operatorFundMinted === true || projection.revenuePreminted === true || projection.purchaseCompleted === true) {
      draft.blockedReasons.push('A purchase or success-only mint is already recorded. Reconcile completed transactions before preparing a continuation; do not repeat this full sequence.');
    }
    draft.changes = {
      fundRulesetMetadata: metadata(10_000),
      operatorFundMint: projection.fundOperatorMint,
      operatorPostMintPercent: operatorPercent,
      finalFundSupply: projection.fundTotalSupply,
      revenuePolicy: revenuePolicy(projection),
      ...(holderRewards ? { fundHolderRewards: holderRewardPolicy(projection) } : { fundSticky: stickyPolicy(projection) }),
      revenueAllocation: {
        source: 'all FH-FUND beneficial holders at one finalized post-operator-mint snapshot',
        includesOperatorFund: true,
        includesUnclaimedFundCredits: true,
        fundTokensBurned: 0,
        allocation: 'proportional to snapshot FUND units',
        totalRevenuePremint: projection.revenuePremint ?? null,
        skipInitialPremint: projection.revenuePremint === 0,
        operatorShareOfPremintPercent: operatorPercent,
        additionalOperatorRevPremint: 0,
        snapshot: null,
        repeatAllocationAllowed: false,
      },
    };
    draft.steps = [
      step('verify_committed_state', 'Verify the committed-closing state', 'Confirm payments are paused, purchase cash is reserved, current supply matches the investor ledger and no success-only mint or revenue allocation has already happened.'),
      step('purchase_and_reserve', 'Complete purchase and fund operations', 'Send the reviewed payout to the verified closing recipient and operating account, then obtain purchase completion evidence. FH-FUND continues as the asset claim.'),
    ];
    if (projection.fundOperatorMint > 0) {
      draft.steps.push(
        step('enable_operator_mint', 'Temporarily enable owner minting', 'After verified success, queue and wait for a ruleset that permits the one planned owner mint. Keep payments paused, reserved issuance zero and asset cash-outs at 100% tax.', { rulesetMetadata: metadata(10_000, true) }),
        step('mint_operator_fund', 'Mint the disclosed operator FUND allocation', 'Verify the final investor supply again. Mint the reviewed count to the verified operator beneficiary without reserved issuance. This step is a mint intent, not complete mintTokensOf calldata.', { mintIntent: { project: 'FH-FUND', displayTokenCount: projection.fundOperatorMint, useReservedPercent: false, beneficiary: null } }),
      );
    }
    draft.steps.push(
      step('freeze_fund_issuance', 'Disable owner minting and check every mint path', 'Queue and wait for allowOwnerMinting=false. Verify no pending reserve, autoissuance, mint-capable hook or additional terminal can change supply.', { rulesetMetadata: metadata(10_000) }),
      step('snapshot_all_fund', 'Finalize one complete FUND snapshot', 'Record one finalized block after the operator mint and issuance freeze, before enabling revenue payments. Include all investor and operator FUND and credits. Resolve any wrappers or custodians to beneficial holders without counting both FUND and receipts. The initial INCOME allocation happens once; later transfers only affect future holder rewards.'),
      ...(holderRewards ? [
        step('specify_holder_distribution', 'Review automatic FUND holder rewards', 'Specify automatic pro-rata delivery to current FUND holders, including operators and token credits, on each revenue payment. No FUND staking or custody project is required. The distributor is not implemented by this prototype; the existing Sticky route must not be substituted as if it tracks freely held FUND.', { fundHolderRewards: draft.changes.fundHolderRewards }),
        step('configure_holder_reward_route', 'Review and lock the holder reward allocation', 'Specify the operations and holder destinations for every issuance stage. At 75% operations and 15% to FUND holders, reserve 90% and split that reserve 75/90 and 15/90; the remaining 10% goes to customers. Lock both reviewed destinations in every stage. Verify transfer accounting, automatic delivery, replay protection and rounding before preparing a real deployment.', { fundHolderRewards: draft.changes.fundHolderRewards, revenuePolicy: draft.changes.revenuePolicy }),
      ] : [
        step('prepare_fund_sticky', 'Prepare the separate FUND Sticky project', 'Create or verify the third project accepting FH-FUND and its deployed SHARE ERC20. Review zero-tax underlying FUND recovery and all custody paths. This project wraps FUND; it neither buys the asset nor replaces the closing INCOME premint.', { fundSticky: draft.changes.fundSticky }),
        step('configure_sticky_reward_route', 'Route the ongoing FUND-staker allocation', 'Configure the reviewed total reserved issuance and split it between operations and FUND stakers. At 75% operations plus 15% for stakers, reserve 90%; split that reserve 75/90 and 15/90 with reviewed integer rounding. The remaining 10% of total issuance goes to customers. Leave every split unlocked so the Owner can change recipients and allocations. The reward split hook is JBTokenDistributor and its beneficiary is the FUND Sticky SHARE ERC20, never raw FUND or JBStickyHook.', { rewardRoute: draft.changes.fundSticky.rewardRoute, revenuePolicy: draft.changes.revenuePolicy }),
      ]),
      step('premint_revenue_once', projection.revenuePremint === 0 ? 'Launch INCOME without an initial allocation' : 'Launch INCOME and fully mint its allocation together', projection.revenuePremint === 0
        ? 'This comparison sets the initial premint to zero. Skip autoIssueFor and all initial-allocation claims; launch the reviewed INCOME network with no pending free autoissuance. Ongoing FUND rewards remain separately configured. No FUND is burned.'
        : 'Use a reviewed atomic launch-and-mint transaction to deploy FH-INCOME and execute autoIssueFor for the entire snapshot allocation. Do not leave a live Revnet between deployment and its free premint. Verify all unclaimed allocations exist in effective INCOME supply before other payments or loans. Claims transfer already-minted INCOME without burning FUND; enforce allocation replay protection. The operator participates through its FUND snapshot share, with no extra operator INCOME premint.', { revenueAllocation: draft.changes.revenueAllocation, revenuePolicy: draft.changes.revenuePolicy }),
    );
    draft.requiresVerification.push('Read the actual pre-mint investor supply, existing operator issuance, reserved balances and prior revenue allocations; planned projection counts are not chain state.');
    draft.requiresVerification.push('Confirm the operator beneficiary, FH-INCOME project and total premint, finalized snapshot block/hash, allocation record and replay-protection mechanism. These missing values are deliberately not fabricated.');
    draft.requiresVerification.push(projection.revenuePremint === 0
      ? 'Translate the reviewed revenue schedule into protocol units and confirm the zero-premint launch has no pending autoissuance or initial allocation claims.'
      : 'Translate the reviewed relative revenue schedule into actual stage start times and protocol units. Verify an atomic deploy-and-autoIssueFor executor or batch; this review draft does not implement it. Full initial issuance must complete before another transaction can pay or borrow.');
    if (holderRewards) {
      draft.requiresVerification.push('Implement and verify a distributor for current FUND holders and token credits before deployment. No compatible automatic holder distributor, hook address or beneficiary has been provided by this preview. Review transfer ordering, custody accounting, bounded automatic delivery, replay protection and rounding; a single closing snapshot cannot determine future reward recipients.');
    } else {
      draft.requiresVerification.push('Verify the third Sticky project, accepted FUND token, deployed SHARE ERC20, JBTokenDistributor registration and split destination. Review reserved-token rounding and dust; 75/90 and 15/90 are not exactly representable in the 1e9 split denominator.');
      draft.requiresVerification.push('Verify weekly reward snapshots, four-round vesting after materialization, pending-claim survival on unstaking, automatic-claim opt-in and unallocated-reward handling. The model uses a monthly vesting approximation and fixed staking participation.');
    }
    draft.requiresVerification.push('Verify recipient balances and end-to-end reward allocation, not only successful parent transactions. A failed reserved-token hook can leave its unconsumed reward tokens burned while the parent payment or distribution succeeds.');
    draft.warnings.push('The operator percentage is of the post-mint supply. Its new FUND participates in asset-sale proceeds and the one revenue snapshot, diluting the investors proportionally.');
    draft.warnings.push('Temporarily enabling owner minting creates an owner-controlled mint window. Queueing, minting, freezing and snapshotting are not automatically atomic or one-time.');
    draft.warnings.push('Standard FH-FUND ERC20 transfers can continue. Ownership at the disclosed finalized snapshot determines the initial FH-INCOME allocation; later FUND transfers do not repeat that initial allocation.');
    draft.warnings.push('Revenue stage percentages split newly issued INCOME tokens, not cash revenue. The quoted issuance price is not a cash-out floor or guaranteed redemption price.');
    draft.warnings.push('The closing premint gives an early ownership share, not senior repayment priority. Investors also finance the startup operating reserve; operators can use their available FUND rewards as well as their other INCOME for expenses.');
    if (holderRewards) {
      draft.warnings.push('Automatic holder rewards are an unimplemented integration specification. The model assumes fixed FUND holdings and immediate delivery; it does not prove live transfer accounting or distribution correctness.');
    } else {
      draft.warnings.push('Sticky eligibility uses a reward snapshot, not how long FUND has been staked. Short-duration stake capture is unresolved. Unvested INCOME cannot be cashed out or borrowed.');
      draft.warnings.push('With no stakers, the model leaves the Sticky slice unallocated. It does not give that pot to another class or assume an unimplemented recycling route.');
    }
  }

  if (action === 'enable_sale_redemptions') {
    const holderRewards = projection.fundRewardMode !== 'staking';
    draft.description = 'Prepare FH-FUND redemption against verified net asset-sale proceeds. Existing FH-INCOME tokens and any revenue-token loans remain separate.';
    draft.changes = {
      fundRulesetMetadata: metadata(0),
      fundAccess: clearAccess(),
      saleDeposit: { method: 'addToBalanceOf', netDisplayUSDC: projection.netSaleProceeds ?? null, mintsFund: false },
      revenuePremint: 0,
      operatorFundMint: 0,
      ...(holderRewards ? { fundHolderRewards: holderRewardPolicy(projection) } : { fundSticky: stickyPolicy(projection) }),
    };
    if (projection.saleProceedsReceived === false) draft.blockedReasons.push('The supplied state says sale proceeds have not been received.');
    draft.steps = [
      step('verify_net_sale_cash', 'Verify the completed sale and net cash', 'Confirm the sale has settled. Reconcile taxes, senior claims, selling costs and all fees; do not use an appraisal or sale listing as cash.'),
      step('fund_sale_redemptions', 'Credit sale cash to FH-FUND', 'Deposit any verified sale proceeds not already credited with addToBalanceOf, not pay, so the deposit issues no new FUND. Reconcile prior deposits to prevent a duplicate transfer.', { saleDeposit: draft.changes.saleDeposit }),
      step('queue_sale_redemptions', 'Queue zero-tax FUND redemption', 'Keep payments and owner minting disabled. Set cash-out tax to zero and clear ALL unused payout limits and surplus allowances.', { rulesetMetadata: metadata(0), fundAccess: clearAccess() }),
      ...(holderRewards ? [] : [step('prepare_holder_unstaking', 'Explain the two holder redemptions', 'A staker first unstakes Sticky SHARE for its underlying FUND, then redeems FUND against the asset-sale cash. Confirm this recovery path before inviting holders to exit; the owner draft cannot unstick another holder on their behalf.', { fundSticky: draft.changes.fundSticky })]),
      step('verify_sale_quotes', 'Verify activation and net quotes', 'Check the actual terminal cash, current effective FUND supply and applicable fees. The current holder burns FUND to claim their proportional sale cash; leave the separately issued FH-INCOME allocation unchanged.'),
    ];
    draft.requiresVerification.push('Verify the completed asset sale, actual netSaleProceeds, current terminal cash and which proceeds have already been deposited.');
    draft.warnings.push('Sale recovery is proportional to current FUND ownership, including operator FUND. A sale does not guarantee recovery of original principal.');
    draft.warnings.push('Zero cash-out tax does not remove unused payout reservations or every protocol fee. Never quote sale recovery from gross asset value.');
    draft.warnings.push(holderRewards
      ? 'Existing INCOME and earned holder rewards stay separate from sale cash. FUND holders redeem directly; no unstaking is required.'
      : 'Existing INCOME and earned pending Sticky claims stay separate from sale cash. Pending claims may vest after unstaking; this sale view does not advance time to claim them.');
  }

  draft.eligible = draft.blockedReasons.length === 0;
  return draft;
}

/** Current Homerun policy for UI review drafts. Legacy comparison modes above
 * remain available to model historical scenarios without changing their math.
 */
export function plannedOwnerActionDraft(action, projection) {
  const draft = ownerActionDraft(action, { ...projection, fundRewardMode: 'holders' });
  if (!['complete_purchase', 'enable_sale_redemptions'].includes(action)) return draft;

  const fundSticky = {
    mode: 'sticky',
    acceptedToken: 'FUND',
    projectId: null,
    requiresStaking: true,
    eligibilityPolicy: 'snapshot-share-balance',
    minimumStakeAgeSeconds: 0,
    vestingRounds: 4,
    roundSeconds: 604_800,
    vestingStartsAt: 'reward-claim-round',
    eligibility: 'Stock Sticky rewards are proportional to share balances at each snapshot. There is no stake-age boost; longer participation earns additional rounds.',
    runtimeAvailability: 'requires-verified-deployment',
    enabled: false,
    executable: false,
    projectionAssumption: 'All FUND participates in Sticky and rewards are fully vested. The four weekly vesting rounds after reward claims are not modeled.',
  };
  delete draft.changes.fundHolderRewards;
  draft.changes.fundSticky = fundSticky;
  draft.requiresVerification = draft.requiresVerification.filter(item => !item.startsWith('Implement and verify a distributor for current FUND holders'));
  draft.warnings = draft.warnings.filter(item => !item.startsWith('Automatic holder rewards') && !item.includes('no unstaking is required'));
  draft.requiresVerification.push('Verify the stock Sticky deployment, proportional share-balance snapshots, reward claim and four weekly vesting rounds starting from the claim round, custody recovery and reward routing. There is no minimum staking period or stake-age boost; longer participation earns additional reward rounds. Initial INCOME has no vesting.');
  draft.warnings.push('Ongoing rewards require opting into Sticky staking. These projections assume all FUND participates and ongoing rewards are fully vested; they do not model the four weekly vesting rounds after reward claims. The initial INCOME allocation is independent of Sticky.');

  if (action === 'complete_purchase') {
    const policy = revenuePolicy({ ...projection, fundRewardMode: 'staking' });
    draft.changes.revenuePolicy = policy;
    Object.assign(draft.changes.revenueAllocation, {
      source: 'all FUND holders at one finalized post-operator-mint snapshot, including inactive ERC20 balances and unclaimed token credits',
      requiresActivation: false,
      requiresStaking: false,
      vestingMonths: 0,
    });
    draft.steps = draft.steps.map(item => {
      if (item.id === 'snapshot_all_fund') return step(item.id, item.title,
        'Finalize all investor and operator FUND balances after the success mint, including inactive ERC20 balances and unclaimed token credits. Resolve beneficial holders without double-counting custody receipts. Initial INCOME claims require no activation, staking or vesting. Later transfers do not repeat this initial allocation.',
        { revenueAllocation: draft.changes.revenueAllocation });
      if (item.id === 'specify_holder_distribution') return step('prepare_fund_sticky', 'Review opt-in Sticky participation',
        'Prepare the verified stock Sticky integration for ongoing rewards. Use proportional share-balance snapshots and four weekly vesting rounds starting from the reward-claim round. There is no minimum staking period or age-based weight boost. Keep the initial-allocation mechanism separate: every initial FUND snapshot holder can claim without staking or vesting.', { fundSticky });
      if (item.id === 'configure_holder_reward_route') return step('configure_sticky_reward_route', 'Review the ongoing FUND-staker allocation',
        'Route the reviewed ongoing INCOME allocation to eligible Sticky participants. Verify the deployed reward destination, permissions, reserved splits, rounding and every issuance stage. Verify ongoing rewards unlock over four weekly vesting rounds starting from the reward-claim round, not the FUND deposit. Each round is 604,800 seconds; 25% unlocks at each following boundary, so full release takes 21–28 elapsed days after materialization. Execution remains unavailable until the stock Sticky deployment is verified.',
        { fundSticky, revenuePolicy: policy });
      if (item.id === 'premint_revenue_once') return step(item.id, item.title,
        `${item.description} The initial allocation covers inactive ERC20 balances and unclaimed FUND credits, without activation, staking or vesting.`,
        { revenueAllocation: draft.changes.revenueAllocation, revenuePolicy: policy });
      return item;
    });
  } else {
    const index = draft.steps.findIndex(item => item.id === 'verify_sale_quotes');
    draft.steps.splice(index < 0 ? draft.steps.length : index, 0,
      step('prepare_holder_unstaking', 'Review recovery of staked FUND',
        'Verify how a Sticky participant recovers their underlying FUND before redeeming asset-sale proceeds. Initial INCOME and ongoing reward claims remain separate; confirm each claim against its actual contract state and stock Sticky snapshot and reward-vesting policy.', { fundSticky }));
    draft.warnings.push('FUND held directly can be redeemed against sale cash. A Sticky participant must first recover the underlying FUND using the verified unstaking path; the owner cannot perform a holder action without the required authorization.');
  }
  return draft;
}
