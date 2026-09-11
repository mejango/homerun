export type TransactionStage = 'create' | 'raising' | 'funded' | 'refunding' | 'refunded' | 'earning' | 'liquidated'
export type TransactionRole = 'operator' | 'fund' | 'income' | 'anyone'

export const transactionStages: { id: TransactionStage; label: string }[] = [
  { id: 'create', label: 'Create the project' },
  { id: 'raising', label: 'Raising funds' },
  { id: 'funded', label: 'Purchase and setup' },
  { id: 'refunding', label: 'Refunding' },
  { id: 'refunded', label: 'Refunds complete' },
  { id: 'earning', label: 'Earning income' },
  { id: 'liquidated', label: 'Asset sale' },
]
export const transactionRoles: { id: TransactionRole; label: string }[] = [
  { id: 'operator', label: 'Operator' },
  { id: 'fund', label: 'FUND holder' },
  { id: 'income', label: 'INCOME holder' },
  { id: 'anyone', label: 'Anyone' },
]

type TransactionEntry = {
  id: string; title: string; description: string; role: TransactionRole
  stages: readonly TransactionStage[]; setup?: boolean
}
const fundStages: readonly TransactionStage[] = ['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated']
const incomeStages: readonly TransactionStage[] = ['earning', 'liquidated']

/** An inspectable map of the site's controls, not a permission or execution quote. */
export const transactionCatalog: readonly TransactionEntry[] = [
  { id: 'create', title: 'Deploy the FUND raise', role: 'operator', stages: ['create'], description: 'Create the fundraising Juicebox. Each selected network has its own review, signature, and confirmation.' },
  { id: 'contribute', title: 'Contribute to the raise', role: 'anyone', stages: ['raising'], description: 'Approve USDC, then contribute and receive FUND. Payments must be open.' },
  { id: 'pause', title: 'Pause or resume contributions', role: 'operator', stages: ['raising', 'funded'], description: 'Queue the campaign settings that stop or restart payments. Pausing alone preserves the cash-out terms.' },
  { id: 'close', title: 'Close the raise for purchase', role: 'operator', stages: ['raising'], description: 'Stop contributions and FUND cash-outs while preparing the purchase. Confirm the change on each linked network.' },
  { id: 'fail', title: 'Open refunds after a failed raise', role: 'operator', stages: ['raising', 'funded', 'refunding'], description: 'Remove withdrawal limits and allowances, then enable zero-tax FUND cash-outs. Returning the actual money is a separate transaction.' },
  { id: 'return', title: 'Return funds to the treasury', role: 'operator', stages: ['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated'], description: 'Approve and add money to the FUND treasury without issuing new FUND. This can restore backing for refunds or sale claims.' },
  { id: 'allowance', title: 'Set or revoke a purchase allowance', role: 'operator', stages: ['funded', 'earning', 'liquidated'], description: 'Review the withdrawal amount under the next ruleset and reconcile prior spending. Asset price and cash-reserve estimates do not grant withdrawal rights.' },
  { id: 'withdraw', title: 'Withdraw for the asset purchase', role: 'operator', stages: ['funded', 'earning', 'liquidated'], description: 'With contributions and FUND cash-outs closed, use the confirmed allowance to pay a reviewed purchase recipient. Include the public purchase reference.' },
  { id: 'enable-minting', title: 'Enable success minting', role: 'operator', stages: ['funded'], description: 'After confirming the purchase, enable the permission needed to issue the agreed FUND allocations.' },
  { id: 'offchain', title: 'Issue FUND for offchain contributions', role: 'operator', stages: ['funded'], description: 'Mint a reviewed amount for a contribution already settled offchain. Offchain refunds are handled separately.' },
  { id: 'operator-share', title: 'Issue the operator’s FUND share', role: 'operator', stages: ['funded'], description: 'Review and mint the success allocation using reconciled FUND supply. Bridge balances must be accounted for.' },
  { id: 'disable-minting', title: 'Finish success minting', role: 'operator', stages: ['funded'], description: 'Disable owner minting after the contribution and operator allocations are complete.' },
  { id: 'erc20', title: 'Deploy the FUND wallet token', role: 'operator', stages: fundStages, description: 'Create the standard ERC-20 when the project does not have one. Existing FUND credits remain owned by their holders.' },
  { id: 'sticky-setup', title: 'Create the FUND staking pool', role: 'operator', stages: ['funded'], setup: true, description: 'Freeze the initial ownership snapshot, then create the stock Sticky pool on each network. Holders can later stake FUND for ongoing rewards.' },
  { id: 'income-launch', title: 'Launch INCOME', role: 'operator', stages: ['funded'], setup: true, description: 'Deploy the Revnet with the reviewed terms and fund each network’s initial claim vault. The initial allocation totals 500,000 INCOME across all networks.' },
  { id: 'sale', title: 'Open asset-sale claims', role: 'operator', stages: ['earning', 'liquidated'], description: 'Return sale proceeds to FUND, remove withdrawal limits and allowances, and enable zero-tax cash-outs. Each step is reviewed separately.' },
  { id: 'fund-credit', title: 'Claim FUND credits as wallet tokens', role: 'fund', stages: fundStages, description: 'Move your existing FUND credits into the project’s deployed ERC-20 token. This does not change your ownership amount.' },
  { id: 'fund-transfer', title: 'Transfer FUND or credits', role: 'fund', stages: fundStages, description: 'Send wallet tokens or unclaimed credits to another address.' },
  { id: 'fund-bridge', title: 'Bridge FUND', role: 'fund', stages: fundStages, description: 'Approve and prepare the transfer, relay it, then claim on the destination network. Each confirmation is tracked separately.' },
  { id: 'fund-burn', title: 'Burn FUND', role: 'fund', stages: fundStages, description: 'Permanently give up a reviewed amount of FUND without receiving money back.' },
  { id: 'fund-cashout', title: 'Cash out FUND', role: 'fund', stages: ['raising'], description: 'Exchange FUND for its quoted share of available backing under the current fundraising cash-out terms.' },
  { id: 'refund', title: 'Claim a FUND refund', role: 'fund', stages: ['refunding'], description: 'Cash out against money actually returned to the treasury. A positive quote and enabled cash-outs are required.' },
  { id: 'sale-claim', title: 'Claim asset-sale proceeds', role: 'fund', stages: ['liquidated'], description: 'Cash out FUND for available sale proceeds. Staked FUND must first be recovered from Sticky.' },
  { id: 'initial-income', title: 'Claim the initial INCOME allocation', role: 'fund', stages: incomeStages, setup: true, description: 'Snapshot beneficiaries can claim without staking, activation, or a deadline, even after transferring their FUND. Inactive balances and credits count.' },
  { id: 'stake', title: 'Stake FUND for ongoing rewards', role: 'fund', stages: incomeStages, setup: true, description: 'Claim credits if needed, approve FUND, and stake into Sticky. Your SHARE balance at each snapshot determines your share of that round.' },
  { id: 'unstake', title: 'Unstake FUND', role: 'fund', stages: incomeStages, setup: true, description: 'Cash out Sticky SHARE for the quoted FUND backing. There is no minimum staking period; historical reward claims remain separate.' },
  { id: 'vest', title: 'Start reward vesting', role: 'fund', stages: incomeStages, setup: true, description: 'Claim eligible completed rounds into stock Sticky’s four-weekly-round vesting schedule.' },
  { id: 'collect', title: 'Collect vested rewards', role: 'fund', stages: incomeStages, setup: true, description: 'Collect unlocked INCOME from your Sticky rewards. Unstaking does not erase rewards you already earned.' },
  { id: 'income-pay', title: 'Pay the INCOME project', role: 'anyone', stages: incomeStages, description: 'Pay an accepted currency and receive the quoted INCOME allocation under the current issuance terms.' },
  { id: 'reserved', title: 'Distribute reserved INCOME', role: 'anyone', stages: incomeStages, description: 'Send accrued reserved tokens to the configured operator and reward recipients. Anyone can trigger distribution and pay its transaction fee.' },
  { id: 'income-credit', title: 'Claim INCOME credits as wallet tokens', role: 'income', stages: incomeStages, description: 'Convert your existing credits into the project’s wallet token.' },
  { id: 'income-transfer', title: 'Transfer INCOME or credits', role: 'income', stages: incomeStages, description: 'Send wallet tokens or credits to another address.' },
  { id: 'income-bridge', title: 'Bridge INCOME', role: 'income', stages: incomeStages, description: 'Approve, prepare, relay, and claim through a supported project bridge.' },
  { id: 'income-burn', title: 'Burn INCOME', role: 'income', stages: incomeStages, description: 'Permanently give up INCOME without receiving its backing.' },
  { id: 'income-cashout', title: 'Cash out INCOME', role: 'income', stages: incomeStages, description: 'Exchange INCOME for its quoted backing once cash-outs are available. Your FUND holdings are unaffected.' },
  { id: 'borrow', title: 'Borrow against INCOME', role: 'income', stages: incomeStages, description: 'Review collateral, fees, and proceeds, grant the required permission, and open a Revnet loan when borrowing is available.' },
  { id: 'repay', title: 'Repay an INCOME loan', role: 'income', stages: incomeStages, description: 'Look up your loan by its ID, approve repayment funds, and repay some or all of the debt to reclaim the corresponding collateral.' },
  { id: 'refinance', title: 'Refinance an INCOME loan', role: 'income', stages: incomeStages, description: 'Borrow against additional available collateral value using the current loan quote.' },
  { id: 'transfer-loan', title: 'Transfer an INCOME loan', role: 'income', stages: incomeStages, description: 'Transfer the loan NFT and its associated position to another address.' },
  { id: 'scheduled', title: 'Collect a scheduled allocation', role: 'anyone', stages: incomeStages, description: 'Trigger a beneficiary’s auto-issuance when its configured stage allows it. Tokens go to that beneficiary. This is separate from the initial snapshot claim.' },
]
