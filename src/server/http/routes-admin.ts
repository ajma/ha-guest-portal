import type { Hono } from 'hono'
import type { Env } from '../app.js'
import type { Deps } from './routes-guest.js'
import { CatalogResponse } from '../../shared/api.js'

export function mountAdminRoutes(app: Hono<Env>, deps: Deps): void {
  const { ha } = deps

  app.use('/api/admin/*', async (c, next) => {
    const session = c.var.session

    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    if (session.role !== 'admin') {
      return c.json({ error: 'Forbidden' }, 403)
    }

    await next()
  })

  app.get('/api/admin/entities', async (c) => {
    const catalog = await ha.getCatalog()
    return c.json(CatalogResponse.parse({ entities: catalog }))
  })
}
