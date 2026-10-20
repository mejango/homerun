import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { AllowedDecreaseField } from '@/components/ui/AllowedDecreaseField'

describe('AllowedDecreaseField', () => {
  it('checks a custom percent against the limit after rounding it to basis points', async () => {
    const host = document.createElement('div'), root = createRoot(host), onChange = vi.fn()
    await act(async () => root.render(<AllowedDecreaseField bps={250} onChange={onChange} limitPercent={50} />))
    const input = host.querySelector<HTMLInputElement>('input[type="number"]')!
    const type = (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await type('49.999')
    await type('50')
    expect(onChange).not.toHaveBeenCalled()
    await type('49.99')
    expect(onChange).toHaveBeenLastCalledWith(4999)
    await act(async () => root.unmount())
  })
})
