import { useCallback, useRef, useState } from 'react'

export type UseStickToBottomOptions = {
  /**
   * How many pixels above the bottom still counts as "at the bottom".
   * Browsers report fractional scroll positions at some zoom levels, so a
   * threshold of 0 makes `isPinned` flicker. Defaults to 24.
   */
  threshold?: number
  /** Start pinned to the bottom on mount. Defaults to true. */
  initialPinned?: boolean
  /** Behaviour used when the hook scrolls for you. Defaults to 'auto'. */
  behavior?: ScrollBehavior
}

export type UseStickToBottom<T extends HTMLElement> = {
  /** Attach to the scrollable container. */
  ref: (node: T | null) => void
  /**
   * True while the view is following new content. Becomes false the moment the
   * reader scrolls up, and true again when they return to the bottom.
   */
  isPinned: boolean
  /** Scroll to the bottom and re-pin. Wire this to a "jump to latest" button. */
  scrollToBottom: (behavior?: ScrollBehavior) => void
}

function atBottom(el: HTMLElement, threshold: number): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

/**
 * Keeps a scroll container pinned to the bottom as content grows, without
 * fighting the reader.
 *
 * The naive version — setting `scrollTop = scrollHeight` on every update —
 * yanks the view back down the instant someone scrolls up to re-read something.
 * This hook watches the container and stops following as soon as the reader
 * scrolls away, then resumes when they come back to the bottom.
 *
 * Growth is detected with a `ResizeObserver` on the content rather than on a
 * render count, so it also handles late-loading images and fonts that change
 * height after the text is already committed.
 *
 * ```tsx
 * const { ref, isPinned, scrollToBottom } = useStickToBottom<HTMLDivElement>()
 * <div ref={ref} style={{ overflowY: 'auto' }}>…</div>
 * {!isPinned && <button onClick={() => scrollToBottom('smooth')}>Jump to latest</button>}
 * ```
 */
export function useStickToBottom<T extends HTMLElement>(
  options: UseStickToBottomOptions = {}
): UseStickToBottom<T> {
  const { threshold = 24, initialPinned = true, behavior = 'auto' } = options

  const elRef = useRef<T | null>(null)
  const pinnedRef = useRef(initialPinned)
  const [isPinned, setIsPinned] = useState(initialPinned)
  const observerRef = useRef<ResizeObserver | null>(null)
  // Set only while a *smooth* scroll is animating. Instant scrolls need no
  // guard: the position check below is self-correcting, because a jump to the
  // bottom lands at the bottom. A smooth scroll passes through positions that
  // are not the bottom yet, which would otherwise read as "reader scrolled up".
  const settlingRef = useRef(false)

  const setPinned = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return
    pinnedRef.current = next
    setIsPinned(next)
  }, [])

  const scrollToBottom = useCallback(
    (b: ScrollBehavior = behavior) => {
      const el = elRef.current
      if (!el) return
      settlingRef.current = b === 'smooth'
      el.scrollTo({ top: el.scrollHeight, behavior: b })
      setPinned(true)
    },
    [behavior, setPinned]
  )

  // `ref` owns the whole listener lifecycle: attach on a node, detach on the
  // next node or on `null`. React always calls a callback ref with `null` when
  // the element goes away, so no effect cleanup is needed — and adding one is
  // actively harmful. An effect that removes the listener runs its cleanup on
  // StrictMode's setup/cleanup/setup pass in development, which strips the
  // listener while `ref` — whose identity never changed — is never called
  // again to restore it. Scrolling then silently stops unpinning.
  //
  // The handler itself is a stable wrapper reading the latest logic from a ref,
  // so a changed `threshold` never forces a re-attach either.
  const onScrollRef = useRef<() => void>(() => {})
  onScrollRef.current = () => {
    const el = elRef.current
    if (!el) return
    const bottom = atBottom(el, threshold)
    if (settlingRef.current) {
      // Mid-animation frames are not the reader's intent. Wait for the scroll
      // to land before judging position again.
      if (!bottom) return
      settlingRef.current = false
    }
    setPinned(bottom)
  }

  const stableScrollHandler = useRef(() => {
    onScrollRef.current()
  }).current

  const ref = useCallback(
    (node: T | null) => {
      const previous = elRef.current
      if (previous) {
        previous.removeEventListener('scroll', stableScrollHandler)
      }
      observerRef.current?.disconnect()
      observerRef.current = null
      elRef.current = node
      if (!node) return

      node.addEventListener('scroll', stableScrollHandler, { passive: true })

      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => {
          if (!pinnedRef.current) return
          node.scrollTop = node.scrollHeight
        })
        // Observing the container catches its own resize; observing the first
        // child catches content growth, which is the case that matters here.
        observer.observe(node)
        if (node.firstElementChild) observer.observe(node.firstElementChild)
        observerRef.current = observer
      }

      if (pinnedRef.current) {
        node.scrollTop = node.scrollHeight
      }
    },
    [stableScrollHandler]
  )

  return { ref, isPinned, scrollToBottom }
}
