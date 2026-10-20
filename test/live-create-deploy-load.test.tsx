import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ deployLoaded: vi.fn(), showDeploy: false, idle: undefined as (() => void) | undefined }))
vi.mock('@/components/FundDeploy', () => {
  runtime.deployLoaded()
  return { FundDeploy: () => <p data-deploy>Deploy</p> }
})
vi.mock('@/components/CreateFlow', () => ({
  default: ({ renderDeploy }: { renderDeploy: (values: object) => ReactNode }) => <div>{runtime.showDeploy ? renderDeploy({}) : 'Asset step'}</div>,
}))

import LiveCreate from '@/components/LiveCreate'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  runtime.showDeploy = false
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => { runtime.idle = callback; return 1 })
  vi.stubGlobal('cancelIdleCallback', vi.fn())
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('create deploy panel loading', () => {
  it('keeps the launch code off the form, loads it when idle and shows it on the last step', async () => {
    await act(async () => root.render(<LiveCreate />))
    expect(host.textContent).toBe('Asset step')
    expect(runtime.deployLoaded).not.toHaveBeenCalled()

    runtime.idle!()
    await vi.waitFor(() => expect(runtime.deployLoaded).toHaveBeenCalledTimes(1))

    runtime.showDeploy = true
    await act(async () => root.render(<LiveCreate />))
    await vi.waitFor(() => expect(host.querySelector('[data-deploy]')).not.toBeNull())
  })
})
