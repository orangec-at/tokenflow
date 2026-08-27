import { useMemo, useRef } from 'react'
import { advance, blocksOf, initialSplitState, type Block, type SplitState } from './splitBlocks'

export type { Block }

/**
 * Splits a growing message into blocks and marks the ones that can no longer
 * change.
 *
 * Rendering a streaming message usually means handing the whole string to a
 * markdown renderer on every commit. Because the string grows a token at a
 * time, the renderer re-reads everything it has already read — the total work
 * is quadratic in the length of the message. Measured on a 600-character reply
 * that is 50x the message itself, and the ratio grows with length.
 *
 * Almost none of that re-reading is necessary. Once a paragraph is followed by
 * a blank line, or a fenced code block is closed, that text is final: no later
 * token can alter it. Only the last block is still open.
 *
 * This hook returns the blocks with that distinction. Render each one through
 * a memoized component and the settled blocks stop re-parsing:
 *
 * ```tsx
 * const blocks = useStreamingBlocks(text)
 * return blocks.map((b) => <MemoMarkdown key={b.id} text={b.text} />)
 * ```
 *
 * `id` is stable and `text` is byte-identical across commits for settled
 * blocks, so `React.memo` bails out on them without any custom comparator.
 *
 * The split itself is incremental — it reads only the text appended since the
 * last commit — so it does not reintroduce the cost it exists to remove.
 */
export function useStreamingBlocks(text: string): Block[] {
  const stateRef = useRef<SplitState>(initialSplitState())

  return useMemo(() => {
    stateRef.current = advance(stateRef.current, text)
    return blocksOf(stateRef.current, text)
  }, [text])
}
