import { describe, expect, it, vi } from 'vitest'
import { publishFundProjectMetadata } from '../src/lib/publish-fund-project-metadata'
import { parseFundProjectMetadata } from '../src/lib/fund-project-metadata'
import { CREATE_DEFAULTS, normalizeCreateDraft } from '../web/create-model.mjs'
import type { CreateValues } from '../src/components/CreateFlow'
import type { JBCenterIpfsClient } from '../src/lib/jbcenter-ipfs'

const draft = (overrides: Partial<CreateValues> = {}) => ({ ...CREATE_DEFAULTS, ownerMode: 'existing', operatorMode: 'existing', ownerIsOperator: false, name: 'Garden Co-op', ...overrides }) as CreateValues
const image = 'data:image/png;base64,YWJjZA=='
function pinClient() {
  return {
    pinImage: vi.fn<JBCenterIpfsClient['pinImage']>().mockImplementation(async file => ({ cid: `bafy${file.name}` })),
    pinJson: vi.fn<JBCenterIpfsClient['pinJson']>().mockResolvedValue({ cid: 'bafymetadata' }),
  }
}

describe('publishing project, Owner, and Operator metadata', () => {
  it('pins all three images separately and publishes only their IPFS references', async () => {
    const client = pinClient()
    const result = await publishFundProjectMetadata(draft({ photo: image, ownerPhoto: image, ownerName: ' Neighborhood trust ', ownerIntroduction: ' We own this together. ', operatorPhoto: image, operatorName: ' Gardeners ', operatorIntroduction: ' We grow together. ' }), client)
    expect(result.cid).toBe('bafymetadata')
    expect(client.pinImage.mock.calls.map(([file]) => ({ name: file.name, type: file.type, size: file.size }))).toEqual([
      { name: 'cover', type: 'image/png', size: 4 }, { name: 'owner', type: 'image/png', size: 4 }, { name: 'operator', type: 'image/png', size: 4 },
    ])
    expect(client.pinJson).toHaveBeenCalledOnce()
    const metadata = client.pinJson.mock.calls[0][0]
    expect(JSON.stringify(metadata)).not.toContain('data:image')
    expect(parseFundProjectMetadata(metadata)).toMatchObject({
      coverUrl: 'https://juicebox.center/ipfs/bafycover',
      owner: { name: 'Neighborhood trust', introduction: 'We own this together.', photoUrl: 'https://juicebox.center/ipfs/bafyowner' },
      operator: { name: 'Gardeners', introduction: 'We grow together.', photoUrl: 'https://juicebox.center/ipfs/bafyoperator' },
    })
    expect(client.pinJson.mock.invocationCallOrder[0]).toBeGreaterThan(client.pinImage.mock.invocationCallOrder[2])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('publishes a profile without requiring a picture or a cover', async () => {
    const client = pinClient()
    await publishFundProjectMetadata(draft({ ownerIntroduction: 'A community trust.', operatorIntroduction: 'A neighborhood team.' }), client)
    expect(client.pinImage).not.toHaveBeenCalled()
    expect(parseFundProjectMetadata(client.pinJson.mock.calls[0][0]).owner).toEqual({ name: null, introduction: 'A community trust.', photoUrl: null })
    expect(parseFundProjectMetadata(client.pinJson.mock.calls[0][0]).operator).toEqual({ name: null, introduction: 'A neighborhood team.', photoUrl: null })
  })

  it('validates all profile fields before starting any upload', async () => {
    const client = pinClient()
    for (const profile of ['owner', 'operator']) {
      for (const photo of ['https://tracker.example/photo', 'data:image/svg+xml;base64,YWJjZA==', `data:image/png;base64,${'A'.repeat(1_500_000)}`]) {
        await expect(publishFundProjectMetadata(draft({ photo: image, [`${profile}Photo`]: photo }), client)).rejects.toThrow('JPEG, PNG, or WebP')
      }
      await expect(publishFundProjectMetadata(draft({ photo: image, [`${profile}Introduction`]: 'a'.repeat(1201) }), client)).rejects.toThrow('1200 characters')
    }
    expect(client.pinImage).not.toHaveBeenCalled()
    expect(client.pinJson).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves every supported create field in the pinned JSON, with image references replacing local payloads', async () => {
    const client = pinClient()
    const values = normalizeCreateDraft(draft({
      name: ' Neighborhood workshop ', location: ' Portland ', description: ' A shared workshop. ',
      ownerWallet: '0x0000000000000000000000000000000000000001', ownerName: ' Trust ', ownerIntroduction: ' We own the building. ',
      operatorWallet: '0x0000000000000000000000000000000000000002', operatorName: ' Makers ', operatorIntroduction: ' We run classes. ',
      revenueDescription: ' Classes and memberships ', minimumRevenue: 5_000, minimumRevenueConsequences: ' Publish a recovery plan. ',
      purchaseBudget: 700_000, opsReserve: 50_000, monthlyRent: 8_000, monthlyCosts: 3_000, rentGrowthPercent: 6, costGrowthPercent: 2,
      operatorFundPercent: 15, operatorSplitPercent: 65, stickySplitPercent: 20, networks: ['base', 'ethereum'], networkEnvironment: 'testnet',
      revnetOperatorEnabled: true, photo: image, ownerPhoto: image, operatorPhoto: image,
    })).values as CreateValues
    await publishFundProjectMetadata(values, client)
    const metadata = JSON.parse(JSON.stringify(client.pinJson.mock.calls[0][0]))
    const { photo, ownerPhoto, operatorPhoto, ...descriptiveSetup } = values
    expect([photo, ownerPhoto, operatorPhoto]).toEqual([image, image, image])
    expect(metadata.homerun.setup).toEqual(descriptiveSetup)
    expect(metadata).toMatchObject({ name: values.name, description: values.description, coverImageUri: 'ipfs://bafycover', homerun: {
      owner: { name: values.ownerName, introduction: values.ownerIntroduction, photoUri: 'ipfs://bafyowner' },
      operator: { name: values.operatorName, introduction: values.operatorIntroduction, photoUri: 'ipfs://bafyoperator' },
    } })
    expect(JSON.stringify(metadata)).not.toContain('data:image')
  })

  it('does not publish incomplete metadata when the Owner photo upload fails', async () => {
    const client = pinClient()
    client.pinImage.mockResolvedValueOnce({ cid: 'bafycover' }).mockRejectedValueOnce(new Error('Owner image upload failed'))
    await expect(publishFundProjectMetadata(draft({ photo: image, ownerPhoto: image, operatorPhoto: image }), client)).rejects.toThrow('Owner image upload failed')
    expect(client.pinJson).not.toHaveBeenCalled()
  })

  it('does not publish incomplete metadata when the operator photo upload fails', async () => {
    const client = pinClient()
    client.pinImage.mockResolvedValueOnce({ cid: 'bafycover' }).mockRejectedValueOnce(new Error('Image upload failed'))
    await expect(publishFundProjectMetadata(draft({ photo: image, operatorPhoto: image }), client)).rejects.toThrow('Image upload failed')
    expect(client.pinJson).not.toHaveBeenCalled()
  })
})
