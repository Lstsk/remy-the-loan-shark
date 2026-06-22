import { createDeepSeek } from '@ai-sdk/deepseek'
import { generateText, stepCountIs, tool } from 'ai'
import { Resolver } from 'node:dns/promises'
import { Agent, fetch as undiciFetch } from 'undici'
import { z } from 'zod'
import { publicBaseUrl } from './env.ts'
import {
  getCurrentExpense,
  getMissingContactsForCurrent,
  getStoredState,
  resolveContact,
  saveContact,
  saveExpenseDraft,
  savePaymentRequestsForCurrent,
} from './db/repository.ts'

export const expenseDraftSchema = z.object({
  title: z.string().default('Expense'),
  payerName: z.string().default('Carson'),
  total: z.number().positive(),
  people: z.array(z.string().min(1)).min(1),
  splitMode: z.enum(['equal', 'custom', 'itemized']).default('equal'),
  confidence: z.number().min(0).max(1).default(0.8),
})

export const paymentRequestSchema = z.object({
  friendName: z.string(),
  amount: z.number().positive(),
  url: z.string(),
  message: z.string(),
})

export type ExpenseDraft = z.infer<typeof expenseDraftSchema>
export type PaymentRequest = z.infer<typeof paymentRequestSchema>

const state = {
  currentDraft: null as ExpenseDraft | null,
  requests: [] as PaymentRequest[],
}

const deepseekHosts = new Set(['api.deepseek.com'])
const publicDnsResolver = new Resolver()
publicDnsResolver.setServers(['1.1.1.1', '8.8.8.8'])

const deepseekAgent = new Agent({
  connect: {
    async lookup(host, options, callback) {
      try {
        if (!deepseekHosts.has(host)) {
          callback(new Error(`Unexpected DeepSeek lookup host: ${host}`), '', 4)
          return
        }

        const addresses = await publicDnsResolver.resolve4(host)
        const address = addresses[0]
        if (!address) throw new Error(`No public A record for ${host}`)

        if (options.all) {
          callback(null, [{ address, family: 4 }])
        } else {
          callback(null, address, 4)
        }
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)), '', 4)
      }
    },
  },
})

function deepseekFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url)
  if (process.env.DEEPSEEK_PUBLIC_DNS !== 'false' && deepseekHosts.has(url.hostname)) {
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher: deepseekAgent,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
  }

  return fetch(input, init)
}

function model() {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is required for receipt understanding')
  }

  const deepseek = createDeepSeek({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    fetch: deepseekFetch,
  })

  return deepseek(process.env.RECEIPTS_AI_MODEL ?? 'deepseek-chat')
}

export async function understandExpenseMessage(input: {
  text: string
  payerName?: string
}): Promise<ExpenseDraft> {
  const { text } = await generateText({
    model: model(),
    prompt: [
      'Extract one friend expense from this iMessage.',
      'Return only valid JSON. No markdown. No commentary.',
      'Use this exact shape:',
      '{"title":"Dinner","payerName":"Carson","total":86,"people":["Alex","Brian"],"splitMode":"equal","confidence":0.9}',
      'Do not invent missing amounts or people.',
      `Default payerName: ${input.payerName ?? 'Carson'}.`,
      `Message: ${input.text}`,
    ].join('\n'),
  })

  const draft = expenseDraftSchema.parse(parseJsonObject(text))
  rememberDraft(draft)
  return draft
}

export function rememberDraft(draft: ExpenseDraft): void {
  state.currentDraft = draft
  state.requests = []
  saveExpenseDraft(draft)
}

export async function runRemyAgent(input: {
  text: string
  payerName?: string
  baseUrl?: string
}): Promise<string> {
  const payerName = input.payerName ?? 'Carson'
  const { text } = await generateText({
    model: model(),
    stopWhen: stepCountIs(4),
    tools: {
      draft_expense: tool({
        description: 'Draft a split when the user gives enough expense details: amount, what it was for, and who should pay back.',
        inputSchema: expenseDraftSchema.extend({
          payerName: z.string().default(payerName),
        }),
        execute: async (draft) => {
          const parsed = expenseDraftSchema.parse(draft)
          rememberDraft(parsed)
          return {
            draft: parsed,
            message: formatDraft(parsed),
          }
        },
      }),
      create_payment_requests: tool({
        description: 'Create payment request messages after the payer confirms they want to send the current draft. If contacts are missing, ask for contact cards instead.',
        inputSchema: z.object({}),
        execute: async () => {
          if (!state.currentDraft) {
            return { error: 'No current draft. Ask what they paid first.' }
          }

          const missingContacts = getMissingContactsForCurrent()
          if (missingContacts.length > 0) {
            return {
              missingContacts,
              message: `I can’t see your iPhone Contacts yet. Share ${missingContacts.join(', ')}’s contact card here once, then I can send the requests.`,
            }
          }

          const requests = createPaymentRequests({
            draft: state.currentDraft,
            baseUrl: input.baseUrl ?? publicBaseUrl(),
          })

          return {
            requests,
            message: [
              'Requests ready.',
              ...requests.map((request) => `${request.friendName}: $${request.amount.toFixed(2)}`),
            ].join('\n'),
          }
        },
      }),
      get_current_draft: tool({
        description: 'Check whether there is already a drafted expense in this chat.',
        inputSchema: z.object({}),
        execute: async () => getRemyState(),
      }),
      resolve_contact: tool({
        description: 'Look up whether Remy already knows a friend by name or alias.',
        inputSchema: z.object({
          alias: z.string(),
        }),
        execute: async ({ alias }) => {
          const result = resolveContact(alias)
          return result?.contact ?? { missing: true, alias }
        },
      }),
      save_contact: tool({
        description: 'Save a contact mapping after the user provides a phone number, iMessage handle, or contact-card details.',
        inputSchema: z.object({
          displayName: z.string(),
          alias: z.string().optional(),
          phone: z.string().optional(),
          imessageHandle: z.string().optional(),
          preferredPayoutMethod: z.string().optional(),
          payoutHandle: z.string().optional(),
        }),
        execute: async (input) => saveContact({
          ...input,
          source: 'agent',
        }),
      }),
    },
    prompt: [
      'You are Remy, an iMessage-first agent that gets friends paid back without making it awkward.',
      'Reply naturally and briefly.',
      'Do not force every message into a category.',
      'Use tools only when they help:',
      '- Use draft_expense when the user gives enough info to draft a split.',
      '- Use get_current_draft if the user says yes/send/pay and you need to know what they are confirming.',
      '- Use create_payment_requests after they confirm sending a draft.',
      '- Use resolve_contact when a name may need a saved phone/iMessage handle.',
      '- Use save_contact when the user gives contact details.',
      'If contact info is missing, never say the user does not have contacts. Say Remy cannot see their iPhone Contacts yet and ask them to share the contact card in this chat once.',
      'Ask one casual follow-up if an expense is missing amount or people.',
      'For greetings or random chat, answer normally as Remy and invite them to text what they paid.',
      `Default payer name: ${payerName}.`,
      `User message: ${input.text}`,
    ].join('\n'),
  })

  return text.trim()
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`DeepSeek did not return JSON: ${trimmed.slice(0, 160)}`)
  }

  const parsed = JSON.parse(unfenced.slice(start, end + 1))
  if (parsed?.error) {
    throw new Error(`DeepSeek could not extract expense: ${parsed.error}`)
  }

  return parsed
}

export function createPaymentRequests(input: {
  draft: ExpenseDraft
  baseUrl?: string
}): PaymentRequest[] {
  const baseUrl = input.baseUrl ?? publicBaseUrl()
  const each = Math.round((input.draft.total / input.draft.people.length) * 100) / 100
  const requests = input.draft.people.map((friendName) => {
    const pay = new URL('/pay', baseUrl)
    pay.searchParams.set('friend', friendName.toLowerCase())
    pay.searchParams.set('amount', each.toFixed(2))
    pay.searchParams.set('title', input.draft.title)

    return paymentRequestSchema.parse({
      friendName,
      amount: each,
      url: pay.toString(),
      message: `${input.draft.payerName} paid for ${input.draft.title.toLowerCase()}. You owe $${each.toFixed(2)}. Pay here: ${pay.toString()}\n\npowered by Remy`,
    })
  })

  state.currentDraft = input.draft
  state.requests = requests
  const currentExpense = getCurrentExpense()
  const currentPeople = currentExpense?.participants.map((participant) => participant.displayName).sort().join('|')
  const draftPeople = [...input.draft.people].sort().join('|')
  if (
    !currentExpense ||
    currentExpense.expense.title !== input.draft.title ||
    currentExpense.expense.total !== input.draft.total ||
    currentPeople !== draftPeople
  ) {
    saveExpenseDraft(input.draft)
  }
  savePaymentRequestsForCurrent(requests)
  return requests
}

export function getRemyState() {
  const stored = getStoredState()
  const currentExpense = getCurrentExpense()
  return {
    currentDraft: state.currentDraft,
    requests: state.requests,
    stored,
    currentExpense,
    missingContacts: getMissingContactsForCurrent(),
  }
}

export function formatDraft(draft: ExpenseDraft): string {
  const each = draft.total / draft.people.length
  const lines = draft.people.map((name) => `${name}: $${each.toFixed(2)}`)
  return [
    `Got it. ${draft.payerName} paid $${draft.total.toFixed(2)} for ${draft.title.toLowerCase()}.`,
    ...lines,
    '',
    'Reply yes to send requests.',
  ].join('\n')
}
