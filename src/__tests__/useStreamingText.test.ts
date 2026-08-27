import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useStreamingText } from '../useStreamingText'

/**
 * Deterministic stand-in for requestAnimationFrame. `tick()` runs whatever the
 * hook scheduled, which lets a test say "one frame passed" without timers.
 */
function manualScheduler() {
  let next = 1
  const queued = new Map<number, () => void>()
  return {
    schedule: (fn: () => void) => {
      const handle = next++
      queued.set(handle, fn)
      return handle
    },
    cancel: (handle: number) => {
      queued.delete(handle)
    },
    tick() {
      const pending = [...queued.values()]
      queued.clear()
      pending.forEach((fn) => fn())
    },
    get pending() {
      return queued.size
    },
  }
}

describe('useStreamingText', () => {
  it('starts from initialText and holds chunks until the frame fires', () => {
    const s = manualScheduler()
    const { result } = renderHook(() =>
      useStreamingText({ initialText: 'seed:', scheduler: s })
    )

    act(() => result.current.push('a'))
    expect(result.current.text).toBe('seed:')

    act(() => s.tick())
    expect(result.current.text).toBe('seed:a')
  })

  it('collapses every chunk in one frame into a single commit', () => {
    const s = manualScheduler()
    const { result } = renderHook(() => useStreamingText({ scheduler: s }))

    act(() => {
      for (const t of ['t', 'o', 'k', 'e', 'n']) result.current.push(t)
    })
    // Five pushes, one scheduled frame.
    expect(s.pending).toBe(1)

    act(() => s.tick())
    expect(result.current.text).toBe('token')
    expect(result.current.commitCount).toBe(1)
  })

  it('commits once per frame across several frames', () => {
    const s = manualScheduler()
    const { result } = renderHook(() => useStreamingText({ scheduler: s }))

    act(() => {
      result.current.push('a')
      result.current.push('b')
    })
    act(() => s.tick())
    act(() => {
      result.current.push('c')
    })
    act(() => s.tick())

    expect(result.current.text).toBe('abc')
    expect(result.current.commitCount).toBe(2)
  })

  it('commits on every chunk in immediate mode', () => {
    const s = manualScheduler()
    const { result } = renderHook(() =>
      useStreamingText({ mode: 'immediate', scheduler: s })
    )

    act(() => {
      for (const t of ['t', 'o', 'k', 'e', 'n']) result.current.push(t)
    })

    expect(result.current.text).toBe('token')
    expect(result.current.commitCount).toBe(5)
    expect(s.pending).toBe(0)
  })

  it('batches fewer commits than immediate mode for the same input', () => {
    const chunks = Array.from({ length: 200 }, (_, i) => String(i % 10))

    const batched = manualScheduler()
    const a = renderHook(() => useStreamingText({ scheduler: batched }))
    // 200 tokens arriving across 4 frames.
    act(() => {
      chunks.forEach((c, i) => {
        a.result.current.push(c)
        if (i % 50 === 49) batched.tick()
      })
    })

    const immediate = manualScheduler()
    const b = renderHook(() =>
      useStreamingText({ mode: 'immediate', scheduler: immediate })
    )
    act(() => chunks.forEach((c) => b.result.current.push(c)))

    expect(a.result.current.text).toBe(b.result.current.text)
    expect(a.result.current.commitCount).toBe(4)
    expect(b.result.current.commitCount).toBe(200)
  })

  it('flush commits buffered chunks without waiting for a frame', () => {
    const s = manualScheduler()
    const { result } = renderHook(() => useStreamingText({ scheduler: s }))

    act(() => {
      result.current.push('tail')
      result.current.flush()
    })

    expect(result.current.text).toBe('tail')
    // The scheduled frame was cancelled, so a later tick must not double-commit.
    act(() => s.tick())
    expect(result.current.text).toBe('tail')
    expect(result.current.commitCount).toBe(1)
  })

  it('flush is a no-op when the buffer is empty', () => {
    const s = manualScheduler()
    const { result } = renderHook(() => useStreamingText({ scheduler: s }))
    act(() => result.current.flush())
    expect(result.current.commitCount).toBe(0)
  })

  it('ignores empty chunks so they do not schedule a wasted frame', () => {
    const s = manualScheduler()
    const { result } = renderHook(() => useStreamingText({ scheduler: s }))
    act(() => result.current.push(''))
    expect(s.pending).toBe(0)
  })

  it('reset drops buffered chunks and clears the text', () => {
    const s = manualScheduler()
    const { result } = renderHook(() => useStreamingText({ scheduler: s }))

    act(() => {
      result.current.push('gone')
      result.current.reset()
    })
    act(() => s.tick())

    expect(result.current.text).toBe('')
    expect(result.current.commitCount).toBe(0)
  })

  it('reset can seed new text', () => {
    const s = manualScheduler()
    const { result } = renderHook(() => useStreamingText({ scheduler: s }))
    act(() => result.current.reset('fresh'))
    expect(result.current.text).toBe('fresh')
  })

  it('cancels the pending frame on unmount', () => {
    const s = manualScheduler()
    const { result, unmount } = renderHook(() => useStreamingText({ scheduler: s }))

    act(() => result.current.push('x'))
    expect(s.pending).toBe(1)

    unmount()
    // Nothing left scheduled means no setState on an unmounted component.
    expect(s.pending).toBe(0)
  })
})
