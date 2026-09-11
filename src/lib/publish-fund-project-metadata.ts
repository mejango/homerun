import type { CreateValues } from '@/components/CreateFlow'
import { normalizeCreateDraft } from '../../web/create-model.mjs'
import { buildFundProjectMetadata } from './fund-project-metadata'
import { jbCenterIpfs, type JBCenterIpfsClient } from './jbcenter-ipfs'

/** Publish the reviewed profile and cover before referring to them in project metadata. */
export async function publishFundProjectMetadata(
  draft: CreateValues,
  ipfs: Pick<JBCenterIpfsClient, 'pinImage' | 'pinJson'> = jbCenterIpfs,
) {
  const normalized = normalizeCreateDraft(draft)
  if (!normalized.valid) throw new Error(Object.values(normalized.errors).join(' '))
  const values = normalized.values as CreateValues

  const publishPhoto = async (photo: string, filename: string) => {
    if (!photo) return undefined
    // Normalization accepts only bounded raster data URLs. Decode locally;
    // project metadata can never trigger a request to an arbitrary image URL.
    const bytes = Uint8Array.from(atob(photo.slice(photo.indexOf(',') + 1)), character => character.charCodeAt(0))
    const type = photo.slice(5, photo.indexOf(';'))
    const pin = await ipfs.pinImage(new File([bytes], filename, { type }))
    return `ipfs://${pin.cid}`
  }

  const coverImageUri = await publishPhoto(values.photo, 'cover')
  const operatorPhotoUri = await publishPhoto(values.operatorPhoto ?? '', 'operator')
  return ipfs.pinJson(buildFundProjectMetadata(values, { coverImageUri, operatorPhotoUri }))
}
