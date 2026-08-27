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

/**
 * Events that mean the reader is driving the scroll themselves. Any of them
 * ends the settling guard below, whatever the animation is doing.
 */
const INPUT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

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
 * Growth is detected with a `ResizeObserver` on the container and on every
 * direct child rather than on a render count, so it also handles late-loading
 * images and fonts that change height after the text is already committed. A
 * `MutationObserver` keeps that set in step as messages are added and removed.
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
  const mutationRef = useRef<MutationObserver | null>(null)
  // Set only while a *smooth* scroll is animating. Instant scrolls need no
  // guard: the position check below is self-correcting, because a jump to the
  // bottom lands at the bottom. A smooth scroll passes through positions that
  // are not the bottom yet, which would otherwise read as "reader scrolled up".
  //
  // Reaching the bottom is not the only way out of this state. A reader who
  // scrolls away mid-animation has to be able to unpin, so their own input
  // clears the flag too — otherwise the guard swallows the one event that
  // matters and the next growth drags them back down.
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

  // The reader took over. A smooth scroll that is still animating no longer
  // owns the scroll position, so stop treating its frames as unreadable.
  const stableInputHandler = useRef(() => {
    settlingRef.current = false
  }).current

  const ref = useCallback(
    (node: T | null) => {
      const previous = elRef.current
      if (previous) {
        previous.removeEventListener('scroll', stableScrollHandler)
        for (const type of INPUT_EVENTS) {
          previous.removeEventListener(type, stableInputHandler)
        }
      }
      observerRef.current?.disconnect()
      observerRef.current = null
      mutationRef.current?.disconnect()
      mutationRef.current = null
      settlingRef.current = false
      elRef.current = node
      if (!node) return

      node.addEventListener('scroll', stableScrollHandler, { passive: true })
      for (const type of INPUT_EVENTS) {
        node.addEventListener(type, stableInputHandler, { passive: true })
      }

      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => {
          if (!pinnedRef.current) return
          node.scrollTop = node.scrollHeight
        })
        // Observing the container catches its own resize. Content grows inside
        // it, where the container's border box never moves, so every direct
        // child is observed too. Watching only the first child was the earlier
        // shape and it missed two ordinary cases: a chat that mounts with no
        // messages has no first child to find, and a chat that renders one
        // element per message grows by adding siblings the first child knows
        // nothing about.
        observer.observe(node)
        for (const child of Array.from(node.children)) observer.observe(child)
        observerRef.current = observer

        // Children arrive and leave after mount, so the observed set has to
        // follow them. Observing a fresh element fires the callback with its
        // initial size, which is what re-pins the view when a message lands.
        if (typeof MutationObserver !== 'undefined') {
          const mutation = new MutationObserver((records) => {
            for (const record of records) {
              for (const added of Array.from(record.addedNodes)) {
                if (added instanceof Element) observer.observe(added)
              }
              for (const removed of Array.from(record.removedNodes)) {
                if (removed instanceof Element) observer.unobserve(removed)
              }
            }
          })
          // ponytail: direct children only. A container that grows by mutating
          // a deep descendant instead of its own child list would need
          // `subtree: true`, at the cost of a record per keystroke.
          mutation.observe(node, { childList: true })
          mutationRef.current = mutation
        }
      }

      if (pinnedRef.current) {
        node.scrollTop = node.scrollHeight
      }
    },
    [stableInputHandler, stableScrollHandler]
  )

  return { ref, isPinned, scrollToBottom }
}
