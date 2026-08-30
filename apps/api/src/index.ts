import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()

app.get('/health', (c) => c.json({ status: 'ok' }))

const port = Number(process.env.API_PORT ?? 8787)
serve({ fetch: app.fetch, port })

export { app }
