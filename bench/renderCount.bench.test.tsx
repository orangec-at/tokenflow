import { act, render } from '@testing-library/react'
import { memo, useEffect, useRef } from 'react'
import { describe, expect, it } from 'vitest'
import { useStreamingText } from '../src/useStreamingText'

/**
 * Render-count benchmark for per-frame batching.
 *
 * This is not a microbenchmark of the hook itself — the hook is a few lines of
 * array work and is never the bottleneck. What it measures is the thing that
 * actually costs frames in a streaming UI: how many times React is asked to
 * re-render the message subtree while tokens arrive.
 *
 * The benchmark awaits a macrotask between tokens on purpose. React 18 already
 * auto-batches state updates that happen in the same tick, so a synchronous
 * `for` loop of `setState` calls collapses into one render on its own and
 * batching would look pointless. A network stream does not behave that way:
 * every `await reader.read()` resolves in its own task, so each token gets its
 * own render. That gap is the one this hook closes.
 *
 * Run with `pnpm bench`. The numbers count commits, not milliseconds, so they
 * reproduce on any machine.
 */

type Scheduler = {
  schedule: (fn: () => void) => number
  cancel: (handle: number) => void
}

/** Drives frames explicitly so the benchmark is deterministic. */
function manualScheduler() {
  let next = 1
  const queued = new Map<number, () => void>()
  const scheduler: Scheduler = {
    schedule: (fn) => {
      const handle = next++
      queued.set(handle, fn)
      return handle
    },
    cancel: (handle) => {
      queued.delete(handle)
    },
  }
  return {
    scheduler,
    tick() {
      const pending = [...queued.values()]
      queued.clear()
      pending.forEach((fn) => fn())
    },
  }
}

/** Stands in for the expensive subtree below a streamed message. */
const Message = memo(function Message({
  text,
  onRender,
}: {
  text: string
  onRender: () => void
}) {
  onRender()
  return <div data-testid="msg">{text}</div>
})

type Result = { renders: number; text: string; ms: number }

/** Yields to the macrotask queue, the way an awaited stream read does. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function runStream(
  mode: 'frame' | 'immediate',
  tokens: string[],
  tokensPerFrame: number
): Promise<Result> {
  const { scheduler, tick } = manualScheduler()
  let renders = 0
  const countRender = () => {
    renders += 1
  }

  let push!: (chunk: string) => void
  let flush!: () => void
  const seen = { text: '' }

  function Harness() {
    const s = useStreamingText({ mode, scheduler })
    push = s.push
    flush = s.flush
    const ref = useRef(s)
    ref.current = s
    useEffect(() => {
      seen.text = s.text
    })
    return <Message text={s.text} onRender={countRender} />
  }

  const started = performance.now()
  const view = render(<Harness />)

  for (let i = 0; i < tokens.length; i++) {
    // Each token lands in its own task, exactly as it does behind a real
    // `await reader.read()`. React cannot auto-batch across these.
    await act(async () => {
      push(tokens[i]!)
      await nextTask()
      if (mode === 'frame' && (i + 1) % tokensPerFrame === 0) tick()
    })
  }
  await act(async () => {
    flush()
  })

  const ms = performance.now() - started
  const text = view.getByTestId('msg').textContent ?? ''
  view.unmount()
  return { renders, text, ms }
}

/** Tokens roughly the size an LLM emits: mostly word fragments. */
function makeTokens(count: number): string[] {
  const pieces = ['the ', 'quick ', 'brown ', 'fox ', 'jumps ', 'over ', 'a ', 'lazy ', 'dog. ']
  return Array.from({ length: count }, (_, i) => pieces[i % pieces.length]!)
}

function report(label: string, immediate: Result, framed: Result, tokens: number) {
  const saved = immediate.renders - framed.renders
  const pct = ((saved / immediate.renders) * 100).toFixed(1)
  /* eslint-disable no-console */
  console.log(`\n  ${label}`)
  console.log(`    tokens streamed      ${tokens}`)
  console.log(`    renders (immediate)  ${immediate.renders}`)
  console.log(`    renders (frame)      ${framed.renders}`)
  console.log(`    reduction            ${pct}%  (${saved} fewer renders)`)
  console.log(`    output identical     ${immediate.text === framed.text}`)
  /* eslint-enable no-console */
  return Number(pct)
}

describe('render-count benchmark', () => {
  it('60 tokens per frame (fast stream, ~1000 tok/s at 60fps)', async () => {
    const tokens = makeTokens(300)
    const immediate = await runStream('immediate', tokens, 60)
    const framed = await runStream('frame', tokens, 60)

    const pct = report('fast stream', immediate, framed, tokens.length)

    // Same visible result, far fewer renders.
    expect(framed.text).toBe(immediate.text)
    expect(framed.renders).toBeLessThan(immediate.renders)
    expect(pct).toBeGreaterThan(90)
  })

  it('5 tokens per frame (typical stream, ~300 tok/s at 60fps)', async () => {
    const tokens = makeTokens(300)
    const immediate = await runStream('immediate', tokens, 5)
    const framed = await runStream('frame', tokens, 5)

    const pct = report('typical stream', immediate, framed, tokens.length)

    expect(framed.text).toBe(immediate.text)
    expect(pct).toBeGreaterThan(70)
  })

  it('1 token per frame (slow stream — batching cannot help, and must not hurt)', async () => {
    const tokens = makeTokens(120)
    const immediate = await runStream('immediate', tokens, 1)
    const framed = await runStream('frame', tokens, 1)

    report('slow stream', immediate, framed, tokens.length)

    // One token per frame is already one render per token. The honest claim is
    // that batching costs nothing here, not that it magically wins.
    expect(framed.text).toBe(immediate.text)
    expect(framed.renders).toBeLessThanOrEqual(immediate.renders + 1)
  })
})
