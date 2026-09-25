import assert from 'node:assert/strict'
import { test } from 'vitest'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { decodeHomerunFundLaunch } from '../src/lib/homerun-fund-launch'
import { homerunDeployerAbi } from '../src/lib/income-contracts'

const deployer = '0x19Ce092bc3f9662E40C4670C68ff03C8322D0E76' as Address
const owner = '0x1111111111111111111111111111111111111111' as Address
const peer = '0x2222222222222222222222222222222222222222' as Address
const salt = `0x${'12'.repeat(32)}` as Hex
const data = encodeFunctionData({
  abi: homerunDeployerAbi, functionName: 'launchFundFor',
  args: [owner, 'ipfs://bafkreihomerunmetadata', 'House FUND', 'HOUSE', 1_790_000_000, salt, [peer]],
})

test('decodes a launchFundFor call to the deployer on every Homerun chain', () => {
  for (const chainId of [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614]) {
    assert.deepEqual(decodeHomerunFundLaunch({ chainId, to: deployer, data }), {
      owner, projectUri: 'ipfs://bafkreihomerunmetadata', tokenName: 'House FUND', ticker: 'HOUSE',
      to: deployer, mustStartAtOrAfter: 1_790_000_000, salt, peerSuckerDeployers: [peer],
    })
  }
})

test('matches the deployer address without regard to checksum case', () => {
  assert.equal(decodeHomerunFundLaunch({ chainId: 8453, to: deployer.toLowerCase() as Address, data })?.owner, owner)
})

test('returns null for another target, another chain, another function or unreadable calldata', () => {
  assert.equal(decodeHomerunFundLaunch({ chainId: 8453, to: owner, data }), null)
  assert.equal(decodeHomerunFundLaunch({ chainId: 137, to: deployer, data }), null)
  const isFund = encodeFunctionData({ abi: homerunDeployerAbi, functionName: 'isFund', args: [1n] })
  assert.equal(decodeHomerunFundLaunch({ chainId: 8453, to: deployer, data: isFund }), null)
  assert.equal(decodeHomerunFundLaunch({ chainId: 8453, to: deployer, data: `0xdeadbeef${data.slice(10)}` }), null)
  assert.equal(decodeHomerunFundLaunch({ chainId: 8453, to: deployer, data: data.slice(0, 74) as Hex }), null)
})
