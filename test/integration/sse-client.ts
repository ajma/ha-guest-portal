import type { SseFrame } from '../../src/shared/api.ts'

/**
 * Opens an SSE stream against a running server and collects the frames it
 * delivers. `cookie` is null for connections that carry no session at all —
 * the ingress listener's Supervisor-authenticated admin streams.
 *
 * Shared by every integration test that needs to watch a live stream, so that
 * the direct port and the ingress port are exercised through the same client
 * rather than two subtly different ones.
 */
export async function openStream(baseUrl: string, cookie: string | null, search = '') {
  const ctrl = new AbortController()
  const res = await fetch(`${baseUrl}/api/stream${search}`, {
    headers: cookie === null ? {} : { Cookie: cookie },
    signal: ctrl.signal,
  })
  const reader = res.body?.getReader()
  if (!reader) throw new Error('no body')
  const dec = new TextDecoder()
  const frames: SseFrame[] = []
  const pump = (async () => {
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        for (;;) {
          const i = buf.indexOf('\n\n')
          if (i === -1) break
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const line = chunk.split('\n').find((l) => l.startsWith('data: '))
          if (line) frames.push(JSON.parse(line.slice(6)))
        }
      }
    } catch {
      // aborted
    }
  })()
  return { res, frames, abort: () => ctrl.abort(), pump }
}

export async function waitFor(predicate: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

export async function waitForFrame(frames: SseFrame[], type: string, ms = 5000): Promise<boolean> {
  return waitFor(() => frames.some((f) => f.type === type), ms)
}

export function framesOfType(frames: SseFrame[], type: string): SseFrame[] {
  return frames.filter((f) => f.type === type)
}

// Every entityId a connection has been told about, across every frame it
// received. Cross-portal assertions are about what a client could *see*, not
// about which frame carried it.
export function entityIdsSeen(frames: SseFrame[]): string[] {
  return frames.flatMap((f) => ('devices' in f ? f.devices.map((d) => d.entityId) : []))
}

// A thin wrapper around openStream that answers "has this connection been
// closed by the server?" both synchronously (isClosed) and awaitably
// (closed), for tests whose whole point is a stream being dropped out from
// under the client rather than any frame it carries.
export async function openSseConnection(baseUrl: string, cookie: string | null, search = '') {
  const stream = await openStream(baseUrl, cookie, search)
  let closed = false
  void stream.pump.then(() => {
    closed = true
  })
  return {
    ...stream,
    closed: (ms = 3000) =>
      Promise.race([
        stream.pump.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]),
    isClosed: () => closed,
  }
}
