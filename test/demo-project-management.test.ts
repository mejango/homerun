import { describe, expect, it } from 'vitest'
import {
  demoProjectManagementKey, demoSplitUnits, parseDemoProjectManagement, replaceDemoProjectRole,
  validateDemoProjectDelegates, validateDemoProjectDetails, validateDemoProjectSplits,
  type DemoProjectManagement,
} from '../src/lib/demo-project-management'

const owner = '0x1111111111111111111111111111111111111111'
const replacement = '0x2222222222222222222222222222222222222222'
export const demoManagementFixture: DemoProjectManagement = {
  version: 1,
  details: { name: 'Founder Haus', location: 'Florianópolis', description: 'A place to gather.', photo: '', ownerName: 'Owner', ownerIntroduction: 'Asset owner', ownerPhoto: '', operatorName: 'Operator', operatorIntroduction: 'Local hosts', operatorPhoto: '' },
  ownerAddress: owner,
  operatorAddress: owner,
  delegates: [{ address: replacement, permissions: ['Edit project details'] }],
  splits: { fund: [{ address: owner, percent: '50' }], income: [] },
}

describe('demo project management', () => {
  it('scopes persisted controls to one project and round-trips validated known fields', () => {
    expect(demoProjectManagementKey('founderhaus')).not.toBe(demoProjectManagementKey('another'))
    expect(demoProjectManagementKey('a:b')).not.toBe(demoProjectManagementKey('a%3Ab'))
    expect(parseDemoProjectManagement(JSON.stringify({ ...demoManagementFixture, malicious: true }))).toEqual(demoManagementFixture)
    expect(parseDemoProjectManagement('{')).toBeNull()
    expect(parseDemoProjectManagement(JSON.stringify({ ...demoManagementFixture, version: 2 }))).toBeNull()
  })

  it('rejects unsafe images and invalid persisted delegates instead of rendering them', () => {
    expect(() => validateDemoProjectDetails({ ...demoManagementFixture.details, photo: 'javascript:alert(1)' })).toThrow('HTTPS')
    expect(() => validateDemoProjectDetails({ ...demoManagementFixture.details, ownerPhoto: 'https://user:pass@example.com/photo.png' })).toThrow('HTTPS')
    expect(() => validateDemoProjectDetails({ ...demoManagementFixture.details, name: ' ' })).toThrow('project name')
    expect(parseDemoProjectManagement(JSON.stringify({ ...demoManagementFixture, delegates: [{ address: owner, permissions: ['Unknown action'] }] }))).toBeNull()
  })

  it('replaces the Operator address and clears its previous profile without touching ownership', () => {
    const next = replaceDemoProjectRole(demoManagementFixture, 'operator', replacement)
    expect(next.operatorAddress).toBe(replacement)
    expect(next.details.operatorName).toBe('')
    expect(next.details.operatorIntroduction).toBe('')
    expect(next.ownerAddress).toBe(owner)
    expect(next.delegates).toEqual(demoManagementFixture.delegates)
    expect(demoManagementFixture.details.operatorName).toBe('Operator')
  })

  it('transfers project control without transferring token previews or former Owner grants', () => {
    const next = replaceDemoProjectRole(demoManagementFixture, 'owner', replacement)
    expect(next.ownerAddress).toBe(replacement)
    expect(next.details.ownerName).toBe('')
    expect(next.delegates).toEqual([])
    expect(next.splits).toEqual(demoManagementFixture.splits)
    expect(next.operatorAddress).toBe(owner)
    expect(replaceDemoProjectRole(demoManagementFixture, 'owner', owner)).toBe(demoManagementFixture)
  })

  it('requires nonzero valid addresses and one permission per delegated account', () => {
    expect(() => replaceDemoProjectRole(demoManagementFixture, 'owner', '0x0000000000000000000000000000000000000000')).toThrow('nonzero')
    expect(() => validateDemoProjectDelegates([{ address: replacement, permissions: [] }])).toThrow('Choose at least one')
    expect(() => validateDemoProjectDelegates([...demoManagementFixture.delegates, ...demoManagementFixture.delegates])).toThrow('only once')
  })

  it('validates exact seven-decimal split totals and rejects over-allocation', () => {
    expect(demoSplitUnits('0.0000001')).toBe(1n)
    expect(validateDemoProjectSplits([{ address: owner, percent: '99.9999999' }, { address: replacement, percent: '0.0000001' }])).toHaveLength(2)
    expect(() => validateDemoProjectSplits([{ address: owner, percent: '99.9999999' }, { address: replacement, percent: '0.0000002' }])).toThrow('more than 100%')
    expect(() => demoSplitUnits('0.00000001')).toThrow('seven decimal')
    expect(() => demoSplitUnits('0')).toThrow('greater than 0%')
  })

  it('keeps FUND and INCOME recipient previews distinct after reload', () => {
    const next = { ...demoManagementFixture, splits: { ...demoManagementFixture.splits, income: [{ address: replacement, percent: '75' }] } }
    expect(parseDemoProjectManagement(JSON.stringify(next))?.splits).toEqual(next.splits)
  })
})
