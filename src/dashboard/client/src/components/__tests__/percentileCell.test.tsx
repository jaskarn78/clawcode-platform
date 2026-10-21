// @vitest-environment jsdom
/**
 * Phase 120 Plan 02 T-02 (DASH-02) — unit tests for the canonical
 * percentile-cell utility. Pins the null-takes-precedence-over-breach
 * invariant in one place.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { percentileCell } from '../percentileCell'

afterEach(() => {
  cleanup()
})

function renderInTable(node: JSX.Element): HTMLTableCellElement {
  const { container } = render(
    <table>
      <tbody>
        <tr>{node}</tr>
      </tbody>
    </table>,
  )
  const td = container.querySelector('td')
  if (!td) throw new Error('no td rendered')
  return td as HTMLTableCellElement
}

describe('percentileCell', () => {
  it('Test 1 — value present, non-breach renders text-fg-1', () => {
    const td = renderInTable(percentileCell({ value: 250, isBreach: false }))
    expect(td.className).toContain('text-fg-1')
    expect(td.className).not.toContain('text-danger')
    expect(td.className).not.toContain('text-fg-3')
    expect(td.textContent).toBe('250')
  })

  it('Test 2 — null value renders text-fg-3 neutral with em-dash', () => {
    const td = renderInTable(percentileCell({ value: null, isBreach: false }))
    expect(td.className).toContain('text-fg-3')
    expect(td.className).not.toContain('text-danger')
    expect(td.textContent).toBe('—')
  })

  it('Test 3 — value present, breach renders text-danger', () => {
    const td = renderInTable(percentileCell({ value: 9999, isBreach: true }))
    expect(td.className).toContain('text-danger')
    expect(td.textContent).toBe('9999')
  })

  it('Test 4 — null wins over isBreach (caller-bug defense)', () => {
    const td = renderInTable(percentileCell({ value: null, isBreach: true }))
    expect(td.className).toContain('text-fg-3')
    expect(td.className).not.toContain('text-danger')
    expect(td.textContent).toBe('—')
  })

  it('Test 5 — custom format function applied when value present', () => {
    const td = renderInTable(
      percentileCell({ value: 1234, isBreach: false, format: (v) => `${v}ms` }),
    )
    expect(td.textContent).toBe('1234ms')
  })

  it('Test 6 — format NOT applied when value is null', () => {
    const td = renderInTable(
      percentileCell({ value: null, isBreach: false, format: (v) => `${v}ms` }),
    )
    expect(td.textContent).toBe('—')
  })

  it('Test 7 — additional className is merged', () => {
    const td = renderInTable(
      percentileCell({
        value: 100,
        isBreach: false,
        className: 'px-2 py-1 text-right data',
      }),
    )
    expect(td.className).toContain('px-2')
    expect(td.className).toContain('text-fg-1')
  })
})
