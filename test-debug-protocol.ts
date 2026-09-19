import { FakeHomeAssistant } from './test/fake-ha.ts'
import WebSocket from 'ws'

const fake = await FakeHomeAssistant.start({ token: 'test-token' })

fake.seed(
  [{ entityId: 'light.test', state: 'on', attributes: { brightness: 100 } }],
  []
)

const ws = new WebSocket(fake.baseUrl.replace('http://', 'ws://'))

ws.on('message', (data) => {
  console.log('Received:', data.toString())
})

await new Promise((resolve) => ws.once('open', resolve))

// Auth
ws.send(JSON.stringify({ type: 'auth', access_token: 'test-token' }))
await new Promise((resolve) => setTimeout(resolve, 100))

// Subscribe
ws.send(JSON.stringify({ type: 'subscribe_entities', id: 1 }))
await new Promise((resolve) => setTimeout(resolve, 100))

console.log('\n=== Changing state from on to off ===')
fake.setState('light.test', 'off', { brightness: 100 })
await new Promise((resolve) => setTimeout(resolve, 100))

console.log('\n=== Changing only attributes ===')
fake.setState('light.test', 'off', { brightness: 50 })
await new Promise((resolve) => setTimeout(resolve, 100))

ws.close()
await fake.stop()
