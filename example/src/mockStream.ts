/**
 * A mock `text/event-stream` endpoint, so the demo runs with no API key and no
 * server. Installs itself over `fetch` for one URL and streams a canned answer
 * at a configurable token rate.
 */

const ANSWER = `Streaming a response is not hard until the subtree below it costs something.

A markdown renderer re-parses the whole string on every token. A syntax highlighter re-tokenizes every code block. A math renderer re-lays-out every equation. None of that is a problem at one token per frame — and all of it is a problem at twenty.

The fix is not to render less. It is to render the same thing fewer times: collect every token that lands inside one animation frame and commit them together. The reader cannot tell the difference, because the display could not have shown the intermediate states anyway.

Scroll has the same shape of problem. Pinning the view to the bottom on every update is correct right up until someone scrolls up to re-read a paragraph, at which point it becomes a fight the reader always loses.

And when the stream ends, whatever is still sitting in the buffer has to be committed — otherwise the answer stops mid-`

const MOCK_URL = '/mock/stream'

export { MOCK_URL }

export type MockOptions = {
  /** Tokens emitted per second. */
  tokensPerSecond: number
}

/** Splits text into chunks about the size a real tokenizer emits. */
function tokenize(text: string): string[] {
  return text.match(/\s*\S+/g) ?? []
}

export function installMockFetch(getOptions: () => MockOptions): () => void {
  const original = globalThis.fetch

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes(MOCK_URL)) return original(input, init)

    const { tokensPerSecond } = getOptions()
    const delay = 1000 / tokensPerSecond
    const tokens = tokenize(ANSWER)
    const encoder = new TextEncoder()
    const signal = init?.signal

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Real fetch errors the body when its signal aborts; a hand-built
        // stream has to do it explicitly or the reader hangs forever.
        let aborted = false
        const onAbort = () => {
          aborted = true
          try {
            controller.error(new DOMException('Aborted', 'AbortError'))
          } catch {
            /* already closed */
          }
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        try {
          for (const token of tokens) {
            if (aborted) return
            await new Promise((r) => setTimeout(r, delay))
            if (aborted) return
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(token)}\n\n`))
          }
          if (aborted) return
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        } finally {
          signal?.removeEventListener('abort', onAbort)
        }
      },
    })

    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  return () => {
    globalThis.fetch = original
  }
}

/** Matches the JSON-encoded tokens the mock emits. */
export function selectMockText(event: { data: string }): string | null | false {
  if (event.data === '[DONE]') return false
  try {
    return JSON.parse(event.data) as string
  } catch {
    return null
  }
}
