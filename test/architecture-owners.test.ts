import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Source boundaries complement the protocol tests. Product routing, journals,
// review display, and polling timeouts remain application adapters.
const root = process.cwd()
const core = '@bananapus/nana-sdk-core'
type Owner = { file: string; module: string; calls?: readonly string[]; exports?: readonly string[] }
const owners: readonly Owner[] = [
  { file: 'lib/jbcenter-rpc.ts', module: `${core}/jbcenter`, calls: ['createJBCenterRpcProvider', 'createPacedJBCenterLimiter'] },
  { file: 'lib/contract-write.ts', module: `${core}/review`, calls: ['submitReviewedContractWrite'] },
  { file: 'lib/transaction-review.ts', module: `${core}/review`, calls: ['buildTransactionDebugPrompt', 'buildTransactionReviewPrompt'],
    exports: ['requireTransactionReview', 'requestContractTransactionReview', 'registerTransactionReviewHandler', 'requireFundingChainSelection'] },
  { file: 'lib/readable-error.ts', module: `${core}/review`, calls: ['transactionMessage'] },
  { file: 'hooks/useSafeTx.ts', module: `${core}/review`, calls: ['transactionMessage', 'waitForTrackedReceipt', 'gasWithHeadroom'] },
  { file: 'lib/safe-connector.ts', module: `${core}/safe-service`, calls: ['isSafeWalletPeer', 'waitForSafeExecutionHash'],
    exports: ['heldCall', 'readSafeAppExecution', 'findPendingSafeAppProposal', 'watchSafeProposal', 'atOnceExecution', 'reportedSafeExecution'] },
  { file: 'lib/sticky-session.ts', module: `${core}/safe-service`, calls: ['heldCall', 'safeExecutionRunsCalls', 'safeExecutionResult'] },
  { file: 'lib/project-payers.ts', module: `${core}/safe-service`, calls: ['safeExecutionRunsCalls', 'safeExecutionResult'] },
  ...['fund-launch-verification', 'income-reserved', 'income-operator', 'fund-bridge-receipts'].map(name => ({
    file: `lib/${name}.ts`, module: `${core}/safe-service`, calls: ['safeExecutionRunsCalls', 'requireSafeExecutionSuccess'],
  })),
  { file: 'lib/relayr.ts', module: `${core}/review/relayr`, calls: ['bindRelayrQuote', 'relayrDestinationRecords', 'relayrProgress', 'relayrStateIsSuccess', 'relayrWalletPaymentError', 'requireRelayrRetry', 'requireRelayrPaymentRuntime', 'simulateRelayrPayment', 'verifyRelayrPayment'] },
  { file: 'lib/fund-launch-relayr.ts', module: `${core}/review/relayr`, calls: ['relayrSessionOutcome', 'relayrRequestsVerdict', 'relayrRetryOption', 'proveSavedRelayrPayment', 'verifyRelayrDestination'] },
  { file: 'components/ProjectActivity.tsx', module: core, calls: ['mergeCrossChainActivityGroups'] },
]

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '')
}
function source(file: string): string { return withoutComments(readFileSync(resolve(root, 'src', file), 'utf8')) }
function namedBindings(text: string) {
  const declarations = /\b(import|export)\s+(?:type\s+)?\{([^{}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  return [...text.matchAll(declarations)].flatMap(([, kind, members, module]) => members.split(',').flatMap(member => {
    const match = member.trim().match(/^(?!type\s)(\w+)(?:\s+as\s+(\w+))?$/)
    return match ? [{ kind, module, imported: match[1], local: match[2] ?? match[1] }] : []
  }))
}
function ownershipFailures(owner: Owner, text: string): string[] {
  const bindings = namedBindings(text), failures: string[] = []
  for (const name of owner.calls ?? []) {
    const binding = bindings.find(item => item.kind === 'import' && item.module === owner.module && item.imported === name)
    if (!binding || !new RegExp(`\\b${binding.local}\\s*(?:<[^;{}]*>)?\\(`).test(text))
      failures.push(`${owner.file} must call ${owner.module}:${name} through its SDK import`)
  }
  for (const name of owner.exports ?? []) {
    if (!bindings.some(item => item.kind === 'export' && item.module === owner.module && item.imported === name))
      failures.push(`${owner.file} must re-export ${owner.module}:${name}`)
  }
  return failures
}

// These already have shared SDK owners. Thin adapters with their own identity
// (such as submitReviewedContractWrite and relayrDestinationRecords) are checked
// above by their SDK calls, rather than forbidden merely for sharing a name.
const sharedRules = [
  'createPacedJBCenterLimiter', 'createJBCenterLimiter', 'createJBCenterRpcProvider',
  'errorChain', 'isRateLimited', 'retryAfterOf', 'transactionMessage',
  'heldCall', 'stampedArgs', 'stampedDeadline', 'safeExecutionResult',
  'safeExecutionRunsCalls', 'safeTransactionRunsCalls', 'requireSafeExecutionSuccess',
  'readSafeAppExecution', 'findPendingSafeAppProposal', 'reportedSafeExecution', 'atOnceExecution',
  'bindRelayrQuote', 'requireRelayrRetry', 'requireRelayrPaymentRuntime',
  'relayrProgress', 'relayrStateIsSuccess', 'relayrStateIsFailed', 'relayrStateIsPending',
  'relayrSessionOutcome', 'relayrRequestsVerdict', 'relayrRetryOption', 'relayrWalletPaymentError',
  'matchingDestinationRecords', 'requireUniqueDestinationHashes',
  'proveSavedRelayrPayment', 'verifyRelayrPayment', 'verifyRelayrDestination',
  'mergeCrossChainActivityGroups',
  'RPC_START_INTERVAL_MS', 'STAMPED_CALLS', 'JBCENTER_MAX_RATE_LIMIT_PAUSE_MS',
  'CROSS_CHAIN_MERGE_WINDOW', 'SAFE_EXEC_ABI', 'SAFE_PREFIX', 'SAFE_SERVICE_PREFIX',
  'FORWARD_REQUEST_TYPES', 'TRUSTED_FORWARDER_ABI', 'MAX_RELAYR_SENT_PAYMENTS',
  'RELAYR_API', 'RELAYR_PAYMENT_ADDRESS', 'RELAYR_PAYMENT_SELECTOR', 'RELAYR_PAYMENT_CODE_HASH',
  'RELAYR_PAYMENT_EVENT', 'RELAYR_NATIVE_TOKEN', 'RELAYR_PAYMENT_GAS', 'RELAYR_FORWARDER_DEADLINE_SECONDS',
]
function copiedRules(text: string): string[] {
  return [...text.matchAll(new RegExp(`\\b(?:function|class|const|let|var)\\s+(${sharedRules.join('|')})\\b`, 'g'))].map(match => match[1])
}
function applicationSources(directory = resolve(root, 'src')): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? applicationSources(path) : /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

describe('shared SDK architecture owners', () => {
  it.each(owners)('$file consumes $module through its actual adapter', owner => {
    expect(ownershipFailures(owner, source(owner.file))).toEqual([])
  })

  it('does not redeclare SDK retry, rate, Safe, Relayr or activity rules anywhere in application source', () => {
    const failures = applicationSources().flatMap(file => copiedRules(withoutComments(readFileSync(file, 'utf8'))).map(name => `${file}: local ${name}`))
    expect(failures).toEqual([])
  })

  it('keeps RPC admission and retries in the SDK provider', () => {
    expect(source('lib/jbcenter-rpc.ts')).not.toMatch(/\b(?:setTimeout|setInterval)\s*\(|(?:status|code)\s*={2,3}\s*(?:429|-32001)\b/)
  })

  it('does not copy Safe execution ABI declarations or stamped-call selectors', () => {
    const copied = /["'`](?:(?:function|event)\s+)?(?:execTransaction\(|ExecutionSuccess\(bytes32|ExecutionFailure\(bytes32)|["'`]0x(?:3593564c|dd46508f|87517c45)["'`]/i
    expect(applicationSources().filter(file => copied.test(withoutComments(readFileSync(file, 'utf8'))))).toEqual([])
  })

  it('detects removed owners, unused imports, and copied declarations', () => {
    const owner = owners[0], original = source(owner.file)
    expect(ownershipFailures(owner, original.replace(`${core}/jbcenter`, './copied-rpc'))).not.toEqual([])
    expect(ownershipFailures(owner, original.replace('createPacedJBCenterLimiter()', 'localLimiter()'))).not.toEqual([])
    for (const name of ['RPC_START_INTERVAL_MS', 'STAMPED_CALLS', 'requireRelayrRetry', 'CROSS_CHAIN_MERGE_WINDOW'])
      expect(copiedRules(`const ${name} = copiedRule`)).toEqual([name])
  })
})
