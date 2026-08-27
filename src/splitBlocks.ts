export type Block = {
  /** Stable across commits once `done` is true. Use as a React key. */
  id: number
  text: string
  /**
   * True once no further text can be appended to this block. A done block is
   * byte-identical on every later commit, which is what lets a memoized
   * renderer skip it.
   */
  done: boolean
}

export type SplitState = {
  /** Blocks that can never change again. */
  settled: Block[]
  /** Offset into the source text where the still-open block begins. */
  openStart: number
  /** Whether the open block is inside an unclosed fenced code block. */
  inFence: boolean
  /** The fence marker that opened the current fence, e.g. ``` or ~~~~. */
  fenceMarker: string
  /** Length of source text already consumed. Guards against non-append edits. */
  consumed: number
}

export function initialSplitState(): SplitState {
  return { settled: [], openStart: 0, inFence: false, fenceMarker: '', consumed: 0 }
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/

/**
 * Reads a fence opener or closer out of a line.
 *
 * A closing fence must use the same character as the opener and be at least as
 * long, and must carry no info string — that is what the CommonMark spec says,
 * and streams do produce ```` ```ts ```` openers whose closer is a bare ``` ```` ````.
 */
function fenceOf(line: string): { marker: string; hasInfo: boolean } | null {
  const m = FENCE.exec(line)
  if (!m) return null
  return { marker: m[2]!, hasInfo: m[3]!.trim().length > 0 }
}

function closes(line: string, openMarker: string): boolean {
  const f = fenceOf(line)
  if (!f || f.hasInfo) return false
  return f.marker[0] === openMarker[0] && f.marker.length >= openMarker.length
}

/**
 * Advances the split by reading only the text appended since the last call.
 *
 * The whole point of freezing blocks is to stop re-reading a message from the
 * top on every token. A splitter that itself rescans the full string would
 * just move that cost one layer down, so this one keeps an offset and touches
 * only the tail. Across a whole stream it reads each character about once.
 *
 * Text is assumed to be append-only, which is what a token stream produces. If
 * a caller passes something that is not an extension of what came before, the
 * state resets and the text is re-split from scratch rather than silently
 * emitting wrong blocks.
 */
export function advance(state: SplitState, text: string): SplitState {
  if (text.length < state.consumed || !text.startsWith(text.slice(0, state.consumed))) {
    // Defensive: cannot happen for append-only input.
    state = initialSplitState()
  }
  // Cheap identity check for the common "nothing new arrived" commit.
  if (text.length === state.consumed) return state

  let { settled, openStart, inFence, fenceMarker } = state
  let mutated = false

  // Rescan from the start of the open block: the tail may contain a partial
  // line from the previous call that is now complete.
  let cursor = openStart
  let lineStart = openStart
  let blankRun = 0

  const commit = (endExclusive: number, nextStart: number) => {
    const body = text.slice(openStart, endExclusive)
    if (body.trim().length > 0) {
      if (!mutated) {
        settled = settled.slice()
        mutated = true
      }
      settled.push({ id: settled.length, text: body, done: true })
    }
    openStart = nextStart
  }

  while (cursor < text.length) {
    const nl = text.indexOf('\n', cursor)
    // A line without a trailing newline is still being written; leave it open.
    if (nl === -1) break

    const line = text.slice(lineStart, nl)

    if (inFence) {
      if (closes(line, fenceMarker)) {
        inFence = false
        fenceMarker = ''
        // The fence's closing line belongs to the block; it ends here.
        commit(nl + 1, nl + 1)
      }
      blankRun = 0
    } else {
      const opener = fenceOf(line)
      if (opener) {
        // A fence opening mid-block ends the prose that came before it.
        if (lineStart > openStart) commit(lineStart, lineStart)
        inFence = true
        fenceMarker = opener.marker
        blankRun = 0
      } else if (line.trim() === '') {
        blankRun += 1
        // One blank line closes a paragraph. Runs of them collapse.
        if (blankRun === 1 && lineStart > openStart) commit(lineStart, nl + 1)
        else openStart = nl + 1
      } else {
        blankRun = 0
      }
    }

    cursor = nl + 1
    lineStart = nl + 1
  }

  return {
    settled,
    openStart,
    inFence,
    fenceMarker,
    consumed: text.length,
  }
}

/**
 * The blocks to render: every settled block, plus the open one if it has
 * content. Only the last entry can be `done: false`.
 */
export function blocksOf(state: SplitState, text: string): Block[] {
  const open = text.slice(state.openStart)
  if (open.trim().length === 0) return state.settled
  return [...state.settled, { id: state.settled.length, text: open, done: false }]
}
