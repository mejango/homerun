import { describe, expect, it } from 'vitest'
import { writeIntent } from '@/lib/write-intent'

describe('writeIntent', () => {
  it('names a write by its action and the params the user chose, in any order and address case', () => {
    expect(writeIntent('pay', { project: 7n, token: '0xABCDEFabcdef0000000000000000000000000001', amount: 5n }))
      .toBe(writeIntent('pay', { amount: 5n, token: '0xabcdefabcdef0000000000000000000000000001', project: 7n }))
  })

  it('fits the SDK namespace rule whatever the params hold', () => {
    const name = writeIntent('asset-withdrawal', { memo: 'Homerun asset purchase: Invoice #12 (Rotterdam)', beneficiary: '0x' + 'AB'.repeat(20), feeBeneficiary: '0x' + 'CD'.repeat(20), amount: 10n ** 30n })
    expect(name).toMatch(/^[a-z0-9][a-z0-9:._/-]{0,127}$/)
    expect(name.startsWith('homerun:intent:asset-withdrawal:')).toBe(true)
    expect(() => writeIntent('Pay Now', {})).toThrow()
  })

  it('tells apart another action, another choice, and another project', () => {
    const base = writeIntent('cash-out', { project: 7n, token: '0x1', count: 5n })
    expect(writeIntent('borrow', { project: 7n, token: '0x1', count: 5n })).not.toBe(base)
    expect(writeIntent('cash-out', { project: 7n, token: '0x1', count: 6n })).not.toBe(base)
    expect(writeIntent('cash-out', { project: 8n, token: '0x1', count: 5n })).not.toBe(base)
  })

  it('keeps free text exactly, so distinct references never collide', () => {
    expect(writeIntent('asset-withdrawal', { memo: 'Invoice A' })).not.toBe(writeIntent('asset-withdrawal', { memo: 'Invoice a' }))
    expect(writeIntent('asset-withdrawal', { memo: 'x\nb=y' })).not.toBe(writeIntent('asset-withdrawal', { memo: 'x', b: 'y' }))
    // Only an address is case-insensitive.
    expect(writeIntent('pay', { token: '0xABCDEFabcdef0000000000000000000000000001' })).toBe(writeIntent('pay', { token: '0xabcdefabcdef0000000000000000000000000001' }))
  })
})
