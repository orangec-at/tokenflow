import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Schedules a callback on the next animation frame, falling back to a timeout
 * where rAF does not exist (SSR, jsdom, Node). The fallback interval matches a
 * 60fps budget so batching behaviour stays comparable in tests.
 */
type Scheduler = {
  schedule: (fn: () => void) => number
  cancel: (handle: number) => void
}

const FRAME_MS = 16

function defaultScheduler(): Scheduler {
  if (typeof requestAnimationFrame === 'function') {
    return {
      schedule: (fn) => requestAnimationFrame(fn),
      cancel: (handle) => cancelAnimationFrame(handle),
    }
  }
  return {
    schedule: (fn) => setTimeout(fn, FRAME_MS) as unknown as number,
    cancel: (handle) => clearTimeout(handle),
  }
}

export type UseStreamingTextOptions = {
  /** Initial text to start from. Defaults to an empty string. */
  initialText?: string
  /**
   * Flush the buffer at most once per frame (default) or immediately on every
   * chunk. `immediate` exists so you can A/B the two in your own app and see
   * the render difference for your content.
   */
  mode?: 'frame' | 'immediate'
  /** Injectable scheduler. Tests pass a deterministic one; apps should not. */
  scheduler?: Scheduler
}

export type UseStreamingText = {
  /** The text committed to React state. Safe to render. */
  text: string
  /**
   * Queue a chunk. In `frame` mode the chunk lands in a buffer and is committed
   * on the next animation frame together with everything else queued in the
   * same frame.
   */
  push: (chunk: string) => void
  /**
   * Commit whatever is buffered right now. Call this when the stream ends so
   * the final tokens are not left sitting in the buffer.
   */
  flush: () => void
  /** Drop buffered chunks and reset the committed text. */
  reset: (text?: string) => void
  /** Number of React state commits performed. Used by the benchmark. */
  commitCount: number
  /**
   * The committed text read synchronously, without waiting for React to
   * re-render. Use this in callbacks that fire in the same tick as `flush()` —
   * `text` is still the previous render's value at that point.
   */
  getText: () => string
}

/**
 * Buffers streamed chunks and commits them to React state at most once per
 * animation frame.
 *
 * A token stream that arrives faster than the display refresh rate does not
 * need one render per token: every token that lands inside the same frame is
 * painted at the same moment anyway. Batching per frame keeps the visible
 * result identical while cutting the number of renders — which matters when the
 * subtree below is expensive (markdown, syntax highlighting, math).
 *
 * ```tsx
 * const { text, push, flush } = useStreamingText()
 * // for await (const chunk of stream) push(chunk)
 * // flush() when the stream ends
 * ```
 */
export function useStreamingText(
  options: UseStreamingTextOptions = {}
): UseStreamingText {
  const { initialText = '', mode = 'frame' } = options

  const [text, setText] = useState(initialText)
  // Authoritative, synchronously-readable copy. `text` lags it by one render.
  const textRef = useRef(initialText)
  const bufferRef = useRef<string[]>([])
  const handleRef = useRef<number | null>(null)
  const commitCountRef = useRef(0)
  const [commitCount, setCommitCount] = useState(0)

  // Resolved once so a re-render never swaps the scheduler mid-stream.
  const schedulerRef = useRef<Scheduler>()
  if (!schedulerRef.current) {
    schedulerRef.current = options.scheduler ?? defaultScheduler()
  }

  const commit = useCallback(() => {
    handleRef.current = null
    if (bufferRef.current.length === 0) return
    const joined = bufferRef.current.join('')
    bufferRef.current = []
    commitCountRef.current += 1
    textRef.current += joined
    setText(textRef.current)
    setCommitCount(commitCountRef.current)
  }, [])

  const push = useCallback(
    (chunk: string) => {
      if (chunk === '') return
      bufferRef.current.push(chunk)
      if (mode === 'immediate') {
        commit()
        return
      }
      if (handleRef.current === null) {
        handleRef.current = schedulerRef.current!.schedule(commit)
      }
    },
    [commit, mode]
  )

  const flush = useCallback(() => {
    if (handleRef.current !== null) {
      schedulerRef.current!.cancel(handleRef.current)
      handleRef.current = null
    }
    commit()
  }, [commit])

  const reset = useCallback((next = '') => {
    if (handleRef.current !== null) {
      schedulerRef.current!.cancel(handleRef.current)
      handleRef.current = null
    }
    bufferRef.current = []
    commitCountRef.current = 0
    textRef.current = next
    setCommitCount(0)
    setText(next)
  }, [])

  useEffect(() => {
    return () => {
      if (handleRef.current !== null) {
        schedulerRef.current!.cancel(handleRef.current)
      }
    }
  }, [])

  const getText = useCallback(() => textRef.current, [])

  return { text, push, flush, reset, commitCount, getText }
}
