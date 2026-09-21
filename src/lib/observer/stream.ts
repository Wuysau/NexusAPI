import { createReadStream } from 'node:fs'
/** Bounded streaming; only newline-terminated records advance the durable offset. */
export async function readJsonl(file: string, start: number, end: number, consume: (event: unknown) => Promise<void>) {
  let offset = start,
    bytesRead = 0,
    warnings = 0,
    size = 0,
    oversized = false
  let pieces: Buffer[] = []
  if (end <= start) return { offset, bytesRead, warnings }
  for await (const chunk of createReadStream(file, { start, end: end - 1, highWaterMark: 64 * 1024 })) {
    const data = chunk as Buffer
    bytesRead += data.length
    let from = 0
    while (from < data.length) {
      const newline = data.indexOf(10, from),
        stop = newline < 0 ? data.length : newline + 1
      const part = data.subarray(from, stop)
      size += part.length
      if (size > 8 * 1024 * 1024) {
        oversized = true
        pieces = []
      }
      if (!oversized) pieces.push(part)
      if (newline >= 0) {
        if (oversized) warnings++
        else {
          let event: unknown
          try {
            event = JSON.parse(Buffer.concat(pieces).toString('utf8'))
          } catch {
            warnings++
          }
          if (event !== undefined) await consume(event)
        }
        offset += size
        size = 0
        oversized = false
        pieces = []
      }
      from = stop
    }
  }
  if (size) warnings++ // defer incomplete tail; never persist its content
  return { offset, bytesRead, warnings }
}
