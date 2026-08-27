import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStickToBottom } from '../useStickToBottom'

/**
 * A ResizeObserver stub that actually respects `observe()` targets.
 *
 * The stub in useStickToBottom.test.ts fires every callback regardless of what
 * was observed, which is fine for the pin/unpin logic it covers but blind to
 * *which* elements the hook decided to watch. Both regressions below are about
 * exactly that decision, so they need a stub that can tell the difference.
 */
class FakeRO {
  targets = new Set<Element>()
  constructor(public cb: () => void) {
    ros.push(this)
  }
  observe(t: Element) {
    this.targets.add(t)
  }
  unobserve(t: Element) {
    this.targets.delete(t)
  }
  disconnect() {
    this.targets.clear()
  }
}

let ros: FakeRO[] = []

beforeEach(() => {
  ros = []
  vi.stubGlobal('ResizeObserver', FakeRO)
})

/** Fire only the observers that are actually watching `target`. */
function resize(target: Element) {
  for (const ro of ros) if (ro.targets.has(target)) ro.cb()
}

function scrollBox({ scrollHeight = 1000, clientHeight = 400, smoothIsInstant = true } = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  let top = 0
  let height = scrollHeight
  Object.defineProperty(el, 'clientHeight', { get: () => clientHeight })
  Object.defineProperty(el, 'scrollHeight', {
    get: () => height,
    set: (v: number) => {
      height = v
    },
    configurable: true,
  })
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v
    },
    configurable: true,
  })
  el.scrollTo = ((o: ScrollToOptions) => {
    // A real smooth scroll does not land immediately; it emits frames on the
    // way. Tests that care about those frames drive them by hand.
    if (o.behavior === 'smooth' && !smoothIsInstant) return
    top = o.top ?? top
  }) as HTMLElement['scrollTo']
  return {
    el,
    grow: (by: number) => {
      height += by
    },
    scrollTo(next: number) {
      top = next
      el.dispatchEvent(new Event('scroll'))
    },
    /** Content grew under a reader who never touched the scrollbar. */
    growThenScroll(by: number) {
      height += by
      el.dispatchEvent(new Event('scroll'))
    },
    get scrollTop() {
      return top
    },
  }
}

/** MutationObserver delivers on a microtask, so let the queue drain. */
const settle = () => act(async () => {})

describe('content growth that is not the first child at mount', () => {
  it('follows a message appended to a container that started empty', async () => {
    // Regression: the hook observed `node.firstElementChild` once, at ref time.
    // A chat that renders zero messages on mount has no first child then, so
    // only the container was observed — and a container's own border box does
    // not change when content grows inside it. Auto-follow was dead for the
    // whole session.
    const box = scrollBox()
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))
    expect(box.scrollTop).toBe(1000)

    const message = document.createElement('div')
    box.el.appendChild(message)
    await settle()

    box.grow(500)
    act(() => resize(message))

    expect(box.scrollTop).toBe(1500)
  })

  it('follows growth of a sibling that is not the first child', async () => {
    // Same root cause, second shape: a container rendering a list of messages
    // has many direct children, and only the first was ever watched.
    const box = scrollBox()
    const first = document.createElement('div')
    box.el.appendChild(first)

    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))

    const second = document.createElement('div')
    box.el.appendChild(second)
    await settle()

    box.grow(300)
    act(() => resize(second))

    expect(box.scrollTop).toBe(1300)
  })

  it('stops watching a child that was removed', async () => {
    const box = scrollBox()
    const child = document.createElement('div')
    box.el.appendChild(child)

    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))
    expect(ros.some((ro) => ro.targets.has(child))).toBe(true)

    box.el.removeChild(child)
    await settle()

    expect(ros.some((ro) => ro.targets.has(child))).toBe(false)
  })
})

describe('what "not at the bottom" actually means', () => {
  /**
   * A scroll event that lands away from the bottom has three possible causes,
   * and only one of them is the reader. Position alone cannot tell them apart.
   */

  it('does not unpin when growth pushed the bottom away', () => {
    // Regression: judging on position alone read a taller scrollHeight as a
    // scroll away from the bottom. The reader never moved; the content grew
    // under them. Unpinning here also disabled the ResizeObserver follow, so
    // the view stopped following for the rest of the session.
    const box = scrollBox()
    const child = document.createElement('div')
    box.el.appendChild(child)
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))
    expect(result.current.isPinned).toBe(true)

    // scrollTop holds at 1000 while scrollHeight goes to 1500. The distance to
    // the bottom is now 100px, well past the 24px threshold.
    act(() => box.growThenScroll(500))

    expect(result.current.isPinned).toBe(true)
  })

  it('does not unpin on a mid-animation frame of a smooth scroll', () => {
    // Those frames move downward. The reader moving away moves upward.
    const box = scrollBox({ smoothIsInstant: false })
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))
    act(() => box.scrollTo(0))
    expect(result.current.isPinned).toBe(false)

    act(() => result.current.scrollToBottom('smooth'))
    act(() => box.scrollTo(300))
    act(() => box.scrollTo(700))

    expect(result.current.isPinned).toBe(true)
  })

  it('unpins when the reader scrolls up mid-animation', () => {
    const box = scrollBox({ smoothIsInstant: false })
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))
    act(() => box.scrollTo(0))

    act(() => result.current.scrollToBottom('smooth'))
    act(() => box.scrollTo(300))
    // The reader takes over and goes the other way.
    act(() => box.scrollTo(100))

    expect(result.current.isPinned).toBe(false)
  })

  it('leaves the reader where they scrolled to', () => {
    const box = scrollBox({ smoothIsInstant: false })
    const child = document.createElement('div')
    box.el.appendChild(child)
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))

    act(() => result.current.scrollToBottom('smooth'))
    act(() => box.scrollTo(300))
    act(() => box.scrollTo(100))

    box.grow(500)
    act(() => resize(child))

    expect(box.scrollTop).toBe(100)
  })
})
