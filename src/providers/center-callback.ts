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
