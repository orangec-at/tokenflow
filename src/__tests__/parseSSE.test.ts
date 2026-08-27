import { describe, expect, it } from 'vitest'
import { SSEParser } from '../parseSSE'

describe('SSEParser', () => {
  it('parses a single well-formed event', () => {
    const p = new SSEParser()
    expect(p.push('data: hello\n\n')).toEqual([
      { event: 'message', data: 'hello', id: undefined, retry: undefined },
    ])
  })

  it('reassembles an event split across chunk boundaries', () => {
    const p = new SSEParser()
    // The network can cut anywhere — including mid-field-name.
    expect(p.push('da')).toEqual([])
    expect(p.push('ta: hel')).toEqual([])
    expect(p.push('lo\n')).toEqual([])
    expect(p.push('\n')).toEqual([{ event: 'message', data: 'hello', id: undefined, retry: undefined }])
  })

  it('returns several events completed by one chunk', () => {
    const p = new SSEParser()
    const events = p.push('data: a\n\ndata: b\n\ndata: c\n\n')
    expect(events.map((e) => e.data)).toEqual(['a', 'b', 'c'])
  })

  it('joins multiple data lines with a newline, per spec', () => {
    const p = new SSEParser()
    expect(p.push('data: line one\ndata: line two\n\n')[0]!.data).toBe('line one\nline two')
  })

  it('reads event, id and retry fields', () => {
    const p = new SSEParser()
    const [e] = p.push('event: token\nid: 42\nretry: 3000\ndata: hi\n\n')
    expect(e).toEqual({ event: 'token', data: 'hi', id: '42', retry: 3000 })
  })

  it('keeps an id that contains spaces', () => {
    // Regression: the NUL check was written as a space check, so any id with a
    // space in it was silently dropped. Found by reading eventsource-parser.
    const p = new SSEParser()
    expect(p.push('id: 42 abc\ndata: x\n\n')[0]!.id).toBe('42 abc')
  })

  it('ignores an id containing U+0000, per spec', () => {
    const p = new SSEParser()
    expect(p.push('id: 4\u00002\ndata: x\n\n')[0]!.id).toBeUndefined()
  })

  it('ignores comment lines', () => {
    const p = new SSEParser()
    // Heartbeat comments keep proxies from closing an idle connection.
    expect(p.push(': keep-alive\n\ndata: real\n\n').map((e) => e.data)).toEqual(['real'])
  })

  it('handles CRLF line endings', () => {
    const p = new SSEParser()
    expect(p.push('event: token\r\ndata: windows\r\n\r\n')[0]).toMatchObject({
      event: 'token',
      data: 'windows',
    })
  })

  it('strips exactly one leading space after the colon', () => {
    const p = new SSEParser()
    // 'data:  x' means the value is ' x' — the first space is framing.
    expect(p.push('data:  x\n\n')[0]!.data).toBe(' x')
    expect(p.push('data:y\n\n')[0]!.data).toBe('y')
  })

  it('preserves empty data lines rather than dropping them', () => {
    const p = new SSEParser()
    // A blank data line is a real newline in the payload, not noise.
    expect(p.push('data: a\ndata:\ndata: b\n\n')[0]!.data).toBe('a\n\nb')
  })

  it('ignores unknown fields', () => {
    const p = new SSEParser()
    expect(p.push('nonsense: 1\ndata: kept\n\n')[0]!.data).toBe('kept')
  })

  it('flushes a trailing event that was never terminated', () => {
    const p = new SSEParser()
    // Server closed the socket right after the last event, no blank line.
    expect(p.push('data: last')).toEqual([])
    expect(p.flush().map((e) => e.data)).toEqual(['last'])
  })

  it('flushes nothing when only whitespace is buffered', () => {
    const p = new SSEParser()
    p.push('\n')
    expect(p.flush()).toEqual([])
  })

  it('drops buffered state on reset', () => {
    const p = new SSEParser()
    p.push('data: partial')
    p.reset()
    expect(p.flush()).toEqual([])
  })
})
