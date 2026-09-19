import { describe, expect, it } from 'vitest'
import {
  AuthRequired,
  AuthOk,
  AuthInvalid,
  ResultFrame,
  PongFrame,
  EventFrame,
  InboundFrame,
  RegistryEntity,
  RegistryDevice,
  RegistryArea,
  type CompressedState,
  type EntityEvent,
} from '../../src/server/ha/schemas.ts'

describe('Home Assistant frame schemas', () => {
  describe('Authentication frames', () => {
    it('should parse auth_required frame', () => {
      const frame = { type: 'auth_required', ha_version: '2024.9.0' }
      const result = AuthRequired.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBe('auth_required')
        expect(result.data.ha_version).toBe('2024.9.0')
      }
    })

    it('should reject auth_required frame missing ha_version', () => {
      const frame = { type: 'auth_required' }
      const result = AuthRequired.safeParse(frame)
      expect(result.success).toBe(false)
    })

    it('should parse auth_ok frame', () => {
      const frame = { type: 'auth_ok', ha_version: '2024.9.0' }
      const result = AuthOk.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBe('auth_ok')
        expect(result.data.ha_version).toBe('2024.9.0')
      }
    })

    it('should parse auth_invalid frame', () => {
      const frame = { type: 'auth_invalid', message: 'Invalid access token' }
      const result = AuthInvalid.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBe('auth_invalid')
        expect(result.data.message).toBe('Invalid access token')
      }
    })

    it('should reject auth_invalid frame missing message', () => {
      const frame = { type: 'auth_invalid' }
      const result = AuthInvalid.safeParse(frame)
      expect(result.success).toBe(false)
    })
  })

  describe('Command result frames', () => {
    it('should parse successful result frame', () => {
      const frame = {
        type: 'result',
        id: 1,
        success: true,
        result: { some: 'data' },
      }
      const result = ResultFrame.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBe('result')
        expect(result.data.id).toBe(1)
        expect(result.data.success).toBe(true)
        expect(result.data.result).toEqual({ some: 'data' })
      }
    })

    it('should parse successful result frame without result field', () => {
      const frame = {
        type: 'result',
        id: 2,
        success: true,
      }
      const result = ResultFrame.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.success).toBe(true)
        expect(result.data.result).toBeUndefined()
      }
    })

    it('should parse error result frame', () => {
      const frame = {
        type: 'result',
        id: 3,
        success: false,
        error: { code: 'invalid_format', message: 'Invalid command format' },
      }
      const result = ResultFrame.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.success).toBe(false)
        expect(result.data.error).toEqual({
          code: 'invalid_format',
          message: 'Invalid command format',
        })
      }
    })

    it('should reject result frame missing id', () => {
      const frame = { type: 'result', success: true }
      const result = ResultFrame.safeParse(frame)
      expect(result.success).toBe(false)
    })

    it('should parse pong frame', () => {
      const frame = { type: 'pong', id: 42 }
      const result = PongFrame.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBe('pong')
        expect(result.data.id).toBe(42)
      }
    })
  })

  describe('CompressedState type', () => {
    it('should have all optional fields', () => {
      // Type-level test - this should compile
      const minimal: CompressedState = {}
      const full: CompressedState = {
        s: 'on',
        a: { brightness: 255 },
        c: '01H',
        lc: 1726675200.0,
        lu: 1726675200.0,
      }
      expect(minimal).toBeDefined()
      expect(full).toBeDefined()
    })

    it('should allow context as string or object', () => {
      // Type-level test
      const contextString: CompressedState = { c: '01H' }
      const contextObject: CompressedState = {
        c: { id: '01H', parent_id: '02H', user_id: 'user123' },
      }
      expect(contextString).toBeDefined()
      expect(contextObject).toBeDefined()
    })
  })

  describe('EntityEvent type', () => {
    it('should have all optional fields', () => {
      // Type-level test
      const empty: EntityEvent = {}
      const onlyAdded: EntityEvent = {
        a: { 'light.porch': { s: 'on', a: { brightness: 255 } } },
      }
      const onlyChanged: EntityEvent = {
        c: {
          'light.porch': {
            '+': { s: 'off' },
            '-': { a: ['brightness'] },
          },
        },
      }
      const onlyRemoved: EntityEvent = { r: ['light.removed'] }
      expect(empty).toBeDefined()
      expect(onlyAdded).toBeDefined()
      expect(onlyChanged).toBeDefined()
      expect(onlyRemoved).toBeDefined()
    })
  })

  describe('Event frames', () => {
    it('should parse event frame with added entities (snapshot)', () => {
      const frame = {
        type: 'event',
        id: 5,
        event: {
          a: {
            'light.porch': {
              s: 'on',
              a: { brightness: 255, color_temp: 370 },
              c: '01H',
              lc: 1726675200.0,
              lu: 1726675200.0,
            },
            'switch.outlet': {
              s: 'off',
              a: {},
              c: { id: '02H', user_id: 'user123' },
              lc: 1726675100.0,
              lu: 1726675100.0,
            },
          },
        },
      }
      const result = EventFrame.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.type).toBe('event')
        expect(result.data.id).toBe(5)
        expect(result.data.event.a).toBeDefined()
        expect(result.data.event.a?.['light.porch']?.s).toBe('on')
        expect(result.data.event.a?.['switch.outlet']?.c).toEqual({
          id: '02H',
          user_id: 'user123',
        })
      }
    })

    it('should parse event frame with changed entities', () => {
      const frame = {
        type: 'event',
        id: 6,
        event: {
          c: {
            'light.porch': {
              '+': { s: 'off' },
              '-': { a: ['brightness', 'color_temp'] },
            },
          },
        },
      }
      const result = EventFrame.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.event.c).toBeDefined()
        expect(result.data.event.c?.['light.porch']?.['+']?.s).toBe('off')
        expect(result.data.event.c?.['light.porch']?.['-']?.a).toEqual(['brightness', 'color_temp'])
      }
    })

    it('should parse event frame with removed entities', () => {
      const frame = {
        type: 'event',
        id: 7,
        event: {
          r: ['light.removed', 'switch.unplugged'],
        },
      }
      const result = EventFrame.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.event.r).toEqual(['light.removed', 'switch.unplugged'])
      }
    })

    it('should parse event frame with all three sections', () => {
      const frame = {
        type: 'event',
        id: 8,
        event: {
          a: { 'light.new': { s: 'on' } },
          c: { 'light.existing': { '+': { s: 'off' } } },
          r: ['light.old'],
        },
      }
      const result = EventFrame.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.event.a).toBeDefined()
        expect(result.data.event.c).toBeDefined()
        expect(result.data.event.r).toBeDefined()
      }
    })

    it('should parse event frame with minimal compressed state (only lu)', () => {
      const frame = {
        type: 'event',
        id: 9,
        event: {
          c: {
            'sensor.temp': {
              '+': { lu: 1726675300.0 },
            },
          },
        },
      }
      const result = EventFrame.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.event.c?.['sensor.temp']?.['+']?.lu).toBe(1726675300.0)
        expect(result.data.event.c?.['sensor.temp']?.['+']?.lc).toBeUndefined()
      }
    })

    it('should parse context as string', () => {
      const frame = {
        type: 'event',
        id: 10,
        event: {
          a: {
            'light.test': { s: 'on', c: '01H' },
          },
        },
      }
      const result = EventFrame.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.event.a?.['light.test']?.c).toBe('01H')
      }
    })

    it('should parse context as object', () => {
      const frame = {
        type: 'event',
        id: 11,
        event: {
          a: {
            'light.test': {
              s: 'on',
              c: { id: '01H', parent_id: '02H', user_id: 'user123' },
            },
          },
        },
      }
      const result = EventFrame.safeParse(frame)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.event.a?.['light.test']?.c).toEqual({
          id: '01H',
          parent_id: '02H',
          user_id: 'user123',
        })
      }
    })
  })

  describe('InboundFrame discriminated union', () => {
    it('should parse auth_required as InboundFrame', () => {
      const frame = { type: 'auth_required', ha_version: '2024.9.0' }
      const result = InboundFrame.safeParse(frame)
      expect(result.success).toBe(true)
    })

    it('should parse auth_ok as InboundFrame', () => {
      const frame = { type: 'auth_ok', ha_version: '2024.9.0' }
      const result = InboundFrame.safeParse(frame)
      expect(result.success).toBe(true)
    })

    it('should parse auth_invalid as InboundFrame', () => {
      const frame = { type: 'auth_invalid', message: 'Invalid token' }
      const result = InboundFrame.safeParse(frame)
      expect(result.success).toBe(true)
    })

    it('should parse result as InboundFrame', () => {
      const frame = { type: 'result', id: 1, success: true }
      const result = InboundFrame.safeParse(frame)
      expect(result.success).toBe(true)
    })

    it('should parse pong as InboundFrame', () => {
      const frame = { type: 'pong', id: 1 }
      const result = InboundFrame.safeParse(frame)
      expect(result.success).toBe(true)
    })

    it('should parse event as InboundFrame', () => {
      const frame = { type: 'event', id: 1, event: { a: {} } }
      const result = InboundFrame.safeParse(frame)
      expect(result.success).toBe(true)
    })

    it('should reject unknown frame type', () => {
      const frame = { type: 'unknown', data: 'test' }
      const result = InboundFrame.safeParse(frame)
      expect(result.success).toBe(false)
    })
  })

  describe('Registry schemas', () => {
    describe('RegistryEntity', () => {
      it('should parse entity with all required fields', () => {
        const entity = {
          entity_id: 'light.living_room',
          name: 'Living Room Light',
          original_name: 'Philips Hue Light',
          area_id: 'living_room',
          device_id: 'device123',
          disabled_by: null,
          hidden_by: null,
          entity_category: null,
        }
        const result = RegistryEntity.safeParse(entity)
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data.entity_id).toBe('light.living_room')
          expect(result.data.name).toBe('Living Room Light')
          expect(result.data.area_id).toBe('living_room')
        }
      })

      it('should parse entity with null values', () => {
        const entity = {
          entity_id: 'sensor.temp',
          name: null,
          original_name: null,
          area_id: null,
          device_id: null,
          disabled_by: null,
          hidden_by: null,
          entity_category: null,
        }
        const result = RegistryEntity.safeParse(entity)
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data.name).toBe(null)
          expect(result.data.area_id).toBe(null)
        }
      })

      it('should parse entity with non-null disabled_by and hidden_by', () => {
        const entity = {
          entity_id: 'light.disabled',
          name: 'Disabled Light',
          original_name: 'Original Name',
          area_id: 'garage',
          device_id: 'dev456',
          disabled_by: 'user',
          hidden_by: 'integration',
          entity_category: 'diagnostic',
        }
        const result = RegistryEntity.safeParse(entity)
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data.disabled_by).toBe('user')
          expect(result.data.hidden_by).toBe('integration')
          expect(result.data.entity_category).toBe('diagnostic')
        }
      })

      it('should PASS when entity has unknown extra fields (loose schema)', () => {
        const entity = {
          entity_id: 'light.test',
          name: 'Test Light',
          original_name: 'Original',
          area_id: 'test_area',
          device_id: 'test_device',
          disabled_by: null,
          hidden_by: null,
          entity_category: null,
          unknown_future_field: 'some value',
          another_unknown: { nested: 'object' },
        }
        const result = RegistryEntity.safeParse(entity)
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data).toHaveProperty('unknown_future_field', 'some value')
          expect(result.data).toHaveProperty('another_unknown')
          expect(result.data.another_unknown).toEqual({ nested: 'object' })
        }
      })

      it('should FAIL when entity missing area_id entirely', () => {
        const entity = {
          entity_id: 'light.test',
          name: 'Test Light',
          original_name: 'Original',
          device_id: 'test_device',
          disabled_by: null,
          hidden_by: null,
          entity_category: null,
        }
        const result = RegistryEntity.safeParse(entity)
        expect(result.success).toBe(false)
      })

      it('should FAIL when entity missing name entirely', () => {
        const entity = {
          entity_id: 'light.test',
          original_name: 'Original',
          area_id: null,
          device_id: 'test_device',
          disabled_by: null,
          hidden_by: null,
          entity_category: null,
        }
        const result = RegistryEntity.safeParse(entity)
        expect(result.success).toBe(false)
      })
    })

    describe('RegistryDevice', () => {
      it('should parse device with all fields', () => {
        const device = {
          id: 'device123',
          name: 'Philips Hue Bridge',
          name_by_user: 'My Hue Bridge',
          area_id: 'living_room',
        }
        const result = RegistryDevice.safeParse(device)
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data.id).toBe('device123')
          expect(result.data.name).toBe('Philips Hue Bridge')
          expect(result.data.name_by_user).toBe('My Hue Bridge')
          expect(result.data.area_id).toBe('living_room')
        }
      })

      it('should parse device with null values', () => {
        const device = {
          id: 'device456',
          name: null,
          name_by_user: null,
          area_id: null,
        }
        const result = RegistryDevice.safeParse(device)
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data.name).toBe(null)
          expect(result.data.area_id).toBe(null)
        }
      })

      it('should PASS when device has unknown extra fields (loose schema)', () => {
        const device = {
          id: 'device789',
          name: 'Test Device',
          name_by_user: null,
          area_id: null,
          unknown_field: 'value',
          manufacturer: 'Acme Corp',
        }
        const result = RegistryDevice.safeParse(device)
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data).toHaveProperty('unknown_field', 'value')
          expect(result.data).toHaveProperty('manufacturer', 'Acme Corp')
        }
      })

      it('should FAIL when device missing id', () => {
        const device = {
          name: 'Test Device',
          name_by_user: null,
          area_id: null,
        }
        const result = RegistryDevice.safeParse(device)
        expect(result.success).toBe(false)
      })
    })

    describe('RegistryArea', () => {
      it('should parse area with all fields', () => {
        const area = {
          area_id: 'living_room',
          name: 'Living Room',
        }
        const result = RegistryArea.safeParse(area)
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data.area_id).toBe('living_room')
          expect(result.data.name).toBe('Living Room')
        }
      })

      it('should PASS when area has unknown extra fields (loose schema)', () => {
        const area = {
          area_id: 'kitchen',
          name: 'Kitchen',
          icon: 'mdi:silverware-fork-knife',
          floor_id: 'ground_floor',
        }
        const result = RegistryArea.safeParse(area)
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data).toHaveProperty('icon', 'mdi:silverware-fork-knife')
          expect(result.data).toHaveProperty('floor_id', 'ground_floor')
        }
      })

      it('should FAIL when area missing name', () => {
        const area = {
          area_id: 'bedroom',
        }
        const result = RegistryArea.safeParse(area)
        expect(result.success).toBe(false)
      })
    })
  })
})
