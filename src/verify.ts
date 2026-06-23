import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpApp } from './mcp.ts'
import { createPaymentRequests, expenseDraftSchema, formatDraft } from './tools.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const draft = expenseDraftSchema.parse({
  title: 'Dinner',
  payerName: 'Carson',
  total: 86,
  people: ['Alex', 'Brian', 'Sam'],
  splitMode: 'equal',
  confidence: 0.9,
})

const requests = createPaymentRequests({ draft, baseUrl: 'https://remy.test' })
assert(requests.length === 3, 'expected three payment requests')
assert(formatDraft(draft).includes('Reply yes'), 'draft reply should ask for confirmation')

const listener = localServe(createMcpApp().fetch)
try {
  const client = new Client({ name: 'remy-verify', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${listener.url}/mcp`))
  await client.connect(transport)

  const tools = await client.listTools()
  const toolNames = tools.tools.map((tool) => tool.name)
  assert(toolNames.includes('run_remy_agent'), 'missing run_remy_agent')
  assert(toolNames.includes('understand_expense_message'), 'missing understand_expense_message')
  assert(toolNames.includes('create_payment_requests'), 'missing create_payment_requests')
  assert(toolNames.includes('get_remy_state'), 'missing get_remy_state')

  await client.close()
  console.log('PASS clean Remy Spectrum/MCP setup verified.')
} finally {
  await listener.close()
}

function localServe(fetch: (request: Request) => Response | Promise<Response>) {
  const port = 50000 + Math.floor(Math.random() * 10000)
  const server = serve({ fetch, hostname: '127.0.0.1', port })
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
