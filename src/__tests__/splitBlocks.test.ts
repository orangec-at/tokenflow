import { describe, expect, it } from 'vitest'
import { advance, blocksOf, initialSplitState, type Block } from '../splitBlocks'

/** Feeds `text` one chunk at a time, the way a stream would. */
function stream(chunks: string[]): { blocks: Block[]; scans: number } {
  let state = initialSplitState()
  let text = ''
  let scans = 0
  for (const chunk of chunks) {
    const before = state.consumed
    text += chunk
    state = advance(state, text)
    scans += text.length - before
  }
  return { blocks: blocksOf(state, text), scans }
}

/** Splits the whole string in one go — the non-streaming reference result. */
function whole(text: string): Block[] {
  return blocksOf(advance(initialSplitState(), text), text)
}

const texts = (blocks: Block[]) => blocks.map((b) => b.text)
const dones = (blocks: Block[]) => blocks.map((b) => b.done)

describe('splitBlocks', () => {
  it('leaves a single unfinished paragraph open', () => {
    const b = whole('hello there')
    expect(texts(b)).toEqual(['hello there'])
    expect(dones(b)).toEqual([false])
  })

  it('returns nothing for empty or blank text', () => {
    expect(whole('')).toEqual([])
    expect(whole('\n\n  \n')).toEqual([])
  })

  it('settles a paragraph once a blank line follows it', () => {
    const b = whole('first para\n\nsecond')
    expect(texts(b)).toEqual(['first para\n', 'second'])
    expect(dones(b)).toEqual([true, false])
  })

  it('settles every paragraph but the last', () => {
    const b = whole('a\n\nb\n\nc\n\nd')
    expect(dones(b)).toEqual([true, true, true, false])
    expect(texts(b).map((t) => t.trim())).toEqual(['a', 'b', 'c', 'd'])
  })

  it('collapses runs of blank lines instead of emitting empty blocks', () => {
    const b = whole('a\n\n\n\n\nb')
    expect(texts(b).map((t) => t.trim())).toEqual(['a', 'b'])
  })

  it('keeps a fenced code block whole across its blank lines', () => {
    // A naive blank-line split would cut this code block into three.
    const b = whole('```js\nconst a = 1\n\nconst b = 2\n```\n\nafter')
    expect(texts(b)[0]).toBe('```js\nconst a = 1\n\nconst b = 2\n```\n')
    expect(dones(b)).toEqual([true, false])
  })

  it('never settles an unclosed fence', () => {
    // Mid-stream the closing ``` has not arrived; the block must stay open or a
    // memoized renderer would freeze a half-written code block.
    const b = whole('intro\n\n```js\nconst a = 1\n\nconst b = 2\n')
    expect(dones(b)).toEqual([true, false])
    expect(texts(b)[1]).toContain('```js')
  })

  it('ends the prose before a fence that opens mid-block', () => {
    const b = whole('some prose\n```js\ncode\n```\n\ntail')
    expect(texts(b)[0]).toBe('some prose\n')
    expect(texts(b)[1]).toBe('```js\ncode\n```\n')
    expect(dones(b)).toEqual([true, true, false])
  })

  it('requires the closer to match the opener', () => {
    // ~~~ does not close a ``` fence, and a closer carrying an info string is
    // an opener, not a closer.
    const b = whole('````\ncode\n~~~\nstill code\n')
    expect(b).toHaveLength(1)
    expect(dones(b)).toEqual([false])
  })

  it('accepts a longer closer than the opener', () => {
    const b = whole('```\ncode\n`````\n\nafter')
    expect(dones(b)).toEqual([true, false])
  })

  it('treats a closer with an info string as not closing', () => {
    const b = whole('```\ncode\n``` js\nmore\n')
    expect(b).toHaveLength(1)
    expect(dones(b)).toEqual([false])
  })

  it('produces the same result token by token as in one pass', () => {
    const full =
      'Intro paragraph here.\n\n' +
      '```ts\nconst x = 1\n\nconst y = 2\n```\n\n' +
      'Middle paragraph.\n\nAnother one.\n\nTrailing words'
    // Split into small chunks that land mid-line, mid-fence and mid-word.
    const chunks = full.match(/[\s\S]{1,7}/g)!
    const streamed = stream(chunks)
    expect(texts(streamed.blocks)).toEqual(texts(whole(full)))
    expect(dones(streamed.blocks)).toEqual(dones(whole(full)))
  })

  it('keeps settled blocks byte-identical as more text arrives', () => {
    // This is the property the whole hook rests on: if a settled block's text
    // changed later, a memoized renderer would show stale output.
    let state = initialSplitState()
    let text = ''
    const seen = new Map<number, string>()

    for (const chunk of 'one\n\ntwo\n\nthree\n\nfour'.match(/[\s\S]{1,3}/g)!) {
      text += chunk
      state = advance(state, text)
      for (const b of blocksOf(state, text)) {
        if (!b.done) continue
        const previous = seen.get(b.id)
        if (previous !== undefined) expect(b.text).toBe(previous)
        seen.set(b.id, b.text)
      }
    }
    expect(seen.size).toBe(3)
  })

  it('assigns ids that stay put', () => {
    let state = initialSplitState()
    let text = ''
    for (const chunk of ['a\n', '\n', 'b\n', '\n', 'c']) {
      text += chunk
      state = advance(state, text)
    }
    expect(blocksOf(state, text).map((b) => b.id)).toEqual([0, 1, 2])
  })

  it('reads each character about once across a whole stream', () => {
    // The point of the incremental splitter: were it rescanning from the top,
    // scans would be quadratic in the message length.
    const full = 'para one\n\npara two\n\npara three\n\n'.repeat(30)
    const chunks = full.match(/[\s\S]{1,5}/g)!
    const { scans } = stream(chunks)
    expect(scans).toBe(full.length)
  })

  it('re-splits from scratch if the text is not an extension', () => {
    let state = advance(initialSplitState(), 'alpha\n\nbeta')
    expect(blocksOf(state, 'alpha\n\nbeta')).toHaveLength(2)
    // A caller that replaces the text rather than appending must not get blocks
    // left over from the old string.
    state = advance(state, 'zzz')
    expect(texts(blocksOf(state, 'zzz'))).toEqual(['zzz'])
  })

  it('handles a message that ends on a block boundary', () => {
    const b = whole('done para\n\n')
    expect(dones(b)).toEqual([true])
    expect(texts(b)).toEqual(['done para\n'])
  })
})
