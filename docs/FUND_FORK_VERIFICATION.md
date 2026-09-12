# FUND contract fork verification

`scripts/verify-fund-fork.mts` exercises the application’s FUND builders, pinned
project-state reader, launch receipt verifier, transaction simulation, and SDK
payment/cash-out preparation against deployed Ethereum Juicebox V6 contracts.

The run at Ethereum block **25,962,537** passed **29 local transactions**. Its
temporary FUND project was **11**. All receipts succeeded and resulting treasury,
ruleset, ownership, supply, credit and ERC20 balances were checked through RPC.

| Path | Verified behavior |
| --- | --- |
| Create | The SDK deployment, creation fee and USDC price feed were checked; the exact launch call, receipt events and resulting FUND settings matched. |
| Read | Both standard terminals were recognized while the router was excluded from treasury totals. The owner had operator permissions and a holder did not. |
| Contribute | An exact 1,000 USDC approval preceded payment with a fresh, positive SDK minimum FUND return. |
| Campaign | Pause, resume and close changed the active onchain ruleset. |
| Asset purchase | An explicit 400 USDC allowance was configured, quoted, spent with protected net proceeds, and explicitly revoked. Modeling estimates supplied no allowance. |
| Success | An offchain contribution received FUND, the operator received the calculated 20% post-mint share, and owner minting was disabled again. |
| Holder tokens | Unstaked credits were transferred, vanilla FUND ERC20 was deployed, credits were claimed, and ERC20 tokens were transferred. |
| Asset sale | `addToBalanceOf` returned 600 USDC without minting FUND. Zero-tax cash-outs returned the resulting 1,200 USDC treasury to the three holders, including mixed credits/ERC20 holdings and the operator. |
| Failure | A separate restored branch enabled zero-tax refunds, added 50 USDC without minting FUND, and returned the full 1,050 USDC treasury to the contributor holding unstaked credits. |

The script restores its initial snapshot in `finally`. It accepts no configurable
write endpoint: every write verifies the literal `http://127.0.0.1:8647` transport,
Ethereum chain ID, and `anvil_nodeInfo`. Local impersonation funds test fixtures
from the fork’s USDC reserve copy. No private keys or real funds are used.

To repeat, start Anvil in one terminal:

```sh
anvil --host 127.0.0.1 --port 8647 --chain-id 1 \
  --fork-url https://juicebox.center/v1/rpc/1 \
  --fork-header 'Origin: https://homerun.money' --timeout 120000
```

Then, from the Homerun repository:

```sh
node --import tsx scripts/verify-fund-fork.mts
```

The script prints each confirmed local transaction and a final JSON report with
block, hash and gas usage. These hashes describe discarded local fork branches,
not transactions submitted to Ethereum. The fork head and temporary project ID
may differ in later runs.

This check covers a single-chain FUND lifecycle. It does not establish browser
wallet or Safe execution behavior, cross-chain execution, INCOME deployment, or
reward-distributor correctness; those require their own integration checks.
