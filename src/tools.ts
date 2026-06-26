import { createDeepSeek } from '@ai-sdk/deepseek'
import { generateText, stepCountIs, tool } from 'ai'
import { randomUUID } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { Agent, fetch as undiciFetch } from 'undici'
import { z } from 'zod'
import { publicBaseUrl } from './env.ts'
import {
  getCurrentExpense,
  getMissingContactsForCurrent,
  getStoredState,
  recordPaymentRequestEvent,
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
  id: z.string().optional(),
  uiVariant: z.enum(['link_preview', 'image_card', 'conversational_minimal']).default('link_preview'),
  friendName: z.string(),
  amount: z.number().positive(),
  url: z.string(),
  cardUrl: z.string().optional(),
  message: z.string(),
})

export type ExpenseDraft = z.infer<typeof expenseDraftSchema>
export type PaymentRequest = z.infer<typeof paymentRequestSchema>

export type AgentNextAction =
  | 'confirm_send'
  | 'payment_links_created'
  | 'collect_split_details'
  | 'no_recipients'
  | 'contact_saved'
  | 'answer_casually'

export interface SplitParticipantSummary {
  name: string
  amount: number
  role: 'payer' | 'recipient'
}

export interface SplitSummary {
  title: string
  payerName: string
  total: number
  splitMode: ExpenseDraft['splitMode']
  perPersonAmount: number
  includesPayer: boolean
  requestCount: number
  participants: SplitParticipantSummary[]
}

export interface AgentToolResult<TFacts> {
  ok: boolean
  action: string
  nextAction: AgentNextAction
  summary: string
  suggestedReply: string
  facts: TFacts
}

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
      '{"title":"Dinner","payerName":"Carson","total":86,"people":["Carson","Alex","Brian"],"splitMode":"equal","confidence":0.9}',
      'For equal splits, people must include the payer plus everyone who shared the expense.',
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

export function draftSplitForAgent(draft: ExpenseDraft): AgentToolResult<{
  draft: ExpenseDraft
  split: SplitSummary
}> {
  const parsed = expenseDraftSchema.parse(draft)
  rememberDraft(parsed)
  const split = buildSplitSummary(parsed)

  return {
    ok: true,
    action: 'draft_split',
    nextAction: split.requestCount > 0 ? 'confirm_send' : 'no_recipients',
    summary: formatSplitSummary(split),
    suggestedReply: enforcePlainTextReply(formatDraft(parsed)),
    facts: {
      draft: parsed,
      split,
    },
  }
}

export function getCurrentSplitForAgent(): AgentToolResult<{
  draft: ExpenseDraft | null
  split: SplitSummary | null
  requests: PaymentRequest[]
}> {
  const draft = state.currentDraft ?? draftFromStoredExpense()
  if (!draft) {
    return {
      ok: false,
      action: 'get_current_split_summary',
      nextAction: 'collect_split_details',
      summary: 'No active split draft.',
      suggestedReply: enforcePlainTextReply('What did you pay, how much was it, and who shared it?'),
      facts: {
        draft: null,
        split: null,
        requests: [],
      },
    }
  }

  const split = buildSplitSummary(draft)
  return {
    ok: true,
    action: 'get_current_split_summary',
    nextAction: split.requestCount > 0 ? 'confirm_send' : 'no_recipients',
    summary: formatSplitSummary(split),
    suggestedReply: split.requestCount > 0
      ? enforcePlainTextReply(`${formatSplitSummary(split)} Reply yes and I’ll make the payment link${split.requestCount === 1 ? '' : 's'}.`)
      : enforcePlainTextReply('I don’t see anyone else to request from on this split.'),
    facts: {
      draft,
      split,
      requests: getCurrentPaymentRequests(),
    },
  }
}

export function sendPaymentLinksForCurrentSplit(input: {
  baseUrl?: string
  forceVariant?: PaymentRequest['uiVariant']
} = {}): AgentToolResult<{
  draft: ExpenseDraft | null
  split: SplitSummary | null
  requests: PaymentRequest[]
}> {
  const draft = state.currentDraft ?? draftFromStoredExpense()
  if (!draft) {
    return {
      ok: false,
      action: 'send_payment_links_for_current_split',
      nextAction: 'collect_split_details',
      summary: 'No active split draft.',
      suggestedReply: enforcePlainTextReply('Send me the amount, what it was for, and who shared it first.'),
      facts: {
        draft: null,
        split: null,
        requests: [],
      },
    }
  }

  const split = buildSplitSummary(draft)
  if (split.requestCount === 0) {
    return {
      ok: false,
      action: 'send_payment_links_for_current_split',
      nextAction: 'no_recipients',
      summary: formatSplitSummary(split),
      suggestedReply: enforcePlainTextReply('I don’t see anyone else to request from on this split.'),
      facts: {
        draft,
        split,
        requests: [],
      },
    }
  }

  const existingRequests = getCurrentPaymentRequests(input.baseUrl)
  if (requestsMatchSplit(existingRequests, split)) {
    return {
      ok: true,
      action: 'send_payment_links_for_current_split',
      nextAction: 'payment_links_created',
      summary: formatSplitSummary(split),
      suggestedReply: enforcePlainTextReply(formatSentRequests(existingRequests)),
      facts: {
        draft,
        split,
        requests: existingRequests,
      },
    }
  }

  const requests = createPaymentRequests({
    draft,
    baseUrl: input.baseUrl,
    forceVariant: input.forceVariant,
  })

  return {
    ok: true,
    action: 'send_payment_links_for_current_split',
    nextAction: 'payment_links_created',
    summary: formatSplitSummary(split),
    suggestedReply: enforcePlainTextReply(formatSentRequests(requests)),
    facts: {
      draft,
      split,
      requests,
    },
  }
}

export function saveFriendContactForAgent(input: {
  displayName: string
  alias?: string
  phone?: string
  imessageHandle?: string
  preferredPayoutMethod?: string
  payoutHandle?: string
}): AgentToolResult<{
  contact: ReturnType<typeof saveContact>
}> {
  const contact = saveContact({
    ...input,
    source: 'agent',
  })

  return {
    ok: true,
    action: 'save_friend_contact',
    nextAction: 'contact_saved',
    summary: `Saved contact for ${contact.displayName}.`,
    suggestedReply: enforcePlainTextReply(`Got ${contact.displayName}. I’ll remember them for next time.`),
    facts: {
      contact,
    },
  }
}

export async function runRemyAgent(input: {
  text: string
  payerName?: string
  baseUrl?: string
}): Promise<string> {
  const payerName = input.payerName ?? 'Carson'
  const existingDraft = state.currentDraft ?? draftFromStoredExpense()
  if (existingDraft && isSendConfirmation(input.text)) {
    return enforcePlainTextReply(sendPaymentLinksForCurrentSplit({
      baseUrl: input.baseUrl ?? publicBaseUrl(),
    }).suggestedReply)
  }

  const wantsLocalTestSend = isLocalTestSend(input.text)
  if (wantsLocalTestSend) {
    const draft = existingDraft
    if (!draft) {
      return enforcePlainTextReply('Send me a split first, then say “test send it here.”')
    }

    return enforcePlainTextReply(formatTestRequests(createPaymentRequests({
      draft,
      baseUrl: input.baseUrl ?? publicBaseUrl(),
    })))
  }

  const { text } = await generateText({
    model: model(),
    stopWhen: stepCountIs(4),
    tools: {
      draft_split: tool({
        description: 'Normalize and store a split draft. Use when the user gives amount, what it was for, and who shared it. The tool owns split math, payer handling, and the suggested reply.',
        inputSchema: expenseDraftSchema.extend({
          payerName: z.string().default(payerName),
        }),
        execute: async (draft) => draftSplitForAgent(expenseDraftSchema.parse(draft)),
      }),
      send_payment_links_for_current_split: tool({
        description: 'Create tracked payment links for the active split after the payer confirms. The tool excludes the payer, chooses experiment variants, records events, and returns a suggested reply.',
        inputSchema: z.object({}),
        execute: async () => sendPaymentLinksForCurrentSplit({
          baseUrl: input.baseUrl ?? publicBaseUrl(),
        }),
      }),
      get_current_split_summary: tool({
        description: 'Read the active split in an agent-friendly shape: summary, next action, suggested reply, participants, and existing requests.',
        inputSchema: z.object({}),
        execute: async () => getCurrentSplitForAgent(),
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
      save_friend_contact: tool({
        description: 'Save a friend contact only when the user shares contact details or asks for direct iMessage delivery. Contact cards are not required for shareable payment links.',
        inputSchema: z.object({
          displayName: z.string(),
          alias: z.string().optional(),
          phone: z.string().optional(),
          imessageHandle: z.string().optional(),
          preferredPayoutMethod: z.string().optional(),
          payoutHandle: z.string().optional(),
        }),
        execute: async (input) => saveFriendContactForAgent(input),
      }),
    },
    prompt: [
      'You are Remy, an iMessage-first agent that gets friends paid back without making it awkward.',
      'Reply naturally and briefly.',
      'Use plain text only. No markdown, no bold, no bullets, no numbered lists, no headings, no code fences, no block quotes, no markdown links.',
      'Use agent-facing tools for product actions instead of doing split math or contact/payment policy in your own text.',
      'Use draft_split when the user gives enough info to draft a split.',
      'Use get_current_split_summary if the user is referring to an existing split and you need context.',
      'Use send_payment_links_for_current_split after they confirm sending.',
      'Use save_friend_contact only when the user shares contact details or asks for direct delivery.',
      'When a tool returns suggestedReply, use it as the backbone of your answer. You may make it warmer, but do not add extra requirements.',
      'Never block a shareable payment link on contact cards.',
      'Ask one casual follow-up if an expense is missing amount or people.',
      'For greetings or random chat, answer normally as Remy and invite them to text what they paid.',
      `Default payer name: ${payerName}.`,
      `User message: ${input.text}`,
    ].join('\n'),
  })

  return enforcePlainTextReply(text)
}

export function enforcePlainTextReply(reply: string): string {
  const unfenced = reply
    .split('\n')
    .filter((line) => !/^```/.test(line.trim()))
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .trimEnd())
    .join('\n')

  const urlTokens: string[] = []
  const withoutMarkdownLinks = unfenced
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2')

  const protectedUrls = withoutMarkdownLinks.replace(/https?:\/\/\S+/g, (url) => {
    const token = `URLTOKEN${urlTokens.length}TOKEN`
    urlTokens.push(url)
    return token
  })

  const plain = protectedUrls
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return urlTokens.reduce(
    (text, url, index) => text.replaceAll(`URLTOKEN${index}TOKEN`, url),
    plain,
  )
}

export function isLocalTestSend(text: string): boolean {
  return /\b(test|demo|preview|try it|send it here|send here|send to me|send them here|show me|link here)\b/i.test(text)
}

export function isSendConfirmation(text: string): boolean {
  return /^(yes|yep|yeah|sure|ok|okay|send|send it|do it|please do|go ahead|sounds good|lets do it|let's do it)[.! ]*$/i.test(text.trim())
}

export function formatTestRequests(requests: PaymentRequest[]): string {
  return [
    'Test variants ready.',
    '',
    ...requests.map(formatPaymentRequestForChat),
    '',
    'In production, each person gets only their own variant.',
  ].join('\n')
}

export function formatSentRequests(requests: PaymentRequest[]): string {
  if (requests.length === 0) {
    return 'I don’t see anyone else to request from on this split.'
  }

  if (requests.length === 1) {
    const [request] = requests
    return [
      `Done. ${request.friendName} owes $${request.amount.toFixed(2)}:`,
      request.url,
    ].join('\n')
  }

  return [
    'Done. Payment links:',
    ...requests.map((request) => `${request.friendName}: $${request.amount.toFixed(2)} ${request.url}`),
  ].join('\n')
}

function draftFromStoredExpense(): ExpenseDraft | null {
  const current = getCurrentExpense()
  if (!current || current.participants.length === 0) return null

  return expenseDraftSchema.parse({
    title: current.expense.title,
    payerName: current.expense.payerName,
    total: current.expense.total,
    people: current.participants.map((participant) => participant.displayName),
    splitMode: current.expense.splitMode,
    confidence: current.expense.confidence,
  })
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
  forceVariant?: PaymentRequest['uiVariant']
}): PaymentRequest[] {
  const baseUrl = input.baseUrl ?? publicBaseUrl()
  const split = splitDraft(input.draft)
  const requests = split.requestPeople.map((friendName, index) => {
    const id = randomUUID()
    const uiVariant = input.forceVariant ?? selectPaymentUiVariant(`${input.draft.title}:${friendName}:${index}`)
    const pay = new URL(`/r/${id}`, baseUrl)
    pay.searchParams.set('friend', friendName.toLowerCase())
    pay.searchParams.set('amount', split.each.toFixed(2))
    pay.searchParams.set('title', input.draft.title)
    const card = new URL(`/card/${id}.svg`, baseUrl)

    return paymentRequestSchema.parse({
      id,
      uiVariant,
      friendName,
      amount: split.each,
      url: pay.toString(),
      cardUrl: card.toString(),
      message: formatPaymentRequestMessage({
        payerName: input.draft.payerName,
        title: input.draft.title,
        request: {
          id,
          uiVariant,
          friendName,
          amount: split.each,
          url: pay.toString(),
          cardUrl: card.toString(),
        },
      }),
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
  const saved = savePaymentRequestsForCurrent(requests)
  for (const request of saved) {
    recordPaymentRequestEvent({ requestId: request.id, eventType: 'created' })
  }
  return requests
}

export function selectPaymentUiVariant(seed: string): PaymentRequest['uiVariant'] {
  const forced = process.env.REMY_PAYMENT_UI_VARIANT
  if (forced === 'link_preview' || forced === 'image_card' || forced === 'conversational_minimal') {
    return forced
  }

  const variants: Array<PaymentRequest['uiVariant']> = ['link_preview', 'image_card', 'conversational_minimal']
  const score = [...seed].reduce((total, char) => total + char.charCodeAt(0), 0)
  return variants[score % variants.length]
}

export function formatPaymentRequestForChat(request: PaymentRequest): string {
  recordMessageRendered(request)

  if (request.uiVariant === 'image_card' && request.cardUrl) {
    return [
      `${request.friendName}, your share is $${request.amount.toFixed(2)}.`,
      request.cardUrl,
      `Pay: ${request.url}`,
    ].join('\n')
  }

  if (request.uiVariant === 'conversational_minimal') {
    return `${request.friendName}: $${request.amount.toFixed(2)}. Pay here: ${request.url}`
  }

  return [
    `${request.friendName}: $${request.amount.toFixed(2)}`,
    request.url,
  ].join('\n')
}

function formatPaymentRequestMessage(input: {
  payerName: string
  title: string
  request: Pick<PaymentRequest, 'friendName' | 'amount' | 'url' | 'uiVariant' | 'cardUrl' | 'id'>
}): string {
  const amount = input.request.amount.toFixed(2)
  if (input.request.uiVariant === 'image_card' && input.request.cardUrl) {
    return [
      input.request.cardUrl,
      `${input.request.friendName}, ${input.payerName} paid for ${input.title.toLowerCase()}.`,
      `Your share is $${amount}. Pay here: ${input.request.url}`,
      '',
      'powered by Remy',
    ].join('\n')
  }

  if (input.request.uiVariant === 'conversational_minimal') {
    return `${input.request.friendName}, your share is $${amount} for ${input.title.toLowerCase()}. Pay here: ${input.request.url}`
  }

  return `${input.payerName} paid for ${input.title.toLowerCase()}. You owe $${amount}. Pay here: ${input.request.url}\n\npowered by Remy`
}

function recordMessageRendered(request: PaymentRequest): void {
  if (!request.id) return
  recordPaymentRequestEvent({ requestId: request.id, eventType: 'message_rendered' })
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
  const split = splitDraft(draft)
  const requestNames = split.requestPeople.join(', ')
  const paidLine = split.includesPayer
    ? `${draft.payerName} paid. ${requestNames || 'No one else'} ${split.requestPeople.length === 1 ? 'owes' : 'owe'} $${split.each.toFixed(2)}${split.requestPeople.length > 1 ? ' each' : ''}.`
    : `${requestNames} ${split.requestPeople.length === 1 ? 'owes' : 'owe'} $${split.each.toFixed(2)}${split.requestPeople.length > 1 ? ' each' : ''}.`
  return [
    `${draft.title}: $${draft.total.toFixed(2)}`,
    paidLine,
    'Reply yes and I’ll make the payment link.',
  ].join('\n')
}

function splitDraft(draft: ExpenseDraft): {
  each: number
  includesPayer: boolean
  requestPeople: string[]
} {
  const includesPayer = draft.people.some((name) => samePerson(name, draft.payerName))
  const divisor = Math.max(draft.people.length, 1)
  const requestPeople = draft.people.filter((name) => !samePerson(name, draft.payerName))

  return {
    each: Math.round((draft.total / divisor) * 100) / 100,
    includesPayer,
    requestPeople: includesPayer ? requestPeople : draft.people,
  }
}

function buildSplitSummary(draft: ExpenseDraft): SplitSummary {
  const split = splitDraft(draft)
  return {
    title: draft.title,
    payerName: draft.payerName,
    total: draft.total,
    splitMode: draft.splitMode,
    perPersonAmount: split.each,
    includesPayer: split.includesPayer,
    requestCount: split.requestPeople.length,
    participants: draft.people.map((name) => ({
      name,
      amount: split.each,
      role: samePerson(name, draft.payerName) ? 'payer' : 'recipient',
    })),
  }
}

function getCurrentPaymentRequests(baseUrl?: string): PaymentRequest[] {
  if (state.requests.length > 0) return state.requests

  const stored = getStoredState()
  const requests = stored.requests.map((request) => {
    const card = new URL(`/card/${request.id}.svg`, baseUrl ?? publicBaseUrl())
    return paymentRequestSchema.parse({
      id: request.id,
      uiVariant: parsePaymentUiVariant(request.uiVariant),
      friendName: request.friendName,
      amount: request.amount,
      url: request.url,
      cardUrl: card.toString(),
      message: request.message,
    })
  })
  state.requests = requests
  return requests
}

function requestsMatchSplit(requests: PaymentRequest[], split: SplitSummary): boolean {
  const recipients = split.participants.filter((participant) => participant.role === 'recipient')
  if (requests.length !== recipients.length) return false

  return recipients.every((participant) => requests.some((request) => (
    samePerson(request.friendName, participant.name) &&
    Math.abs(request.amount - participant.amount) < 0.01
  )))
}

function parsePaymentUiVariant(value: string): PaymentRequest['uiVariant'] {
  if (value === 'image_card' || value === 'conversational_minimal') return value
  return 'link_preview'
}

function formatSplitSummary(split: SplitSummary): string {
  const recipients = split.participants.filter((participant) => participant.role === 'recipient')
  if (recipients.length === 0) {
    return `${split.title}: $${split.total.toFixed(2)}. ${split.payerName} paid.`
  }

  const names = recipients.map((participant) => participant.name).join(', ')
  const owe = recipients.length === 1 ? 'owes' : 'owe'
  const each = recipients.length === 1 ? '' : ' each'
  const payerContext = split.includesPayer ? `${split.payerName} paid. ` : ''
  return `${split.title}: $${split.total.toFixed(2)}. ${payerContext}${names} ${owe} $${split.perPersonAmount.toFixed(2)}${each}.`
}

function samePerson(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}
