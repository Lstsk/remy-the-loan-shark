import { loadEnv } from './env.ts'
import { getRemyState, runRemyAgent, understandExpenseMessage } from './tools.ts'

loadEnv()

const startedAt = Date.now()
const draft = await understandExpenseMessage({
  text: 'paid $86 dinner with Alex Brian Sam',
  payerName: 'Carson',
})

if (draft.total !== 86) throw new Error(`Expected total 86, got ${draft.total}`)
if (!draft.people.map((person) => person.toLowerCase()).includes('alex')) {
  throw new Error(`Expected Alex in people, got ${draft.people.join(', ')}`)
}

console.log(`PASS DeepSeek expense understanding in ${Date.now() - startedAt}ms.`)

const chatReply = await runRemyAgent({
  text: 'hey what are you',
  payerName: 'Carson',
})
if (chatReply.length < 8 || chatReply.toLowerCase().includes('missing')) {
  throw new Error(`Expected casual Remy chat reply, got ${chatReply}`)
}

const draftReply = await runRemyAgent({
  text: 'paid $42 uber with Alex Sam',
  payerName: 'Carson',
  baseUrl: 'https://remy.test',
})
if (!getRemyState().currentDraft) {
  throw new Error(`Expected tool-called draft, got reply: ${draftReply}`)
}
