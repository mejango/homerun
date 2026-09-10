import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jbProjectsAbi } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeAbiParameters, encodeEventTopics, zeroAddress, zeroHash, type Abi, type Address, type Hex, type PublicClient } from 'viem'
import { homerunIncomeDeployerAbi, registeredIncomeDeployer } from '../src/lib/income-contracts'
import { readInitialIncomeAllocation, type InitialIncomeAllocationState } from '../src/lib/income-allocation-state'
import { readIncomeFundBinding } from '../src/lib/income-fund-binding'

vi.mock('../src/lib/income-contracts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/income-contracts')>(), registeredIncomeDeployer: vi.fn(),
}))
vi.mock('../src/lib/income-allocation-state', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/income-allocation-state')>(), readInitialIncomeAllocation: vi.fn(),
}))

const CHAIN = 1
const INCOME_ID = 11n
const FUND_ID = 7n
const LATEST = 1_000_000n
const CREATED = 712_345n
const HELPER = '0x1111111111111111111111111111111111111111' as const
const VAULT = '0x2222222222222222222222222222222222222222' as const
const FUND_TOKEN = '0x3333333333333333333333333333333333333333' as const
const SHARE_TOKEN = '0x4444444444444444444444444444444444444444' as const
const OPERATOR = '0x5555555555555555555555555555555555555555' as const
const SAFE = '0x6666666666666666666666666666666666666666' as const
const FOREIGN = '0x7777777777777777777777777777777777777777' as const
const PROJECTS = v6Address('JBProjects', CHAIN)
const CREATION_HASH = `0x${'ab'.repeat(32)}` as Hex
const LATEST_HASH = `0x${'bc'.repeat(32)}` as Hex
const TX_HASH = `0x${'cd'.repeat(32)}` as Hex
const OTHER_HASH = `0x${'de'.repeat(32)}` as Hex
const ROOT = `0x${'ef'.repeat(32)}` as Hex
const INPUT = { chainId: CHAIN, incomeProjectId: INCOME_ID }

function rawLog(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>, logIndex: number) {
  const event = abi.find(item => item.type === 'event' && item.name === eventName)
  if (!event || event.type !== 'event') throw new Error('Missing fixture event')
  const fields = event.inputs.filter(field => !field.indexed)
  return { address, topics: encodeEventTopics({ abi, eventName, args }), data: encodeAbiParameters(fields, fields.map(field => args[field.name!])),
    blockNumber: CREATED, blockHash: CREATION_HASH, transactionHash: TX_HASH, transactionIndex: 1, logIndex, removed: false,
    // These are deliberately available like viem's decoded getLogs output; raw bytes remain authoritative.
    eventName, args,
  }
}
function creationLog(args: Record<string, unknown> = {}) {
  return rawLog(PROJECTS, jbProjectsAbi, 'Create', { projectId: INCOME_ID, owner: v6Address('REVOwner', CHAIN), caller: v6Address('REVDeployer', CHAIN), ...args }, 3)
}
function deploymentLog(args: Record<string, unknown> = {}) {
  return rawLog(HELPER, homerunIncomeDeployerAbi, 'IncomeDeployed', {
    fundProjectId: FUND_ID, incomeProjectId: INCOME_ID, operator: OPERATOR, fundToken: FUND_TOKEN,
    initialAllocationVault: VAULT, rewardToken: SHARE_TOKEN, merkleRoot: ROOT, ...args,
  }, 14)
}
type RawLog = ReturnType<typeof rawLog>
type LogRequest = { address: Address; event: { name: string }; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint; strict?: boolean }
type BlockRequest = { blockTag?: string; blockNumber?: bigint }

function fixture(options: { generic?: boolean; safe?: boolean } = {}) {
  const createLogs: RawLog[] = [creationLog()]
  const helperLogs: RawLog[] = options.generic ? [] : [deploymentLog()]
  const receipt = { status: 'success', transactionHash: TX_HASH, blockNumber: CREATED, blockHash: CREATION_HASH,
    transactionIndex: 1, from: OPERATOR, to: options.safe ? SAFE : HELPER, logs: [...createLogs, ...helperLogs] }
  const transaction = { hash: TX_HASH, blockNumber: CREATED, blockHash: CREATION_HASH, chainId: CHAIN,
    transactionIndex: 1, from: OPERATOR, to: options.safe ? SAFE : HELPER, input: '0x' as Hex }
  const allocation = { chainId: CHAIN, incomeProjectId: INCOME_ID, fundProjectId: FUND_ID,
    blockNumber: LATEST, blockHash: LATEST_HASH, deployer: HELPER, vault: VAULT, merkleRoot: ROOT,
  } as InitialIncomeAllocationState
  vi.mocked(readInitialIncomeAllocation).mockResolvedValue(allocation)
  const getChainId = vi.fn(async () => CHAIN)
  const getBlock = vi.fn(async (request: BlockRequest) => {
    const blockNumber = request.blockNumber ?? LATEST
    if (request.blockTag) expect(request.blockTag).toBe('latest')
    expect([CREATED, LATEST]).toContain(blockNumber)
    return { number: blockNumber, hash: blockNumber === CREATED ? CREATION_HASH : LATEST_HASH, timestamp: 1_800_000_000n }
  })
  const getCode = vi.fn(async (request: { address: Address; blockNumber: bigint }) => {
    expect([PROJECTS, HELPER]).toContain(request.address)
    expect(request.blockNumber).toBeTypeOf('bigint')
    return request.address === PROJECTS && request.blockNumber < 100n ? '0x' : '0x6000'
  })
  const readContract = vi.fn(async (request: { address: Address; functionName: string; blockNumber: bigint }) => {
    expect(request.address).toBe(PROJECTS)
    expect(request.functionName).toBe('count')
    expect(request.blockNumber).toBeTypeOf('bigint')
    expect(request.blockNumber).toBeGreaterThanOrEqual(100n)
    return request.blockNumber < CREATED ? INCOME_ID - 1n : INCOME_ID
  })
  const getLogs = vi.fn(async (request: LogRequest) => {
    expect(request.fromBlock).toBe(CREATED)
    expect(request.toBlock).toBe(CREATED)
    expect(request.strict).toBe(true)
    if (request.event.name === 'Create') {
      expect(request.address).toBe(PROJECTS)
      expect(request.args).toEqual({ projectId: INCOME_ID })
      return createLogs
    }
    expect(request.event.name).toBe('IncomeDeployed')
    expect(request.address).toBe(HELPER)
    expect(request.args).toEqual({ incomeProjectId: INCOME_ID })
    return helperLogs
  })
  const getTransaction = vi.fn(async (request: { hash: Hex }) => { expect(request.hash).toBe(TX_HASH); return transaction })
  const getTransactionReceipt = vi.fn(async (request: { hash: Hex }) => { expect(request.hash).toBe(TX_HASH); return receipt })
  const client = { getChainId, getBlock, getCode, readContract, getLogs, getTransaction, getTransactionReceipt } as unknown as PublicClient
  return { client, createLogs, helperLogs, receipt, transaction, allocation,
    getChainId, getBlock, getCode, readContract, getLogs, getTransaction, getTransactionReceipt }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(registeredIncomeDeployer).mockReturnValue(HELPER)
})

describe('INCOME to FUND discovery from canonical creation evidence', () => {
  it('finds the FUND binding with two one-block event queries and a logarithmic creation search', async () => {
    const f = fixture()
    expect(await readIncomeFundBinding(f.client, INPUT)).toBe(FUND_ID)
    expect(f.getLogs).toHaveBeenCalledTimes(2)
    expect(f.readContract.mock.calls.length).toBeLessThanOrEqual(24)
    expect(f.readContract.mock.calls.length).toBeGreaterThan(1)
    expect(readInitialIncomeAllocation).toHaveBeenCalledWith(f.client, { ...INPUT, fundProjectId: FUND_ID })
    expect(f.getBlock).toHaveBeenCalledWith({ blockNumber: CREATED })
    expect(f.getBlock).toHaveBeenCalledWith({ blockNumber: LATEST })
  })

  it('accepts a Safe or other outer transaction whose canonical nested launch evidence is verified', async () => {
    const f = fixture({ safe: true })
    expect(f.transaction.to).not.toBe(HELPER)
    expect(await readIncomeFundBinding(f.client, INPUT)).toBe(FUND_ID)
  })

  it('returns null for a generic REV whose creation receipt contains no Homerun launch', async () => {
    const f = fixture({ generic: true })
    expect(await readIncomeFundBinding(f.client, INPUT)).toBeNull()
    expect(f.getTransactionReceipt).toHaveBeenCalledTimes(1)
    expect(readInitialIncomeAllocation).not.toHaveBeenCalled()
    expect(f.getBlock).toHaveBeenCalledWith({ blockNumber: CREATED })
    expect(f.getBlock).toHaveBeenCalledWith({ blockNumber: LATEST })
  })

  it('does no RPC discovery when the SDK has no registered Homerun launcher', async () => {
    const f = fixture()
    vi.mocked(registeredIncomeDeployer).mockReturnValue(null)
    expect(await readIncomeFundBinding(f.client, INPUT)).toBeNull()
    expect(f.getBlock).not.toHaveBeenCalled()
    expect(f.getLogs).not.toHaveBeenCalled()
    expect(f.readContract).not.toHaveBeenCalled()
  })

  it.each([
    { chainId: 0 }, { chainId: -1 }, { chainId: 1.5 }, { chainId: 999_999 },
    { incomeProjectId: 0n }, { incomeProjectId: -1n }, { incomeProjectId: 1n << 256n },
  ])('rejects unsupported inputs before RPC reads: %o', async input => {
    const f = fixture()
    await expect(readIncomeFundBinding(f.client, { ...INPUT, ...input })).rejects.toThrow()
    expect(f.getLogs).not.toHaveBeenCalled()
  })

  it('rejects an RPC chain different from the selected chain before discovery', async () => {
    const f = fixture()
    f.getChainId.mockResolvedValue(10)
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
    expect(f.getLogs).not.toHaveBeenCalled()
  })

  it('rejects an unknown project beyond canonical project count', async () => {
    const f = fixture()
    f.readContract.mockResolvedValue(INCOME_ID - 1n)
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
    expect(readInitialIncomeAllocation).not.toHaveBeenCalled()
  })

  it('treats historical registry absence as zero projects without reading a nonexistent contract', async () => {
    const f = fixture()
    f.getCode.mockImplementation(async request => request.address === PROJECTS && request.blockNumber < CREATED ? '0x' : '0x6000')
    expect(await readIncomeFundBinding(f.client, INPUT)).toBe(FUND_ID)
    expect(f.getCode.mock.calls.some(([request]) => request.blockNumber < CREATED)).toBe(true)
    expect(f.readContract.mock.calls.every(([request]) => request.blockNumber >= CREATED)).toBe(true)
  })

  it.each([PROJECTS, HELPER])('requires code at the registered discovery dependency %s', async missing => {
    const f = fixture()
    f.getCode.mockImplementation(async request => request.address === missing ? '0x' : '0x6000')
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
    expect(f.getLogs).not.toHaveBeenCalled()
  })

  it.each(['missing', 'duplicate', 'foreign', 'wrong project', 'removed', 'wrong block', 'missing hash', 'bad raw bytes'])('rejects %s canonical Create evidence', async problem => {
    const f = fixture()
    if (problem === 'missing') f.createLogs.length = 0
    if (problem === 'duplicate') f.createLogs.push(creationLog())
    if (problem === 'foreign') f.createLogs[0].address = FOREIGN
    if (problem === 'wrong project') f.createLogs[0] = creationLog({ projectId: FUND_ID })
    if (problem === 'removed') f.createLogs[0].removed = true
    if (problem === 'wrong block') f.createLogs[0].blockNumber = CREATED + 1n
    if (problem === 'missing hash') f.createLogs[0].blockHash = zeroHash
    if (problem === 'bad raw bytes') f.createLogs[0].data = '0x'
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
    expect(readInitialIncomeAllocation).not.toHaveBeenCalled()
  })

  it('uses ABI-decoded raw Create data instead of trusting a convenient args object', async () => {
    const f = fixture()
    f.createLogs[0].args = { projectId: FUND_ID }
    expect(await readIncomeFundBinding(f.client, INPUT)).toBe(FUND_ID)
  })

  it.each(['duplicate', 'foreign', 'wrong income', 'same fund', 'zero fund', 'zero vault', 'different tx', 'removed', 'wrong block', 'bad raw bytes'])('rejects %s helper discovery evidence', async problem => {
    const f = fixture()
    if (problem === 'duplicate') f.helperLogs.push(deploymentLog())
    if (problem === 'foreign') f.helperLogs[0].address = FOREIGN
    if (problem === 'wrong income') f.helperLogs[0] = deploymentLog({ incomeProjectId: FUND_ID })
    if (problem === 'same fund') f.helperLogs[0] = deploymentLog({ fundProjectId: INCOME_ID })
    if (problem === 'zero fund') f.helperLogs[0] = deploymentLog({ fundProjectId: 0n })
    if (problem === 'zero vault') f.helperLogs[0] = deploymentLog({ initialAllocationVault: zeroAddress })
    if (problem === 'different tx') f.helperLogs[0].transactionHash = OTHER_HASH
    if (problem === 'removed') f.helperLogs[0].removed = true
    if (problem === 'wrong block') f.helperLogs[0].blockNumber = CREATED - 1n
    if (problem === 'bad raw bytes') f.helperLogs[0].data = '0x'
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
  })

  it('rejects an omitted helper getLogs result when the creation receipt proves a Homerun launch', async () => {
    const f = fixture()
    f.helperLogs.length = 0
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
    expect(readInitialIncomeAllocation).not.toHaveBeenCalled()
  })

  it('requires the canonical Create log to appear in the transaction receipt too', async () => {
    const f = fixture()
    f.receipt.logs = [deploymentLog()]
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
  })

  it('requires the discovered helper log to appear in the transaction receipt too', async () => {
    const f = fixture()
    f.receipt.logs = [creationLog()]
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
  })

  it('rejects a duplicated matching helper event in a receipt', async () => {
    const f = fixture()
    f.receipt.logs.push({ ...deploymentLog(), logIndex: 15 })
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
  })

  it('allows another project’s helper event in the same atomic outer transaction', async () => {
    const f = fixture({ safe: true })
    f.receipt.logs.push({ ...deploymentLog({ incomeProjectId: 12n, fundProjectId: 8n }), logIndex: 20 })
    expect(await readIncomeFundBinding(f.client, INPUT)).toBe(FUND_ID)
  })

  it('requires the helper launch event to follow project creation even when both RPC views agree', async () => {
    const f = fixture()
    f.helperLogs[0] = { ...deploymentLog(), logIndex: f.createLogs[0].logIndex - 1 }
    f.receipt.logs[1] = f.helperLogs[0]
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
    expect(readInitialIncomeAllocation).not.toHaveBeenCalled()
  })

  it.each(['root', 'index', 'create bytes'])('rejects inconsistent getLogs and receipt %s evidence', async problem => {
    const f = fixture()
    if (problem === 'root') f.receipt.logs[1] = deploymentLog({ merkleRoot: OTHER_HASH })
    if (problem === 'index') f.receipt.logs[1] = { ...deploymentLog(), logIndex: 16 }
    if (problem === 'create bytes') f.receipt.logs[0] = creationLog({ owner: FOREIGN })
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
  })

  it.each(['failed receipt', 'receipt transaction', 'receipt block', 'receipt block hash', 'transaction hash', 'transaction block', 'transaction block hash'])('rejects %s', async problem => {
    const f = fixture()
    if (problem === 'failed receipt') f.receipt.status = 'reverted'
    if (problem === 'receipt transaction') f.receipt.transactionHash = OTHER_HASH
    if (problem === 'receipt block') f.receipt.blockNumber = CREATED + 1n
    if (problem === 'receipt block hash') f.receipt.blockHash = OTHER_HASH
    if (problem === 'transaction hash') f.transaction.hash = OTHER_HASH
    if (problem === 'transaction block') f.transaction.blockNumber = CREATED + 1n
    if (problem === 'transaction block hash') f.transaction.blockHash = OTHER_HASH
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
  })

  it.each(['none', 'deployer', 'vault', 'income', 'fund', 'chain', 'root', 'old block'])('rejects a mismatched immutable allocation binding: %s', async problem => {
    const f = fixture()
    if (problem === 'none') vi.mocked(readInitialIncomeAllocation).mockResolvedValue(null)
    if (problem === 'deployer') f.allocation.deployer = FOREIGN
    if (problem === 'vault') f.allocation.vault = FOREIGN
    if (problem === 'income') f.allocation.incomeProjectId = FUND_ID
    if (problem === 'fund') f.allocation.fundProjectId = INCOME_ID
    if (problem === 'chain') f.allocation.chainId = 10
    if (problem === 'root') f.allocation.merkleRoot = OTHER_HASH
    if (problem === 'old block') f.allocation.blockNumber = CREATED - 1n
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
  })

  it('accepts a verified empty local allocation with a zero root', async () => {
    const f = fixture()
    f.helperLogs[0] = deploymentLog({ merkleRoot: zeroHash })
    f.receipt.logs[1] = f.helperLogs[0]
    f.allocation.merkleRoot = zeroHash
    expect(await readIncomeFundBinding(f.client, INPUT)).toBe(FUND_ID)
  })

  it.each([CREATED, LATEST])('rejects a reorg of pinned block %s even after immutable binding verification', async blockNumber => {
    const f = fixture()
    const canonical = f.getBlock.getMockImplementation()!
    let reads = 0
    f.getBlock.mockImplementation(async request => {
      const matching = request.blockNumber === blockNumber
      if (matching) reads++
      return { ...await canonical(request), ...(matching && reads >= (blockNumber === CREATED ? 2 : 1) ? { hash: OTHER_HASH } : {}) }
    })
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
    expect(readInitialIncomeAllocation).toHaveBeenCalledTimes(1)
  })

  it.each(['getBlock', 'getCode', 'readContract', 'getLogs', 'getTransaction', 'getTransactionReceipt', 'allocation'])('propagates required %s failures instead of returning an unbound generic project', async method => {
    const f = fixture()
    if (method === 'allocation') vi.mocked(readInitialIncomeAllocation).mockRejectedValueOnce(new Error('Required RPC failed'))
    else f[method as 'getBlock'].mockRejectedValueOnce(new Error('Required RPC failed'))
    await expect(readIncomeFundBinding(f.client, INPUT)).rejects.toThrow()
  })
})
