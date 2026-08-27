import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStickToBottom } from '../useStickToBottom'

/**
 * jsdom does not lay anything out, so scrollHeight/clientHeight are always 0.
 * This makes a div behave like a real scroll container with controllable
 * metrics, and records scrollTop writes so tests can assert on them.
 */
function scrollBox({ scrollHeight = 1000, clientHeight = 400 } = {}) {
  const el = document.createElement('div')
  const content = document.createElement('div')
  el.appendChild(content)
  document.body.appendChild(el)

  let _scrollTop = 0
  let _scrollHeight = scrollHeight

  Object.defineProperty(el, 'clientHeight', { get: () => clientHeight })
  Object.defineProperty(el, 'scrollHeight', {
    get: () => _scrollHeight,
    set: (v: number) => {
      _scrollHeight = v
    },
    configurable: true,
  })
  Object.defineProperty(el, 'scrollTop', {
    get: () => _scrollTop,
    set: (v: number) => {
      _scrollTop = v
    },
    configurable: true,
  })

  el.scrollTo = ((opts: ScrollToOptions) => {
    _scrollTop = opts.top ?? _scrollTop
  }) as HTMLElement['scrollTo']

  return {
    el,
    /** Move the scrollbar as a reader would, then fire the scroll event. */
    scrollTo(top: number) {
      _scrollTop = top
      el.dispatchEvent(new Event('scroll'))
    },
    grow(by: number) {
      _scrollHeight += by
    },
    get scrollTop() {
      return _scrollTop
    },
    get maxScroll() {
      return _scrollHeight - clientHeight
    },
  }
}

let observers: Array<() => void> = []

beforeEach(() => {
  observers = []
  // Capture ResizeObserver callbacks so tests can trigger "content grew".
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: () => void) {
        observers.push(() => this.cb())
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  )
})

const growAndNotify = (box: ReturnType<typeof scrollBox>, by: number) => {
  box.grow(by)
  observers.forEach((fire) => fire())
}

describe('useStickToBottom', () => {
  it('pins to the bottom when the container is attached', () => {
    const box = scrollBox()
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())

    act(() => result.current.ref(box.el as HTMLDivElement))

    expect(result.current.isPinned).toBe(true)
    expect(box.scrollTop).toBe(1000)
  })

  it('follows content growth while pinned', () => {
    const box = scrollBox()
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))

    act(() => growAndNotify(box, 500))

    expect(box.scrollTop).toBe(1500)
    expect(result.current.isPinned).toBe(true)
  })

  it('unpins when the reader scrolls up', () => {
    const box = scrollBox()
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))

    // The hook's own initial scroll fires one event that it consumes; the
    // reader's scroll is the next one.
    act(() => box.scrollTo(200))

    expect(result.current.isPinned).toBe(false)
  })

  it('stops following once unpinned', () => {
    const box = scrollBox()
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))
    act(() => box.scrollTo(200))

    act(() => growAndNotify(box, 500))

    // The reader stays where they were reading instead of being yanked down.
    expect(box.scrollTop).toBe(200)
  })

  it('re-pins when the reader returns to the bottom', () => {
    const box = scrollBox()
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))

    act(() => box.scrollTo(200))
    expect(result.current.isPinned).toBe(false)

    act(() => box.scrollTo(box.maxScroll))
    expect(result.current.isPinned).toBe(true)
  })

  it('treats "close enough to the bottom" as pinned', () => {
    const box = scrollBox()
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>({ threshold: 24 }))
    act(() => result.current.ref(box.el as HTMLDivElement))

    // 10px short of the bottom — inside the threshold, so still pinned.
    act(() => box.scrollTo(box.maxScroll - 10))
    expect(result.current.isPinned).toBe(true)

    // 40px short — outside it.
    act(() => box.scrollTo(box.maxScroll - 40))
    expect(result.current.isPinned).toBe(false)
  })

  it('scrollToBottom re-pins and jumps to the end', () => {
    const box = scrollBox()
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    act(() => result.current.ref(box.el as HTMLDivElement))
    act(() => box.scrollTo(100))
    expect(result.current.isPinned).toBe(false)

    act(() => result.current.scrollToBottom())

    expect(box.scrollTop).toBe(1000)
    expect(result.current.isPinned).toBe(true)
  })

  it('honours initialPinned: false', () => {
    const box = scrollBox()
    const { result } = renderHook(() =>
      useStickToBottom<HTMLDivElement>({ initialPinned: false })
    )
    act(() => result.current.ref(box.el as HTMLDivElement))

    expect(result.current.isPinned).toBe(false)
    expect(box.scrollTop).toBe(0)

    act(() => growAndNotify(box, 500))
    expect(box.scrollTop).toBe(0)
  })

  it('is a no-op when detached with a null ref', () => {
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())
    expect(() => act(() => result.current.ref(null))).not.toThrow()
    expect(() => act(() => result.current.scrollToBottom())).not.toThrow()
  })

  it('keeps unpinning after a StrictMode remount', () => {
    // Regression: the listener used to be added by `ref` and removed by an
    // effect cleanup. StrictMode's mount/cleanup/mount ran the cleanup, `ref`
    // was never re-invoked because its identity had not changed, and scrolling
    // silently stopped unpinning. Found by driving the demo in a real browser,
    // not by the unit tests — which is why this one exists.
    const box = scrollBox()
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>(), {
      wrapper: StrictMode,
    })

    act(() => result.current.ref(box.el as HTMLDivElement))
    act(() => box.scrollTo(0))

    expect(result.current.isPinned).toBe(false)
  })

  it('still unpins after the container is re-attached', () => {
    const box = scrollBox()
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())

    // React re-runs a callback ref as detach-then-attach on some updates.
    act(() => result.current.ref(box.el as HTMLDivElement))
    act(() => result.current.ref(null))
    act(() => result.current.ref(box.el as HTMLDivElement))

    act(() => box.scrollTo(0))
    expect(result.current.isPinned).toBe(false)
  })

  it('detaches the scroll listener when the ref moves to another node', () => {
    const first = scrollBox()
    const second = scrollBox()
    const { result } = renderHook(() => useStickToBottom<HTMLDivElement>())

    act(() => result.current.ref(first.el as HTMLDivElement))
    act(() => result.current.ref(second.el as HTMLDivElement))

    // Scrolling the abandoned node must not change the hook's state.
    act(() => first.scrollTo(0))
    expect(result.current.isPinned).toBe(true)
  })
})
