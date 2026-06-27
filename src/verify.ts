import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpApp } from './mcp.ts'
import {
  createPaymentRequests,
  draftSplitForAgent,
  enforcePlainTextReply,
  expenseDraftSchema,
  formatDraft,
  formatSentRequests,
  formatTestRequests,
  getCurrentSplitForAgent,
  replyFromModelAndTools,
  reviseCurrentSplitForAgent,
  sendPaymentLinksForCurrentSplit,
} from './tools.ts'
import {
  getRecentConversationMessages,
  saveConversationMessage,
} from './db/repository.ts'

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

const requests = createPaymentRequests({ draft, baseUrl: 'https://remy.test', forceVariant: 'image_card' })
assert(requests.length === 3, 'expected three payment requests')
assert(formatDraft(draft).includes('Reply yes'), 'draft reply should ask for confirmation')
assert(formatTestRequests(requests).includes('Test variants ready'), 'test requests should say test variants are ready')
assert(formatTestRequests(requests).includes('https://remy.test/r'), 'test requests should include tracked pay links')
assert(formatTestRequests(requests).includes('https://remy.test/card'), 'image-card variant should include card links')
const plainReply = enforcePlainTextReply([
  '# Split',
  '- **James** owes `$43.00`',
  '[Pay link](https://remy.test/r/abc_def?title=Dinner)',
].join('\n'))
assert(!/[#*`\[\]()]/.test(plainReply.replace('https://remy.test/r/abc_def?title=Dinner', '')), 'plain reply should strip markdown')
assert(plainReply.includes('https://remy.test/r/abc_def?title=Dinner'), 'plain reply should preserve URLs')

const payerIncludedDraft = expenseDraftSchema.parse({
  title: 'Dinner',
  payerName: 'Carson',
  total: 86,
  people: ['Carson', 'James'],
  splitMode: 'equal',
  confidence: 0.9,
})
const payerIncludedRequests = createPaymentRequests({
  draft: payerIncludedDraft,
  baseUrl: 'https://remy.test',
  forceVariant: 'link_preview',
})
assert(payerIncludedRequests.length === 1, 'payer should not receive a payment request')
assert(payerIncludedRequests[0].friendName === 'James', 'friend should receive the request')
assert(payerIncludedRequests[0].amount === 43, 'friend should owe their half when payer is included')
assert(formatSentRequests(payerIncludedRequests).startsWith('Done. Payment card for James: $43.00'), 'sent reply should surface a payment card')
assert(formatSentRequests(payerIncludedRequests).includes('https://remy.test/card'), 'sent reply should surface the payment card')
assert(formatSentRequests(payerIncludedRequests).includes('Pay: https://remy.test/r'), 'sent reply should keep the tracked pay link')

const agentDraft = draftSplitForAgent(payerIncludedDraft)
assert(agentDraft.nextAction === 'confirm_send', 'agent draft tool should point to confirmation')
assert(agentDraft.suggestedReply.includes('James owes $43.00'), 'agent draft tool should suggest a useful reply')
assert(getCurrentSplitForAgent().summary.includes('James owes $43.00'), 'agent state tool should summarize the active split')
const agentSend = sendPaymentLinksForCurrentSplit({
  baseUrl: 'https://remy.test',
  forceVariant: 'link_preview',
})
assert(agentSend.nextAction === 'payment_links_created', 'agent send tool should create links')
assert(agentSend.facts.requests.length === 1, 'agent send tool should only request from James')
assert(agentSend.suggestedReply.startsWith('Done. Payment card for James: $43.00'), 'agent send tool should suggest a card reply')
assert(
  replyFromModelAndTools("Done! Here's the link to send James.", [{ output: agentSend }]).includes('https://remy.test/card'),
  'payment-link tool reply should preserve the card URL even if the model drops it',
)
const repeatedAgentSend = sendPaymentLinksForCurrentSplit({
  baseUrl: 'https://remy.test',
  forceVariant: 'image_card',
})
assert(repeatedAgentSend.facts.requests[0].url === agentSend.facts.requests[0].url, 'agent send tool should reuse existing links')

const memoryOwner = `verify-memory-${Date.now()}`
for (let index = 0; index < 12; index += 1) {
  saveConversationMessage({
    ownerUserId: memoryOwner,
    conversationId: 'chat-a',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `msg ${index}`,
  })
  await new Promise((resolve) => setTimeout(resolve, 2))
}
const recentMessages = getRecentConversationMessages({
  ownerUserId: memoryOwner,
  conversationId: 'chat-a',
  limit: 10,
})
assert(recentMessages.length === 10, 'conversation memory should return the last 10 messages')
assert(recentMessages[0].content === 'msg 2', 'conversation memory should drop older messages')
assert(recentMessages[9].content === 'msg 11', 'conversation memory should preserve chronological order')

const scopeOwner = `verify-scope-${Date.now()}`
const scopeA = { ownerUserId: scopeOwner, conversationId: 'chat-a' }
const scopeB = { ownerUserId: scopeOwner, conversationId: 'chat-b' }
draftSplitForAgent(expenseDraftSchema.parse({
  title: 'Dinner',
  payerName: 'Carson',
  total: 87,
  people: ['James'],
  splitMode: 'equal',
  confidence: 0.9,
}), scopeA)
draftSplitForAgent(expenseDraftSchema.parse({
  title: 'Coffee',
  payerName: 'Carson',
  total: 24,
  people: ['Alex'],
  splitMode: 'equal',
  confidence: 0.9,
}), scopeB)
assert(getCurrentSplitForAgent(scopeA).summary.includes('James owes $43.50'), 'scope A should keep James split')
assert(getCurrentSplitForAgent(scopeB).summary.includes('Alex owes $12.00'), 'scope B should keep Alex split')

const revisionScope = { ownerUserId: scopeOwner, conversationId: 'revision-chat' }
draftSplitForAgent(expenseDraftSchema.parse({
  title: 'Expense',
  payerName: 'Carson',
  total: 87,
  people: ['Carson'],
  splitMode: 'equal',
  confidence: 0.75,
}), revisionScope)
const revised = reviseCurrentSplitForAgent({
  title: 'Dinner',
  people: ['Carson', 'James'],
}, revisionScope)
assert(revised.nextAction === 'confirm_send', 'revision should move back to confirmation when recipient exists')
assert(revised.summary.includes('James owes $43.50'), 'revision should recalculate the corrected recipient')
const revisedSend = sendPaymentLinksForCurrentSplit({
  ...revisionScope,
  baseUrl: 'https://remy.test',
  forceVariant: 'link_preview',
})
assert(revisedSend.facts.requests.length === 1, 'revised split should send one request')
assert(revisedSend.facts.requests[0].amount === 43.5, 'revised split request should be half of 87')

const listener = localServe(createMcpApp().fetch)
try {
  const client = new Client({ name: 'remy-verify', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${listener.url}/mcp`))
  await client.connect(transport)

  const tools = await client.listTools()
  const toolNames = tools.tools.map((tool) => tool.name)
  assert(toolNames.includes('run_remy_agent'), 'missing run_remy_agent')
  assert(toolNames.includes('draft_split'), 'missing draft_split')
  assert(toolNames.includes('revise_current_split'), 'missing revise_current_split')
  assert(toolNames.includes('send_payment_links_for_current_split'), 'missing send_payment_links_for_current_split')
  assert(toolNames.includes('get_current_split_summary'), 'missing get_current_split_summary')
  assert(toolNames.includes('create_payment_requests'), 'missing create_payment_requests')
  assert(toolNames.includes('get_remy_state'), 'missing get_remy_state')

  await client.close()

  const payResponse = await fetch(`${listener.url}/pay?friend=alex&amount=28.67&title=Dinner`)
  assert(payResponse.ok, 'pay sheet should render')
  const payHtml = await payResponse.text()
  assert(payHtml.includes('Remy payment request'), 'pay sheet should include accessible label')
  assert(payHtml.includes('Venmo'), 'pay sheet should include payment actions')

  const requestId = requests[0].id
  assert(requestId, 'payment request should have an id')
  const cardResponse = await fetch(`${listener.url}/card/${requestId}.svg`)
  assert(cardResponse.ok, 'image-card SVG should render')
  assert(cardResponse.headers.get('content-type')?.includes('image/svg+xml'), 'image-card route should serve SVG')
  const cardSvg = await cardResponse.text()
  assert(cardSvg.includes('Remy payment card'), 'image-card SVG should include accessible label')
  assert(cardSvg.includes('Payment card ready'), 'image-card SVG should render the polished widget copy')

  const idPayResponse = await fetch(`${listener.url}/pay/${requestId}`)
  assert(idPayResponse.ok, 'id pay sheet should render')
  const idPayHtml = await idPayResponse.text()
  assert(idPayHtml.includes(`property="og:image" content="${listener.url}/card/${requestId}.svg"`), 'pay sheet should expose card metadata')
  assert(idPayHtml.includes('Payment widget preview'), 'pay sheet should render the widget preview')

  const trackedResponse = await fetch(`${listener.url}/r/${requestId}`)
  assert(trackedResponse.ok, 'tracked pay redirect should resolve to pay sheet')

  const experimentResponse = await fetch(`${listener.url}/experiments/payment-ui`)
  assert(experimentResponse.ok, 'experiment summary should render')
  const experimentJson = await experimentResponse.json() as { summary: Array<{ variant: string, clicks: number, cardViews: number }> }
  const imageSummary = experimentJson.summary.find((row) => row.variant === 'image_card')
  assert(imageSummary && imageSummary.cardViews > 0, 'experiment summary should count card views')
  assert(imageSummary.clicks > 0, 'experiment summary should count clicks')

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
