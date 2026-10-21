/**
 * A minimal Server-Sent Events reader for the agent stream: named events with
 * `event:`, `id:` and `data:` lines, a blank line ending each event. Comments
 * (`:`-lines) and unknown fields are skipped, as the SSE spec says.
 */

export interface SseEvent {
  event: string
  id?: string
  data: string
}

export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let event = 'message'
  let id: string | undefined
  let data: string[] = []

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1))
        if (line === '') {
          if (data.length > 0) yield { event, ...(id !== undefined ? { id } : {}), data: data.join('\n') }
          event = 'message'
          id = undefined
          data = []
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'id') id = value
        else if (field === 'data') data.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }
}
