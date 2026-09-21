import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { SseHub } from '../../src/server/http/sse.js'
import type { SseFrame } from '../../src/shared/api.js'

describe('SseHub', () => {
  let server: Server
  let hub: SseHub
  let port: number

  beforeEach(async () => {
    hub = new SseHub()
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/events') {
        hub.add(res, 'guest', 'portal-1')
      }
    })

    // Find an available port
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          port = addr.port
        }
        resolve()
      })
    })
  })

  afterEach(async () => {
    hub.close()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  })

  it('sends correct SSE headers', async () => {
    const response = await fetch(`http://localhost:${port}/events`)

    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(response.headers.get('connection')).toBe('keep-alive')
    expect(response.headers.get('x-accel-buffering')).toBe('no')

    const reader = response.body?.getReader()
    if (reader) {
      await reader.cancel()
    }
  })

  it('broadcasts to multiple clients simultaneously', async () => {
    const client1 = await fetch(`http://localhost:${port}/events`)
    const client2 = await fetch(`http://localhost:${port}/events`)

    expect(hub.clientCount).toBe(2)

    const frame: SseFrame = {
      type: 'snapshot',
      devices: [],
      stale: false,
    }

    // Read first chunk from both clients
    const reader1 = client1.body?.getReader()
    const reader2 = client2.body?.getReader()

    expect(reader1).toBeDefined()
    expect(reader2).toBeDefined()

    if (!reader1 || !reader2) throw new Error('No readers')

    hub.broadcast(frame)

    const result1 = await reader1.read()
    const result2 = await reader2.read()

    const text1 = new TextDecoder().decode(result1.value)
    const text2 = new TextDecoder().decode(result2.value)

    expect(text1).toContain('data: ')
    expect(text2).toContain('data: ')

    await reader1.cancel()
    await reader2.cancel()
  })

  it('formats frames with correct wire format', async () => {
    const client = await fetch(`http://localhost:${port}/events`)
    const reader = client.body?.getReader()

    if (!reader) throw new Error('No reader')

    const frame: SseFrame = {
      type: 'patch',
      devices: [
        {
          entityId: 'light.kitchen',
          label: 'Kitchen Light',
          domain: 'light',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 1,
          state: {
            state: 'on',
            attributes: { brightness: 255 },
            stale: false,
          },
        },
      ],
    }

    hub.broadcast(frame)

    const result = await reader.read()
    const text = new TextDecoder().decode(result.value)

    // Check wire format: data: {json}\n\n
    expect(text).toMatch(/^data: .+\n\n$/)

    // Extract JSON and parse it
    const jsonMatch = text.match(/^data: (.+)\n\n$/)
    expect(jsonMatch).toBeTruthy()

    if (jsonMatch?.[1]) {
      const parsed = JSON.parse(jsonMatch[1])
      expect(parsed).toEqual(frame)
    }

    await reader.cancel()
  })

  it('round-trips snapshot frame', async () => {
    const client = await fetch(`http://localhost:${port}/events`)
    const reader = client.body?.getReader()

    if (!reader) throw new Error('No reader')

    const frame: SseFrame = {
      type: 'snapshot',
      devices: [
        {
          entityId: 'switch.outlet',
          label: 'Outlet',
          domain: 'switch',
          allowedActions: ['turn_on'],
          sortOrder: 0,
          state: { state: 'off', attributes: {}, stale: false },
        },
      ],
      stale: true,
    }

    hub.broadcast(frame)

    const result = await reader.read()
    const text = new TextDecoder().decode(result.value)
    const jsonMatch = text.match(/^data: (.+)\n\n$/)

    expect(jsonMatch).toBeTruthy()
    if (jsonMatch?.[1]) {
      expect(JSON.parse(jsonMatch[1])).toEqual(frame)
    }

    await reader.cancel()
  })

  it('round-trips patch frame', async () => {
    const client = await fetch(`http://localhost:${port}/events`)
    const reader = client.body?.getReader()

    if (!reader) throw new Error('No reader')

    const frame: SseFrame = {
      type: 'patch',
      devices: [],
    }

    hub.broadcast(frame)

    const result = await reader.read()
    const text = new TextDecoder().decode(result.value)
    const jsonMatch = text.match(/^data: (.+)\n\n$/)

    expect(jsonMatch).toBeTruthy()
    if (jsonMatch?.[1]) {
      expect(JSON.parse(jsonMatch[1])).toEqual(frame)
    }

    await reader.cancel()
  })

  it('round-trips degraded frame', async () => {
    const client = await fetch(`http://localhost:${port}/events`)
    const reader = client.body?.getReader()

    if (!reader) throw new Error('No reader')

    const frame: SseFrame = {
      type: 'degraded',
      stale: true,
    }

    hub.broadcast(frame)

    const result = await reader.read()
    const text = new TextDecoder().decode(result.value)
    const jsonMatch = text.match(/^data: (.+)\n\n$/)

    expect(jsonMatch).toBeTruthy()
    if (jsonMatch?.[1]) {
      expect(JSON.parse(jsonMatch[1])).toEqual(frame)
    }

    await reader.cancel()
  })

  it('removes disconnected client and decrements count', async () => {
    const client1 = await fetch(`http://localhost:${port}/events`)
    const client2 = await fetch(`http://localhost:${port}/events`)

    expect(hub.clientCount).toBe(2)

    const reader1 = client1.body?.getReader()
    const reader2 = client2.body?.getReader()

    if (!reader1 || !reader2) throw new Error('No readers')

    // Close one client
    await reader1.cancel()

    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(hub.clientCount).toBe(1)

    await reader2.cancel()
  })

  it('does not throw when broadcasting after client destroys socket', async () => {
    const client1 = await fetch(`http://localhost:${port}/events`)
    const client2 = await fetch(`http://localhost:${port}/events`)

    expect(hub.clientCount).toBe(2)

    const reader1 = client1.body?.getReader()
    const reader2 = client2.body?.getReader()

    if (!reader1 || !reader2) throw new Error('No readers')

    // Destroy first client's connection
    await reader1.cancel()

    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Broadcasting should not throw
    const frame: SseFrame = { type: 'degraded', stale: false }
    expect(() => hub.broadcast(frame)).not.toThrow()

    // Second client should still receive it
    const result = await reader2.read()
    const text = new TextDecoder().decode(result.value)
    expect(text).toContain('data: ')

    await reader2.cancel()
  })

  it('allows calling remover twice safely', async () => {
    const removerPromise = new Promise<() => void>((resolve) => {
      const customServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.url === '/events') {
          const remover = hub.add(res, 'guest', 'portal-1')
          resolve(remover)
        }
      })

      customServer.listen(0, async () => {
        const addr = customServer.address()
        if (addr && typeof addr === 'object') {
          const port = addr.port
          await fetch(`http://localhost:${port}/events`)
        }
      })
    })

    const remover = await removerPromise

    expect(hub.clientCount).toBe(1)

    remover()
    expect(hub.clientCount).toBe(0)

    // Call again - should not throw
    expect(() => remover()).not.toThrow()
    expect(hub.clientCount).toBe(0)
  })

  it('emits heartbeat comment on configured interval', async () => {
    const shortHub = new SseHub({ heartbeatMs: 100 })
    const customServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/events') {
        shortHub.add(res, 'guest', 'portal-1')
      }
    })

    const customPort = await new Promise<number>((resolve) => {
      customServer.listen(0, () => {
        const addr = customServer.address()
        if (addr && typeof addr === 'object') {
          resolve(addr.port)
        }
      })
    })

    const client = await fetch(`http://localhost:${customPort}/events`)
    const reader = client.body?.getReader()

    if (!reader) throw new Error('No reader')

    // Wait for heartbeat
    await new Promise((resolve) => setTimeout(resolve, 150))

    const result = await reader.read()
    const text = new TextDecoder().decode(result.value)

    // Should contain heartbeat comment
    expect(text).toContain(': ping\n\n')

    await reader.cancel()
    shortHub.close()

    await new Promise<void>((resolve, reject) => {
      customServer.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  })

  it('closes all responses and resets count', async () => {
    const client1 = await fetch(`http://localhost:${port}/events`)
    const client2 = await fetch(`http://localhost:${port}/events`)

    const reader1 = client1.body?.getReader()
    const reader2 = client2.body?.getReader()

    if (!reader1 || !reader2) throw new Error('No readers')

    expect(hub.clientCount).toBe(2)

    hub.close()

    expect(hub.clientCount).toBe(0)

    // Reading should eventually return done
    await new Promise((resolve) => setTimeout(resolve, 50))

    const result1 = await reader1.read()
    const result2 = await reader2.read()

    expect(result1.done || result2.done).toBe(true)
  })

  it('has no open handles after close', async () => {
    const shortHub = new SseHub({ heartbeatMs: 100 })
    const customServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/events') {
        shortHub.add(res, 'guest', 'portal-1')
      }
    })

    const customPort = await new Promise<number>((resolve) => {
      customServer.listen(0, () => {
        const addr = customServer.address()
        if (addr && typeof addr === 'object') {
          resolve(addr.port)
        }
      })
    })

    const client = await fetch(`http://localhost:${customPort}/events`)
    const reader = client.body?.getReader()

    if (!reader) throw new Error('No reader')

    expect(shortHub.clientCount).toBe(1)

    // Close hub - this should clear heartbeat timer
    shortHub.close()

    await reader.cancel()

    await new Promise<void>((resolve, reject) => {
      customServer.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // If heartbeat timer wasn't cleared, Vitest will hang
    // The test passing means no handles are keeping the process alive
  })

  it('evicts client when buffered data exceeds cap', async () => {
    // Use a small cap to make the test fast
    const cappedHub = new SseHub({ maxBufferBytes: 1024 })
    const customServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/events') {
        cappedHub.add(res, 'guest', 'portal-1')
      }
    })

    const customPort = await new Promise<number>((resolve) => {
      customServer.listen(0, () => {
        const addr = customServer.address()
        if (addr && typeof addr === 'object') {
          resolve(addr.port)
        }
      })
    })

    // Create a raw socket that never reads
    const net = await import('node:net')
    const socket = net.connect(customPort, 'localhost')

    // Send HTTP request but never read the response
    await new Promise<void>((resolve) => {
      socket.write('GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n', () => {
        resolve()
      })
    })

    // Wait for connection to establish
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(cappedHub.clientCount).toBe(1)

    // Broadcast enough to exceed the cap
    const largeFrame: SseFrame = {
      type: 'snapshot',
      devices: Array.from({ length: 50 }, (_, i) => ({
        entityId: `light.${i}`,
        label: `Light ${i}`,
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: i,
        state: {
          state: 'on',
          attributes: { brightness: 255, color: { r: 255, g: 128, b: 64 } },
          stale: false,
        },
      })),
      stale: false,
    }

    // Broadcast repeatedly to fill the buffer
    for (let i = 0; i < 20; i++) {
      cappedHub.broadcast(largeFrame)
    }

    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Client should be evicted
    expect(cappedHub.clientCount).toBe(0)

    socket.destroy()
    cappedHub.close()

    await new Promise<void>((resolve, reject) => {
      customServer.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  })

  it('does not evict healthy client with single large frame', async () => {
    const client = await fetch(`http://localhost:${port}/events`)
    const reader = client.body?.getReader()

    if (!reader) throw new Error('No reader')

    expect(hub.clientCount).toBe(1)

    // Create a frame larger than 16KB (the default high-water mark)
    const largeFrame: SseFrame = {
      type: 'snapshot',
      devices: Array.from({ length: 200 }, (_, i) => ({
        entityId: `light.room_${i}`,
        label: `Light in Room ${i}`,
        domain: 'light',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: i,
        state: {
          state: 'on',
          attributes: {
            brightness: 255,
            color_temp: 400,
            rgb_color: [255, 200, 100],
            supported_features: 63,
          },
          stale: false,
        },
      })),
      stale: false,
    }

    hub.broadcast(largeFrame)

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Client should NOT be evicted
    expect(hub.clientCount).toBe(1)

    // Should still receive the frame
    const result = await reader.read()
    expect(result.done).toBe(false)

    await reader.cancel()
  })

  it('does not throw when broadcasting unserialisable frame', async () => {
    const client = await fetch(`http://localhost:${port}/events`)
    const reader = client.body?.getReader()

    if (!reader) throw new Error('No reader')

    expect(hub.clientCount).toBe(1)

    // Create a frame with a circular reference
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular

    const badFrame = {
      type: 'snapshot',
      devices: [],
      stale: false,
      circular,
    } as unknown as SseFrame

    // Should not throw
    expect(() => hub.broadcast(badFrame)).not.toThrow()

    // Good frame should still work
    const goodFrame: SseFrame = {
      type: 'degraded',
      stale: true,
    }

    hub.broadcast(goodFrame)

    const result = await reader.read()
    const text = new TextDecoder().decode(result.value)
    expect(text).toContain('data: ')

    await reader.cancel()
  })

  it('detaches response listeners when remover is called', async () => {
    const removerPromise = new Promise<() => void>((resolve) => {
      const customServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.url === '/events') {
          const remover = hub.add(res, 'guest', 'portal-1')
          resolve(remover)
        }
      })

      customServer.listen(0, async () => {
        const addr = customServer.address()
        if (addr && typeof addr === 'object') {
          const port = addr.port
          await fetch(`http://localhost:${port}/events`)
        }
      })
    })

    const remover = await removerPromise

    expect(hub.clientCount).toBe(1)

    // Call remover
    remover()

    expect(hub.clientCount).toBe(0)
  })

  describe('broadcastToPortal', () => {
    let portalServer: Server
    let portalPort: number

    beforeEach(async () => {
      // Create a server that binds each connection to a portal from the query string
      portalServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', `http://localhost`)
        const role = url.searchParams.get('role')
        const portalId = url.searchParams.get('portal')
        if (url.pathname === '/events' && (role === 'guest' || role === 'admin')) {
          hub.add(res, role as 'guest' | 'admin', portalId)
        }
      })

      portalPort = await new Promise<number>((resolve) => {
        portalServer.listen(0, () => {
          const addr = portalServer.address()
          if (addr && typeof addr === 'object') {
            resolve(addr.port)
          }
        })
      })
    })

    afterEach(async () => {
      await new Promise<void>((resolve, reject) => {
        portalServer.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    })

    it('routes a patch only to connections bound to the affected portal', async () => {
      const clientA = await fetch(`http://localhost:${portalPort}/events?role=guest&portal=portal-a`)
      const clientB = await fetch(`http://localhost:${portalPort}/events?role=guest&portal=portal-b`)

      const readerA = clientA.body?.getReader()
      const readerB = clientB.body?.getReader()

      if (!readerA || !readerB) throw new Error('No readers')

      const frame: SseFrame = { type: 'patch', devices: [] }
      hub.broadcastToPortal('portal-a', frame)

      const resultA = await readerA.read()
      const textA = new TextDecoder().decode(resultA.value)
      expect(textA).toContain('"type":"patch"')

      // portal-b's connection must not receive portal-a's frame
      const outcome = await Promise.race([
        readerB.read().then(() => 'received' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ])
      expect(outcome).toBe('timeout')

      await readerA.cancel()
      await readerB.cancel()
    })
  })

  describe('closePortalGuests', () => {
    let roleServer: Server
    let rolePort: number

    beforeEach(async () => {
      // Create a server that binds each connection to a role and portal from the query string
      roleServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', `http://localhost`)
        const role = url.searchParams.get('role')
        const portalId = url.searchParams.get('portal')
        if (url.pathname === '/events' && (role === 'guest' || role === 'admin')) {
          hub.add(res, role as 'guest' | 'admin', portalId)
        }
      })

      rolePort = await new Promise<number>((resolve) => {
        roleServer.listen(0, () => {
          const addr = roleServer.address()
          if (addr && typeof addr === 'object') {
            resolve(addr.port)
          }
        })
      })
    })

    afterEach(async () => {
      await new Promise<void>((resolve, reject) => {
        roleServer.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    })

    it("ends only that portal's guest connections", async () => {
      const guestAClient = await fetch(`http://localhost:${rolePort}/events?role=guest&portal=portal-a`)
      const guestBClient = await fetch(`http://localhost:${rolePort}/events?role=guest&portal=portal-b`)
      const adminAClient = await fetch(`http://localhost:${rolePort}/events?role=admin&portal=portal-a`)

      const guestAReader = guestAClient.body?.getReader()
      const guestBReader = guestBClient.body?.getReader()
      const adminAReader = adminAClient.body?.getReader()

      if (!guestAReader || !guestBReader || !adminAReader) throw new Error('No readers')

      expect(hub.clientCount).toBe(3)

      hub.closePortalGuests('portal-a')

      expect(hub.clientCount).toBe(2)

      // portal-a's guest stream should end
      const guestAResult = await guestAReader.read()
      expect(guestAResult.done).toBe(true)

      // portal-b's guest and portal-a's admin should still be open
      const frame: SseFrame = { type: 'portal', enabled: false }
      hub.broadcast(frame)

      const guestBResult = await guestBReader.read()
      expect(new TextDecoder().decode(guestBResult.value)).toContain('"type":"portal"')

      const adminAResult = await adminAReader.read()
      expect(new TextDecoder().decode(adminAResult.value)).toContain('"type":"portal"')

      await guestBReader.cancel()
      await adminAReader.cancel()
    })

    it('is a no-op when no guest is bound to that portal', async () => {
      const adminClient = await fetch(`http://localhost:${rolePort}/events?role=admin&portal=portal-a`)
      const adminReader = adminClient.body?.getReader()

      if (!adminReader) throw new Error('No reader')

      expect(hub.clientCount).toBe(1)

      expect(() => hub.closePortalGuests('portal-a')).not.toThrow()
      expect(hub.clientCount).toBe(1)

      await adminReader.cancel()
    })
  })
})
