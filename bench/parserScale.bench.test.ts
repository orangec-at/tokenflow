import { createParser } from 'eventsource-parser'
import { describe, expect, it } from 'vitest'
import { SSEParser } from '../src/parseSSE'

/**
 * Does the carry buffer go quadratic?
 *
 * `SSEParser.push` does `carry += chunk` and then splits the whole carry
 * looking for a blank line. When events are small and complete that carry stays
 * short and the cost is linear. When a single event is large and arrives across
 * many reads, the carry keeps growing and every push copies and rescans all of
 * it — O(n²) in the number of chunks.
 *
 * eventsource-parser calls this out in its own source ("that's the O(N²) trap
 * we're..."), which is what prompted this measurement. It is the baseline here.
 *
 * Run with `pnpm bench`.
 */

/** Cuts a payload into fixed-size pieces the way a socket would. */
function chunked(payload: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < payload.length; i += size) out.push(payload.slice(i, i + size))
  return out
}

function timeOurs(chunks: string[]): { ms: number; events: number } {
  const p = new SSEParser()
  let events = 0
  const t0 = performance.now()
  for (const c of chunks) events += p.push(c).length
  events += p.flush().length
  return { ms: performance.now() - t0, events }
}

function timeReference(chunks: string[]): { ms: number; events: number } {
  let events = 0
  const p = createParser({ onEvent: () => { events += 1 } })
  const t0 = performance.now()
  for (const c of chunks) p.feed(c)
  return { ms: performance.now() - t0, events }
}

function report(label: string, chunks: string[]) {
  const ours = timeOurs(chunks)
  const ref = timeReference(chunks)
  const ratio = ours.ms / Math.max(ref.ms, 0.001)
  /* eslint-disable no-console */
  console.log(
    `    ${label.padEnd(30)} chunks ${String(chunks.length).padStart(6)}` +
      ` | SSEParser ${ours.ms.toFixed(1).padStart(8)}ms` +
      ` | eventsource-parser ${ref.ms.toFixed(1).padStart(7)}ms` +
      ` | ${ratio.toFixed(1).padStart(6)}x`
  )
  /* eslint-enable no-console */
  return { ours, ref }
}

describe('parser scaling', () => {
  it('stays linear when events are small and complete', () => {
    /* eslint-disable-next-line no-console */
    console.log('\n  many small events — the shape a token stream actually has\n')
    const small = Array.from({ length: 20_000 }, (_, i) => `data: token ${i}\n\n`).join('')

    // Chunk sizes around a TCP segment. The carry never grows past one event.
    const a = report('20k events, 64B chunks', chunked(small, 64))
    const b = report('20k events, 1400B chunks', chunked(small, 1400))

    expect(a.ours.events).toBe(20_000)
    expect(b.ours.events).toBe(20_000)
  }, 120_000)

  it('goes quadratic on one large event split across many chunks', () => {
    /* eslint-disable no-console */
    console.log('\n  one big event, no separator until the very end')
    console.log('  (a large tool result, an embedded image, a fat message_start)\n')

    const sizes = [200, 400, 800, 1600]
    const results: { chunks: number; ms: number }[] = []

    for (const n of sizes) {
      // A single `data:` line of n chunks. Nothing terminates it until the end.
      const payload = 'data: ' + 'x'.repeat(n * 512) + '\n\n'
      const chunks = chunked(payload, 512)
      const { ours } = report(`1 event in ${String(n).padStart(4)} chunks`, chunks)
      results.push({ chunks: chunks.length, ms: ours.ms })
    }

    // Doubling the chunk count should roughly double a linear parser's time and
    // roughly quadruple a quadratic one.
    console.log('\n    growth per doubling of chunk count (linear ~2x, quadratic ~4x):')
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1]!
      const cur = results[i]!
      console.log(
        `      ${String(prev.chunks).padStart(5)} -> ${String(cur.chunks).padStart(5)} chunks` +
          `   ${(cur.ms / Math.max(prev.ms, 0.001)).toFixed(2)}x`
      )
    }
    console.log('')
    /* eslint-enable no-console */

    const first = results[0]!
    const last = results[results.length - 1]!
    const chunkGrowth = last.chunks / first.chunks
    const timeGrowth = last.ms / Math.max(first.ms, 0.001)

    // 8x the chunks. Linear would be ~8x the time; quadratic ~64x.
    /* eslint-disable-next-line no-console */
    console.log(`    ${chunkGrowth}x the chunks cost ${timeGrowth.toFixed(1)}x the time\n`)
    // Linear would be about 8x for 8x the chunks. Allow generous slack for a
    // noisy machine, but nothing near the 93x this measured when the parser
    // concatenated on every push.
    expect(chunkGrowth).toBeGreaterThan(7)
    expect(timeGrowth).toBeLessThan(25)
  }, 120_000)
})
