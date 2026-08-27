import { render } from '@testing-library/react'
import { StrictMode } from 'react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStickToBottom } from '../useStickToBottom'

/**
 * Regression cover for a bug the unit tests could not see.
 *
 * The listener used to be attached by the callback ref and removed by an effect
 * cleanup. In StrictMode React runs effects setup → cleanup → setup, so the
 * cleanup stripped the listener; the ref, whose identity never changed, was
 * never called again to restore it. Scrolling silently stopped unpinning.
 *
 * The hook-level test missed it because `renderHook` calls `ref(node)` manually
 * *after* mount, so the cleanup had already run harmlessly. Reproducing it needs
 * the real ordering: ref attached during commit, effects afterwards. Found by
 * driving the demo in a browser.
 */

function scrollBox(el: HTMLElement, { scrollHeight = 1000, clientHeight = 400 } = {}) {
  let top = 0
  Object.defineProperty(el, 'clientHeight', { get: () => clientHeight, configurable: true })
  Object.defineProperty(el, 'scrollHeight', { get: () => scrollHeight, configurable: true })
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v
    },
    configurable: true,
  })
  el.scrollTo = ((o: ScrollToOptions) => {
    top = o.top ?? top
  }) as HTMLElement['scrollTo']
  return {
    scrollTo(next: number) {
      top = next
      el.dispatchEvent(new Event('scroll'))
    },
    /**
     * jsdom reports every metric as 0 until this helper installs them, and it
     * can only run after render. A browser has real metrics when the ref
     * attaches and the hook's own initial scroll lands at the bottom, so
     * replay that before a test asks what the reader's scroll means.
     */
    settleAtBottom() {
      top = scrollHeight - clientHeight
      el.dispatchEvent(new Event('scroll'))
    },
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  )
})

function Thread({ onPinned }: { onPinned: (pinned: boolean) => void }) {
  const { ref, isPinned } = useStickToBottom<HTMLDivElement>()
  onPinned(isPinned)
  return (
    <div ref={ref} data-testid="scroller">
      <div>content</div>
    </div>
  )
}

describe('useStickToBottom under StrictMode', () => {
  it('still unpins when the reader scrolls up after mount', () => {
    let pinned = true
    const view = render(
      <StrictMode>
        <Thread onPinned={(p) => (pinned = p)} />
      </StrictMode>
    )

    const el = view.getByTestId('scroller')
    const box = scrollBox(el)
    act(() => box.settleAtBottom())

    act(() => box.scrollTo(0))

    expect(pinned).toBe(false)
  })

  it('re-pins when the reader returns to the bottom', () => {
    let pinned = true
    const view = render(
      <StrictMode>
        <Thread onPinned={(p) => (pinned = p)} />
      </StrictMode>
    )

    const el = view.getByTestId('scroller')
    const box = scrollBox(el)
    act(() => box.settleAtBottom())

    act(() => box.scrollTo(0))
    expect(pinned).toBe(false)

    act(() => box.scrollTo(600)) // 1000 - 400 = bottom
    expect(pinned).toBe(true)
  })
})
