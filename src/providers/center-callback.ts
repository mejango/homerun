type CallbackLocation = { href: string; replace(path: string): void }
/** Runs before loading the wallet SDK. The original callback lives only in this module's
 * memory until the SDK validates and journals it; it is never copied into an app URL. */
export function captureCenterCallback(location: CallbackLocation): { url: string } | null {
  const url = new URL(location.href)
  if (url.pathname !== '/center/callback') return null
  location.replace('/center/callback')
  return { url: url.href }
}
export function centerReturnPath(value: string): string {
  if (typeof value !== 'string' || value.length > 1024 || !/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(value) || value.startsWith('/center/'))
    throw new Error('The original Homerun page is unavailable.')
  return value
}
/** The message a framed callback page sends the Homerun page framing it, and the ack it gets back. */
export const CENTER_FRAME_CALLBACK = 'juicebox-center:callback'
export const CENTER_FRAME_RECEIVED = 'juicebox-center:received'
/** Hands a review callback to a same-origin Homerun page framing this one. False outside such a frame. */
export function deliverCenterCallbackToParent(url: string, win: Window = window): boolean {
  if (win.parent === win) return false
  try { if (win.parent.location.origin !== win.location.origin) return false } catch { return false }
  win.parent.postMessage({ type: CENTER_FRAME_CALLBACK, url }, win.location.origin)
  return true
}
let captured: { url: string } | null = null
let failure: unknown
if (typeof window !== 'undefined') {
  try { captured = captureCenterCallback({ href: window.location.href, replace: path => window.history.replaceState(null, '', path) }) }
  catch (error) { failure = error }
}
export function capturedCenterCallback() {
  if (failure) throw new Error('The wallet callback could not be cleared safely.')
  return captured
}
