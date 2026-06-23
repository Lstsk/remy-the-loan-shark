import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpApp } from './mcp.ts'
import { createPaymentRequests, expenseDraftSchema, formatDraft, formatTestRequests, isLocalTestSend } from './tools.ts'

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
assert(isLocalTestSend('test send it here'), 'test send phrase should enable local test mode')
assert(formatTestRequests(requests).includes('Test cards ready'), 'test requests should say test cards are ready')
assert(formatTestRequests(requests).includes('https://remy.test/pay'), 'test requests should include pay links')

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

  const payResponse = await fetch(`${listener.url}/pay?friend=alex&amount=28.67&title=Dinner`)
  assert(payResponse.ok, 'pay sheet should render')
  const payHtml = await payResponse.text()
  assert(payHtml.includes('Remy payment request'), 'pay sheet should include accessible label')
  assert(payHtml.includes('Venmo'), 'pay sheet should include payment actions')

  const associationResponse = await fetch(`${listener.url}/.well-known/apple-app-site-association`)
  assert(associationResponse.ok, 'apple app site association should render')
  const association = await associationResponse.json() as { applinks?: unknown; appclips?: { apps?: string[] } }
  assert(Boolean(association.applinks), 'association should include applinks')
  assert(Boolean(association.appclips?.apps?.[0]), 'association should include appclips')

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
