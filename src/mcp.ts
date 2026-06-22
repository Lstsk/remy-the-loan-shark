import { serve } from '@hono/node-server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { toFetchResponse, toReqRes } from 'fetch-to-node'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  createPaymentRequests,
  expenseDraftSchema,
  getRemyState,
  runRemyAgent,
  understandExpenseMessage,
} from './tools.ts'
import { resolveContact, saveContact } from './db/repository.ts'

const saveContactBodySchema = z.object({
  displayName: z.string(),
  alias: z.string().optional(),
  phone: z.string().optional(),
  imessageHandle: z.string().optional(),
  preferredPayoutMethod: z.string().optional(),
  payoutHandle: z.string().optional(),
  source: z.string().optional(),
})

export function createRemyMcpServer(): McpServer {
  const server = new McpServer({
    name: 'remy',
    version: '0.1.0',
  })

  server.registerTool(
    'resolve_contact',
    {
      title: 'Resolve contact',
      description: 'Look up a saved Remy contact by alias/name.',
      inputSchema: {
        alias: z.string(),
      },
    },
    async ({ alias }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(resolveContact(alias), null, 2),
      }],
    }),
  )

  server.registerTool(
    'save_contact',
    {
      title: 'Save contact',
      description: 'Save a contact mapping from a shared contact card, phone number, or iMessage handle.',
      inputSchema: {
        displayName: z.string(),
        alias: z.string().optional(),
        phone: z.string().optional(),
        imessageHandle: z.string().optional(),
        preferredPayoutMethod: z.string().optional(),
        payoutHandle: z.string().optional(),
      },
    },
    async (input) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(saveContact({ ...input, source: 'mcp' }), null, 2),
      }],
    }),
  )

  server.registerTool(
    'run_remy_agent',
    {
      title: 'Run Remy agent',
      description: 'Let Remy decide naturally whether to chat, ask a follow-up, draft an expense, or create requests.',
      inputSchema: {
        text: z.string(),
        payerName: z.string().default('Carson'),
        baseUrl: z.string().url().optional(),
      },
    },
    async ({ text, payerName, baseUrl }) => ({
      content: [{
        type: 'text',
        text: await runRemyAgent({ text, payerName, baseUrl }),
      }],
    }),
  )

  server.registerTool(
    'understand_expense_message',
    {
      title: 'Understand expense message',
      description: 'Extract an expense draft from a casual iMessage like "paid $86 dinner with Alex Brian Sam".',
      inputSchema: {
        text: z.string(),
        payerName: z.string().default('Carson'),
      },
    },
    async ({ text, payerName }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(await understandExpenseMessage({ text, payerName }), null, 2),
      }],
    }),
  )

  server.registerTool(
    'create_payment_requests',
    {
      title: 'Create payment requests',
      description: 'Create shareable payment request messages from an expense draft.',
      inputSchema: {
        draft: expenseDraftSchema,
        baseUrl: z.string().url().optional(),
      },
    },
    async ({ draft, baseUrl }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(createPaymentRequests({ draft, baseUrl }), null, 2),
      }],
    }),
  )

  server.registerTool(
    'get_remy_state',
    {
      title: 'Get Remy state',
      description: 'Read the current in-memory Remy draft and payment requests.',
      inputSchema: {},
    },
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify(getRemyState(), null, 2),
      }],
    }),
  )

  return server
}

export function createMcpApp(): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true, service: 'remy-mcp' }))

  app.get('/contacts/resolve', (c) => {
    const alias = c.req.query('alias')
    if (!alias) return c.json({ error: 'alias is required' }, 400)

    return c.json({ result: resolveContact(alias) })
  })

  app.post('/contacts', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = saveContactBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Invalid contact payload', issues: parsed.error.issues }, 400)
    }

    const contact = saveContact({
      ...parsed.data,
      source: parsed.data.source ?? 'ios-extension',
    })
    return c.json({ contact })
  })

  app.get('/state', (c) => c.json(getRemyState()))

  app.post('/mcp', async (c) => {
    const server = createRemyMcpServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    try {
      await server.connect(transport)
      const body = await c.req.raw.clone().json().catch(() => undefined)
      const { req, res } = toReqRes(c.req.raw)

      res.on('close', () => {
        transport.close()
        server.close()
      })

      await transport.handleRequest(req, res, body)
      return toFetchResponse(res)
    } catch (error) {
      console.error(error)
      transport.close()
      server.close()
      return c.json({ error: 'MCP request failed' }, 500)
    }
  })

  return app
}

export function startMcpServer() {
  const port = Number(process.env.PORT ?? 8787)
  const app = createMcpApp()

  return serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port,
  }, () => {
    console.log(`Remy MCP server listening at http://127.0.0.1:${port}/mcp`)
  })
}

if (process.argv[1] === import.meta.filename) {
  startMcpServer()
}
