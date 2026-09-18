import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'

describe('DOM environment smoke test', () => {
  it('has document available', () => {
    expect(typeof document).not.toBe('undefined')
  })

  it('can render React component', () => {
    const { container } = render(<div>test</div>)
    expect(container.textContent).toBe('test')
  })
})
