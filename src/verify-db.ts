import { rmSync } from 'node:fs'

rmSync('data', { recursive: true, force: true })

const { createPaymentRequests, expenseDraftSchema, getRemyState, rememberDraft } = await import('./tools.ts')
const { resolveContact, saveContact } = await import('./db/repository.ts')

const contact = saveContact({
  displayName: 'Alex Chen',
  alias: 'Alex',
  phone: '+14155550123',
  source: 'verify',
})

const resolved = resolveContact('alex')
if (!resolved || resolved.contact.id !== contact.id) {
  throw new Error('Expected saved contact alias to resolve')
}

const draft = expenseDraftSchema.parse({
  title: 'Dinner',
  payerName: 'Carson',
  total: 86,
  people: ['Alex', 'Brian'],
  splitMode: 'equal',
  confidence: 0.95,
})

rememberDraft(draft)
const requests = createPaymentRequests({ draft, baseUrl: 'https://remy.test' })
if (requests.length !== 2) throw new Error(`Expected 2 requests, got ${requests.length}`)

const state = getRemyState()
if (!state.currentExpense?.expense) throw new Error('Expected persisted current expense')
if (state.currentExpense.participants.length !== 2) throw new Error('Expected persisted participants')
if (state.stored.requests.length !== 2) throw new Error('Expected persisted payment requests')

console.log('PASS Remy SQLite contact/expense/request persistence verified.')
