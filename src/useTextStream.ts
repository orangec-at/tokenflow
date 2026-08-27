import { useCallback, useEffect, useRef, useState } from 'react'
import { SSEParser, type SSEEvent } from './parseSSE'
import { useStreamingText, type UseStreamingTextOptions } from './useStreamingText'

export type StreamStatus = 'idle' | 'streaming' | 'done' | 'aborted' | 'error'

export type UseTextStreamOptions = {
  /**
   * Pull the text out of one SSE event. Return `null` to ignore the event and
   * `false` to end the stream (the OpenAI-style `[DONE]` sentinel).
   *
   * Defaults to treating `data` as the text and `[DONE]` as the terminator, so
   * a plain `data: hello` stream works with no configuration.
   */
  selectText?: (event: SSEEvent) => string | null | false
  /** Retries per attempt after a network failure. Defaults to 2. */
  retries?: number
  /** Base delay for exponential backoff, in ms. Defaults to 500. */
  retryDelayMs?: number
  /** Commit tokens per animation frame (default) or on every chunk. */
  mode?: 'frame' | 'immediate'
  /** Injectable frame scheduler. Tests pass a deterministic one. */
  scheduler?: UseStreamingTextOptions['scheduler']
  onDone?: (text: string) => void
  onError?: (error: Error) => void
}

export type UseTextStream = {
  text: string
  status: StreamStatus
  error: Error | null
  /** Renders performed while streaming. Compare 'frame' vs 'immediate'. */
  commitCount: number
  /** Begin a stream. Calling it while one is running aborts the previous. */
  start: (input: RequestInfo | URL, init?: RequestInit) => Promise<void>
  /** Abort the in-flight stream. Text committed so far is kept. */
  stop: () => void
  /** Abort and clear. */
  reset: () => void
}

const DONE = '[DONE]'

function defaultSelectText(event: SSEEvent): string | null | false {
  if (event.data === DONE) return false
  return event.data
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })

const isAbort = (e: unknown): boolean =>
  e instanceof DOMException ? e.name === 'AbortError' : (e as Error)?.name === 'AbortError'

/**
 * Consumes a `text/event-stream` response into per-frame batched React state.
 *
 * Combines {@link useStreamingText} with a fetch + `ReadableStream` reader that
 * handles the parts people usually discover in production: chunk boundaries
 * that split an event in half, aborting a stream cleanly, retrying a connection
 * that dropped before the first byte, and flushing the tail so the last tokens
 * are not swallowed.
 *
 * Retries only fire when nothing has been rendered yet. Once text is on screen,
 * silently reconnecting would duplicate it — so a mid-stream failure surfaces as
 * an error and keeps what the reader already saw.
 */
export function useTextStream(options: UseTextStreamOptions = {}): UseTextStream {
  const {
    selectText = defaultSelectText,
    retries = 2,
    retryDelayMs = 500,
    mode = 'frame',
    scheduler,
    onDone,
    onError,
  } = options

  const { text, push, flush, reset: resetText, commitCount, getText } =
    useStreamingText({ mode, scheduler })
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [error, setError] = useState<Error | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const parserRef = useRef(new SSEParser())

  // Keep callbacks fresh without making `start` change identity every render.
  const cbRef = useRef({ selectText, onDone, onError })
  cbRef.current = { selectText, onDone, onError }

  const stop = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  const reset = useCallback(() => {
    stop()
    parserRef.current.reset()
    resetText('')
    setStatus('idle')
    setError(null)
  }, [resetText, stop])

  const start = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      stop()
      parserRef.current.reset()
      resetText('')
      setError(null)
      setStatus('streaming')

      const controller = new AbortController()
      controllerRef.current = controller

      // `false` from selectText ends the stream; track it so the retry loop
      // does not treat a clean finish as something to retry.
      let receivedAnyText = false

      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetch(input, {
            ...init,
            signal: controller.signal,
            headers: { Accept: 'text/event-stream', ...(init.headers ?? {}) },
          })

          if (!response.ok) {
            throw new Error(`Stream failed: ${response.status} ${response.statusText}`)
          }
          if (!response.body) {
            throw new Error('Stream failed: response has no body')
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let ended = false

          try {
            while (!ended) {
              const { done, value } = await reader.read()
              if (done) break

              const events = parserRef.current.push(
                decoder.decode(value, { stream: true })
              )
              for (const event of events) {
                const selected = cbRef.current.selectText(event)
                if (selected === false) {
                  ended = true
                  break
                }
                if (selected === null || selected === '') continue
                receivedAnyText = true
                push(selected)
              }
            }

            if (!ended) {
              for (const event of parserRef.current.flush()) {
                const selected = cbRef.current.selectText(event)
                if (selected === false) break
                if (selected === null || selected === '') continue
                receivedAnyText = true
                push(selected)
              }
            }
          } finally {
            // Releasing before cancel avoids a "reader is locked" TypeError in
            // browsers when we bail out early on the [DONE] sentinel.
            reader.releaseLock()
            if (ended) await response.body.cancel().catch(() => {})
          }

          flush()
          controllerRef.current = null
          setStatus('done')
          cbRef.current.onDone?.(getText())
          return
        } catch (e) {
          if (isAbort(e) || controller.signal.aborted) {
            flush()
            controllerRef.current = null
            setStatus('aborted')
            return
          }

          const canRetry = attempt < retries && !receivedAnyText
          if (canRetry) {
            parserRef.current.reset()
            try {
              await sleep(retryDelayMs * 2 ** attempt, controller.signal)
            } catch {
              flush()
              controllerRef.current = null
              setStatus('aborted')
              return
            }
            continue
          }

          const err = e instanceof Error ? e : new Error(String(e))
          flush()
          controllerRef.current = null
          setError(err)
          setStatus('error')
          cbRef.current.onError?.(err)
          return
        }
      }
    },
    [flush, getText, push, resetText, retries, retryDelayMs, stop]
  )

  useEffect(() => () => controllerRef.current?.abort(), [])

  return { text, status, error, commitCount, start, stop, reset }
}
