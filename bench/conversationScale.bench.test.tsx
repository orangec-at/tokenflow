import { act, render } from '@testing-library/react'
import { memo, useState } from 'react'
import { describe, expect, it } from 'vitest'

/**
 * Does a long conversation get more expensive to stream into?
 *
 * The hooks in this package make one message cheap to render. This benchmark
 * asks the question one level up: when the last message in a thread is
 * streaming, what does the rest of the thread cost?
 *
 * It deliberately measures three different things, because they do not move
 * together and conflating them is how a library ends up solving a problem
 * React already solved:
 *
 *   renders     how many settled messages actually re-run their component
 *   parses      how much text a markdown-style parser re-reads, in characters
 *   elements    how many React elements the parent creates per commit
 *
 * `memo` is expected to drive `renders` to zero. It cannot touch `elements`,
 * because those are created by the parent's `.map()` before memo is consulted.
 * Whether that residue matters is what the numbers below decide.
 */

const TOKENS = 100
const SIZES = [0, 50, 200, 500]

type Msg = { id: number; text: string }

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Counters for one run. Reset between scenarios. */
function meter() {
  return {
    settledRenders: 0,
    streamingRenders: 0,
    parseCalls: 0,
    parseChars: 0,
    elements: 0,
  }
}
type Meter = ReturnType<typeof meter>

/**
 * Stand-in for a markdown renderer: cost proportional to the string it is
 * handed, which is what re-parsing a growing message actually costs.
 */
function parseMarkdown(text: string, m: Meter): string {
  m.parseCalls += 1
  m.parseChars += text.length
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash + text.charCodeAt(i)) | 0
  return `${hash}`
}

function makeThread(n: number): Msg[] {
  // Roughly the size of a short assistant reply, so parse cost is realistic.
  const body = 'Settled message body. '.repeat(12)
  return Array.from({ length: n }, (_, i) => ({ id: i, text: `${body}#${i}` }))
}

function buildMessage(useMemo: boolean) {
  const Settled = ({ text, m }: { text: string; m: Meter }) => {
    m.settledRenders += 1
    parseMarkdown(text, m)
    return <div>{text.length}</div>
  }
  return useMemo ? memo(Settled) : Settled
}

type Result = Meter & { ms: number }

/**
 * Renders a thread of `size` settled messages plus one streaming message, then
 * pushes TOKENS tokens into the streaming one. Each token lands in its own task,
 * the way an awaited stream read does, so React cannot auto-batch them away.
 */
async function run(size: number, useMemo: boolean): Promise<Result> {
  const m = meter()
  const Settled = buildMessage(useMemo)
  const thread = makeThread(size)

  let push!: (chunk: string) => void

  function Streaming({ text }: { text: string }) {
    m.streamingRenders += 1
    parseMarkdown(text, m)
    return <div data-testid="streaming">{text.length}</div>
  }

  function Chat() {
    // The shape people actually write: settled messages in state, the in-flight
    // text in state beside them, both owned by the same component.
    const [messages] = useState<Msg[]>(thread)
    const [streamingText, setStreamingText] = useState('')
    push = (chunk) => setStreamingText((prev) => prev + chunk)

    m.elements += messages.length + 1

    return (
      <div>
        {messages.map((msg) => (
          <Settled key={msg.id} text={msg.text} m={m} />
        ))}
        <Streaming text={streamingText} />
      </div>
    )
  }

  const started = performance.now()
  const view = render(<Chat />)

  // Ignore the mount pass; we are measuring the cost of streaming, not of
  // painting the thread once.
  const mountSettled = m.settledRenders
  const mountParseChars = m.parseChars
  const mountParseCalls = m.parseCalls
  const mountElements = m.elements

  for (let i = 0; i < TOKENS; i++) {
    await act(async () => {
      push('token ')
      await nextTask()
    })
  }

  const ms = performance.now() - started
  view.unmount()

  return {
    ...m,
    settledRenders: m.settledRenders - mountSettled,
    parseChars: m.parseChars - mountParseChars,
    parseCalls: m.parseCalls - mountParseCalls,
    elements: m.elements - mountElements,
    ms,
  }
}

function row(label: string, r: Result) {
  const mb = (r.parseChars / 1_000_000).toFixed(2)
  /* eslint-disable no-console */
  console.log(
    `    ${label.padEnd(18)} settled renders ${String(r.settledRenders).padStart(6)}` +
      ` | elements ${String(r.elements).padStart(6)}` +
      ` | parsed ${mb.padStart(6)}M chars` +
      ` | ${r.ms.toFixed(0).padStart(5)}ms`
  )
  /* eslint-enable no-console */
}

describe('conversation scale', () => {
  it('measures what a settled thread costs while the last message streams', async () => {
    /* eslint-disable no-console */
    console.log(`\n  streaming ${TOKENS} tokens into the last message\n`)
    const naive: Record<number, Result> = {}
    const memod: Record<number, Result> = {}

    for (const size of SIZES) {
      console.log(`  thread of ${size} settled messages`)
      naive[size] = await run(size, false)
      row('no memo', naive[size]!)
      memod[size] = await run(size, true)
      row('memo', memod[size]!)
      console.log('')
    }

    console.log('  summary')
    console.log('    scaling with thread length, per 100 streamed tokens:')
    for (const size of SIZES) {
      const n = naive[size]!
      const d = memod[size]!
      console.log(
        `      ${String(size).padStart(3)} msgs   ` +
          `renders ${String(n.settledRenders).padStart(6)} -> ${String(d.settledRenders).padStart(4)} with memo   ` +
          `elements ${String(d.elements).padStart(6)} (memo cannot remove these)   ` +
          `wall ${n.ms.toFixed(0).padStart(5)} -> ${d.ms.toFixed(0).padStart(5)}ms`
      )
    }
    console.log('')
    /* eslint-enable no-console */

    // The claim under test: without memo, cost grows with thread length.
    expect(naive[500]!.settledRenders).toBeGreaterThan(naive[50]!.settledRenders)

    // And the counter-claim: memo is not a partial fix here, it is a complete
    // one for re-renders. A library that "solves" this is selling memo back.
    expect(memod[500]!.settledRenders).toBe(0)

    // What memo cannot do: stop the parent from rebuilding the element list on
    // every commit. This is the residue, and the summary line reports it.
    expect(memod[500]!.elements).toBeGreaterThan(memod[50]!.elements)
  }, 120_000)

  it('measures how much text a growing message re-parses', async () => {
    const r = await run(0, true)
    const finalLength = TOKENS * 'token '.length
    // Re-parsing the whole string on each commit is quadratic in the message
    // length: roughly n^2/2 characters for n characters of output.
    const quadratic = (finalLength * finalLength) / 2

    /* eslint-disable no-console */
    console.log('\n  single message, no thread')
    console.log(`    final message length   ${finalLength} chars`)
    console.log(`    characters re-parsed   ${r.parseChars}`)
    console.log(`    parse calls            ${r.parseCalls}`)
    console.log(`    ratio to final length  ${(r.parseChars / finalLength).toFixed(1)}x`)
    console.log(`    quadratic prediction   ~${Math.round(quadratic)}\n`)
    /* eslint-enable no-console */

    // Re-reading the message from the top every commit costs far more than the
    // message itself. This is the cost a block-level freeze would remove.
    expect(r.parseChars).toBeGreaterThan(finalLength * 10)
  }, 120_000)
})
