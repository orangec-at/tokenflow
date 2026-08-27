import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTextStream } from '../useTextStream'

const encoder = new TextEncoder()

/** Builds a Response whose body emits the given string chunks in order. */
function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(body, { status: 200, ...init })
}

/**
 * A body that never closes, so the stream stays open until aborted.
 *
 * Real `fetch` errors the body stream when its signal aborts; a hand-built
 * ReadableStream has no such wiring, so the mock has to do it explicitly or an
 * aborted read would hang forever instead of rejecting.
 */
function hangingResponse(chunks: string[], signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      // Deliberately no controller.close().
      signal?.addEventListener(
        'abort',
        () => {
          try {
            controller.error(new DOMException('Aborted', 'AbortError'))
          } catch {
            // Already closed or errored — nothing to do.
          }
        },
        { once: true }
      )
    },
  })
  return new Response(body, { status: 200 })
}

/**
 * A body that yields one chunk, then errors on the next pull. `controller.error()`
 * called straight after `enqueue()` discards the queue, so the chunk has to be
 * delivered by a separate pull for the reader to actually see it.
 */
function failAfterFirstChunk(chunk: string): Response {
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) {
        controller.enqueue(encoder.encode(chunk))
        return
      }
      controller.error(new Error('connection reset'))
    },
  })
  return new Response(body, { status: 200 })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTextStream', () => {
  it('accumulates text from an SSE stream and ends on [DONE]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(['data: Hel\n\n', 'data: lo \n\n', 'data: world\n\n', 'data: [DONE]\n\n'])
      )
    )

    const { result } = renderHook(() => useTextStream())
    await act(async () => {
      await result.current.start('/api/stream')
    })

    expect(result.current.text).toBe('Hello world')
    expect(result.current.status).toBe('done')
    expect(result.current.error).toBeNull()
  })

  it('reassembles events split across network chunks', async () => {
    vi.stubGlobal(
      'fetch',
      // The boundary falls inside the field name and inside the value.
      vi.fn(async () => sseResponse(['da', 'ta: par', 'tial\n', '\ndata: [DONE]\n\n']))
    )

    const { result } = renderHook(() => useTextStream())
    await act(async () => {
      await result.current.start('/api/stream')
    })

    expect(result.current.text).toBe('partial')
  })

  it('flushes a trailing event with no blank line before close', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['data: alpha\n\n', 'data: omega'])))

    const { result } = renderHook(() => useTextStream())
    await act(async () => {
      await result.current.start('/api/stream')
    })

    // 'omega' would be lost without the parser flush on stream end.
    expect(result.current.text).toBe('alphaomega')
    expect(result.current.status).toBe('done')
  })

  it('honours a custom selectText and skips ignored events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'event: ping\ndata: ignore-me\n\n',
          'event: token\ndata: {"t":"A"}\n\n',
          'event: token\ndata: {"t":"B"}\n\n',
          'event: end\ndata: bye\n\n',
        ])
      )
    )

    const { result } = renderHook(() =>
      useTextStream({
        selectText: (e) => {
          if (e.event === 'end') return false
          if (e.event !== 'token') return null
          return (JSON.parse(e.data) as { t: string }).t
        },
      })
    )
    await act(async () => {
      await result.current.start('/api/stream')
    })

    expect(result.current.text).toBe('AB')
    expect(result.current.status).toBe('done')
  })

  it('calls onDone with the final text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['data: fin\n\n', 'data: [DONE]\n\n'])))
    const onDone = vi.fn()

    const { result } = renderHook(() => useTextStream({ onDone }))
    await act(async () => {
      await result.current.start('/api/stream')
    })

    expect(onDone).toHaveBeenCalledWith('fin')
  })

  it('surfaces a non-ok response as an error after exhausting retries', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500, statusText: 'Server Error' }))
    vi.stubGlobal('fetch', fetchMock)
    const onError = vi.fn()

    const { result } = renderHook(() =>
      useTextStream({ retries: 1, retryDelayMs: 0, onError })
    )
    await act(async () => {
      await result.current.start('/api/stream')
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error?.message).toContain('500')
    // Initial attempt plus one retry.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalled()
  })

  it('retries a connection that failed before any text arrived', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(async () => sseResponse(['data: recovered\n\n', 'data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useTextStream({ retryDelayMs: 0 }))
    await act(async () => {
      await result.current.start('/api/stream')
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.text).toBe('recovered')
    expect(result.current.status).toBe('done')
  })

  it('does not retry once text has already been rendered', async () => {
    const fetchMock = vi.fn(async () => failAfterFirstChunk('data: half\n\n'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() =>
      useTextStream({ retries: 3, retryDelayMs: 0, mode: 'immediate' })
    )
    await act(async () => {
      await result.current.start('/api/stream')
    })

    // Reconnecting here would re-emit 'half' and duplicate it on screen.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('error')
    expect(result.current.text).toBe('half')
  })

  it('stop aborts the stream and keeps the text committed so far', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        hangingResponse(['data: kept\n\n'], init?.signal)
      )
    )

    const { result } = renderHook(() => useTextStream({ mode: 'immediate' }))
    let pending!: Promise<void>
    act(() => {
      pending = result.current.start('/api/stream')
    })
    await waitFor(() => expect(result.current.text).toBe('kept'))

    await act(async () => {
      result.current.stop()
      await pending
    })

    expect(result.current.status).toBe('aborted')
    expect(result.current.text).toBe('kept')
  })

  it('reset clears text and returns to idle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['data: x\n\n', 'data: [DONE]\n\n'])))

    const { result } = renderHook(() => useTextStream())
    await act(async () => {
      await result.current.start('/api/stream')
    })
    act(() => result.current.reset())

    expect(result.current.text).toBe('')
    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
  })

  it('sends the SSE Accept header and preserves caller headers', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        sseResponse(['data: [DONE]\n\n'])
    )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useTextStream())
    await act(async () => {
      await result.current.start('/api/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const init = fetchMock.mock.calls[0]![1]!
    expect(init.headers).toMatchObject({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    })
    expect(init.method).toBe('POST')
  })

  it('aborts an in-flight stream when a new one starts', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) =>
        hangingResponse(['data: first\n\n'], init?.signal)
      )
      .mockImplementationOnce(async () => sseResponse(['data: second\n\n', 'data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useTextStream({ mode: 'immediate' }))
    let first!: Promise<void>
    act(() => {
      first = result.current.start('/api/one')
    })
    await waitFor(() => expect(result.current.text).toBe('first'))

    await act(async () => {
      await Promise.all([result.current.start('/api/two'), first])
    })

    expect(result.current.text).toBe('second')
    expect(result.current.status).toBe('done')
  })
})
