import { loadEnv } from './env.ts'
import { getRemyState, runRemyAgent } from './tools.ts'

loadEnv()

const startedAt = Date.now()
const chatReply = await runRemyAgent({
  text: 'hey what are you',
  payerName: 'Carson',
  ownerUserId: `verify-live-chat-${startedAt}`,
  conversationId: 'chat',
})
if (chatReply.length < 8 || chatReply.toLowerCase().includes('missing')) {
  throw new Error(`Expected casual Remy chat reply, got ${chatReply}`)
}

const draftScope = {
  ownerUserId: `verify-live-draft-${startedAt}`,
  conversationId: 'draft',
}
const draftReply = await runRemyAgent({
  ...draftScope,
  text: 'paid $42 uber with Alex Sam',
  payerName: 'Carson',
  baseUrl: 'https://remy.test',
})
if (!getRemyState(draftScope).currentDraft) {
  throw new Error(`Expected tool-called draft, got reply: ${draftReply}`)
}

console.log(`PASS DeepSeek Remy agent tool path in ${Date.now() - startedAt}ms.`)
