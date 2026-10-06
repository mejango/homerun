import { describe, expect, it } from 'vitest'
import { createJBCenterIpfsClient } from '../src/lib/jbcenter-ipfs'

/** A pin that fails before Center answers says what failed and to try again, in two plain sentences. */
describe('a Juicebox Center pin that fails before Center answers', () => {
  const ipfs = createJBCenterIpfsClient({
    baseUrl: 'https://center.example',
    fetch: async () => { throw new TypeError('Failed to fetch') },
  })

  it.each([
    ['metadata', () => ipfs.pinJson({ name: 'An asset' }), 'Saving metadata failed. Try again.'],
    ['an image', () => ipfs.pinImage(new File(['png'], 'cover.png', { type: 'image/png' })), 'Image upload failed. Try again.'],
    ['media', () => ipfs.pinMedia(new File(['mp4'], 'clip.mp4', { type: 'video/mp4' })), 'Media upload failed. Try again.'],
  ])('for %s', async (_kind, pin, words) => {
    await expect(pin()).rejects.toThrow(new RegExp(`^${words.replaceAll('.', '\\.')}$`))
  })
})
