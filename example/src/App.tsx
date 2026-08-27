import { memo, useEffect, useRef, useState } from 'react'
import { useStickToBottom, useTextStream } from 'tokenflow'
import { MOCK_URL, installMockFetch, selectMockText } from './mockStream'

/**
 * Stands in for an expensive message subtree — a markdown renderer, a syntax
 * highlighter, anything that does real work per render. The busy loop makes the
 * cost of an extra render visible instead of theoretical.
 */
const ExpensiveMessage = memo(function ExpensiveMessage({
  text,
  workMs,
  onRender,
}: {
  text: string
  workMs: number
  onRender: () => void
}) {
  onRender()
  if (workMs > 0) {
    const until = performance.now() + workMs
    while (performance.now() < until) {
      /* deliberately blocking, to simulate a costly render */
    }
  }
  return <div className="message">{text}</div>
})

type Mode = 'frame' | 'immediate'

export default function App() {
  const [mode, setMode] = useState<Mode>('frame')
  const [tokensPerSecond, setTps] = useState(120)
  const [workMs, setWorkMs] = useState(2)

  const optionsRef = useRef({ tokensPerSecond })
  optionsRef.current = { tokensPerSecond }
  useEffect(() => installMockFetch(() => optionsRef.current), [])

  const renderCount = useRef(0)
  const [, forceStat] = useState(0)
  const countRender = () => {
    renderCount.current += 1
  }

  const { text, status, error, start, stop, reset } = useTextStream({
    mode,
    selectText: selectMockText,
    onDone: () => forceStat((n) => n + 1),
  })

  const { ref, isPinned, scrollToBottom } = useStickToBottom<HTMLDivElement>()

  const run = () => {
    renderCount.current = 0
    void start(MOCK_URL)
  }

  const clear = () => {
    renderCount.current = 0
    reset()
    forceStat((n) => n + 1)
  }

  const streaming = status === 'streaming'

  return (
    <main>
      <header>
        <h1>tokenflow</h1>
        <p className="sub">
          Same stream, same output. Toggle the mode and watch the render counter.
        </p>
      </header>

      <section className="controls">
        <div className="field">
          <span className="label">Batching</span>
          <div className="segmented">
            {(['frame', 'immediate'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={streaming}
                className={mode === m ? 'on' : ''}
              >
                {m === 'frame' ? 'per frame' : 'every token'}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span className="label">
            Token rate <b>{tokensPerSecond}/s</b>
          </span>
          <input
            type="range"
            min={10}
            max={400}
            step={10}
            value={tokensPerSecond}
            onChange={(e) => setTps(Number(e.target.value))}
          />
        </label>

        <label className="field">
          <span className="label">
            Render cost <b>{workMs} ms</b>
          </span>
          <input
            type="range"
            min={0}
            max={8}
            step={1}
            value={workMs}
            onChange={(e) => setWorkMs(Number(e.target.value))}
          />
        </label>

        <div className="actions">
          <button onClick={run} disabled={streaming} className="primary">
            Stream
          </button>
          <button onClick={stop} disabled={!streaming}>
            Stop
          </button>
          <button onClick={clear} disabled={streaming}>
            Clear
          </button>
        </div>
      </section>

      <section className="stats">
        <Stat label="status" value={status} />
        <Stat label="renders" value={String(renderCount.current)} highlight />
        <Stat label="characters" value={String(text.length)} />
        <Stat label="pinned" value={isPinned ? 'yes' : 'no'} />
      </section>

      {error && <p role="alert" className="error">{error.message}</p>}

      <section className="viewport">
        <div ref={ref} className="scroller">
          <div>
            <ExpensiveMessage text={text} workMs={workMs} onRender={countRender} />
            {!text && <p className="empty">Press Stream to begin.</p>}
          </div>
        </div>
        {!isPinned && (
          <button className="jump" onClick={() => scrollToBottom('smooth')}>
            Jump to latest
          </button>
        )}
      </section>

      <footer>
        <p>
          Scroll up while it streams — the view stops following and the button
          appears. Set the token rate above ~60/s to see batching matter; below
          that there is nothing to batch and the counters converge.
        </p>
      </footer>
    </main>
  )
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className={highlight ? 'stat hl' : 'stat'}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}
