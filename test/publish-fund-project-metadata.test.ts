import { describe, expect, it, vi } from 'vitest'
import { publishFundProjectMetadata } from '../src/lib/publish-fund-project-metadata'
import { parseFundProjectMetadata } from '../src/lib/fund-project-metadata'
import { CREATE_DEFAULTS } from '../web/create-model.mjs'
import type { CreateValues } from '../src/components/CreateFlow'
import type { JBCenterIpfsClient } from '../src/lib/jbcenter-ipfs'

const draft = (overrides: Partial<CreateValues> = {}) => ({ ...CREATE_DEFAULTS, name: 'Garden Co-op', ...overrides }) as CreateValues
const image = 'data:image/png;base64,YWJjZA=='
function pinClient() {
  return {
    pinImage: vi.fn<JBCenterIpfsClient['pinImage']>().mockImplementation(async file => ({ cid: `bafy${file.name}` })),
    pinJson: vi.fn<JBCenterIpfsClient['pinJson']>().mockResolvedValue({ cid: 'bafymetadata' }),
  }
}

describe('publishing project and operator metadata', () => {
  it('pins both images separately and publishes only their IPFS references', async () => {
    const client = pinClient()
    const result = await publishFundProjectMetadata(draft({ photo: image, operatorPhoto: image, operatorName: ' Gardeners ', operatorIntroduction: ' We grow together. ' }), client)
    expect(result.cid).toBe('bafymetadata')
    expect(client.pinImage.mock.calls.map(([file]) => ({ name: file.name, type: file.type, size: file.size }))).toEqual([
      { name: 'cover', type: 'image/png', size: 4 }, { name: 'operator', type: 'image/png', size: 4 },
    ])
    expect(client.pinJson).toHaveBeenCalledOnce()
    const metadata = client.pinJson.mock.calls[0][0]
    expect(JSON.stringify(metadata)).not.toContain('data:image')
    expect(parseFundProjectMetadata(metadata)).toMatchObject({
      coverUrl: 'https://juicebox.center/ipfs/bafycover',
      operator: { name: 'Gardeners', introduction: 'We grow together.', photoUrl: 'https://juicebox.center/ipfs/bafyoperator' },
    })
    expect(client.pinJson.mock.invocationCallOrder[0]).toBeGreaterThan(client.pinImage.mock.invocationCallOrder[1])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('publishes a profile without requiring a picture or a cover', async () => {
    const client = pinClient()
    await publishFundProjectMetadata(draft({ operatorIntroduction: 'A neighborhood team.' }), client)
    expect(client.pinImage).not.toHaveBeenCalled()
    expect(parseFundProjectMetadata(client.pinJson.mock.calls[0][0]).operator).toEqual({ name: null, introduction: 'A neighborhood team.', photoUrl: null })
  })

  it('validates all profile fields before starting any upload', async () => {
    const client = pinClient()
    for (const operatorPhoto of ['https://tracker.example/photo', 'data:image/svg+xml;base64,YWJjZA==', `data:image/png;base64,${'A'.repeat(1_500_000)}`]) {
      await expect(publishFundProjectMetadata(draft({ photo: image, operatorPhoto }), client)).rejects.toThrow('JPEG, PNG, or WebP')
    }
    await expect(publishFundProjectMetadata(draft({ photo: image, operatorIntroduction: 'a'.repeat(1201) }), client)).rejects.toThrow('1200 characters')
    expect(client.pinImage).not.toHaveBeenCalled()
    expect(client.pinJson).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not publish incomplete metadata when the operator photo upload fails', async () => {
    const client = pinClient()
    client.pinImage.mockResolvedValueOnce({ cid: 'bafycover' }).mockRejectedValueOnce(new Error('Image upload failed'))
    await expect(publishFundProjectMetadata(draft({ photo: image, operatorPhoto: image }), client)).rejects.toThrow('Image upload failed')
    expect(client.pinJson).not.toHaveBeenCalled()
  })
})
