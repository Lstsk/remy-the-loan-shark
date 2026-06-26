import { createDeepSeek } from '@ai-sdk/deepseek'
import { generateText, stepCountIs, tool } from 'ai'
import type { ModelMessage } from 'ai'
import { randomUUID } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { Agent, fetch as undiciFetch } from 'undici'
import { z } from 'zod'
import { publicBaseUrl } from './env.ts'
import {
  defaultConversationId,
  defaultOwnerUserId,
  getCurrentExpense,
  getMissingContactsForCurrent,
  getRecentConversationMessages,
  getStoredState,
  recordPaymentRequestEvent,
  resolveContact,
  saveConversationMessage,
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

export const reviseSplitSchema = z.object({
  title: z.string().optional(),
  payerName: z.string().optional(),
  total: z.number().positive().optional(),
  people: z.array(z.string().min(1)).optional(),
  addPeople: z.array(z.string().min(1)).optional(),
  removePeople: z.array(z.string().min(1)).optional(),
  splitMode: z.enum(['equal', 'custom', 'itemized']).optional(),
  confidence: z.number().min(0).max(1).optional(),
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
export type SplitRevision = z.infer<typeof reviseSplitSchema>
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

export interface AgentScope {
  ownerUserId?: string
  conversationId?: string
}

const state = {
  currentDrafts: new Map<string, ExpenseDraft>(),
  requests: new Map<string, PaymentRequest[]>(),
}

const conversationMemoryLimit = 10

function scopedOwner(input: AgentScope = {}): string {
  return input.ownerUserId ?? defaultOwnerUserId
}

function scopedConversation(input: AgentScope = {}): string {
  return input.conversationId ?? defaultConversationId
}

function scopeKey(input: AgentScope = {}): string {
  return `${scopedOwner(input)}:${scopedConversation(input)}`
}

const plainTextSystemPrompt = [
  'You are Remy, an iMessage-first agent that gets friends paid back without making it awkward.',
  'Reply naturally and briefly.',
  'You must output plain text only.',
  'Do not use markdown.',
  'Do not use bold, italics, bullets, numbered lists, headings, code fences, block quotes, or markdown links.',
  'Write like a normal iMessage.',
  'Use agent-facing tools for product actions instead of doing split math or contact/payment policy in your own text.',
  'The last 10 user and assistant messages are included. Use them as conversation memory.',
  'Use draft_split when the user gives enough info to draft a split.',
  'Use revise_current_split when the user corrects or completes a previous split, like "I meant James", "half of 87", "make it lunch", or "add Sam".',
  'Use get_current_split_summary if the user is referring to an existing split and you need context.',
  'Use send_payment_links_for_current_split after they confirm sending.',
  'Use save_friend_contact only when the user shares contact details or asks for direct delivery.',
  'When a tool returns suggestedReply, use it as the backbone of your answer. You may make it warmer, but do not add extra requirements.',
  'Never block a shareable payment link on contact cards.',
  'Ask one casual follow-up if an expense is missing amount or people.',
  'Example: user says "paid 87 dinner with James". Call draft_split with title Dinner, total 87, payerName Carson, people Carson and James.',
  'Example: previous split is $87 with Carson, user says "I meant with James". Call revise_current_split with people Carson and James.',
  'Example: user says "James needs to pay me half of 87". Call draft_split with total 87, payerName Carson, people Carson and James.',
  'For greetings or random chat, answer normally as Remy and invite them to text what they paid.',
].join('\n')

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

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function titleCaseName(value: string): string {
  return cleanName(value)
    .split(/\s+/)
    .map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join(' ')
}

function uniqueNames(names: string[]): string[] {
  const result: string[] = []
  for (const name of names.map(titleCaseName).filter(Boolean)) {
    if (!result.some((existing) => samePerson(existing, name))) result.push(name)
  }
  return result
}

function normalizeDraftTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, ' ')
  if (!title || /^expense$/i.test(title)) return 'Shared expense'
  return title
}

function normalizeAgentDraft(draft: ExpenseDraft): ExpenseDraft {
  const payerName = cleanName(draft.payerName) || 'Carson'
  const people = uniqueNames(draft.people)
  const includesPayer = people.some((name) => samePerson(name, payerName))
  const normalizedPeople = includesPayer ? people : [payerName, ...people]

  return expenseDraftSchema.parse({
    ...draft,
    title: normalizeDraftTitle(draft.title),
    payerName,
    people: normalizedPeople,
  })
}

function rememberUserMessage(text: string, scope: AgentScope): void {
  saveConversationMessage({
    ownerUserId: scopedOwner(scope),
    conversationId: scopedConversation(scope),
    role: 'user',
    content: text,
  })
}

function rememberAssistantReply(reply: string, scope: AgentScope): string {
  const plain = enforcePlainTextReply(reply)
  saveConversationMessage({
    ownerUserId: scopedOwner(scope),
    conversationId: scopedConversation(scope),
    role: 'assistant',
    content: plain,
  })
  return plain
}

function modelMessagesForScope(scope: AgentScope): ModelMessage[] {
  return getRecentConversationMessages({
    ownerUserId: scopedOwner(scope),
    conversationId: scopedConversation(scope),
    limit: conversationMemoryLimit,
  }).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content,
  }))
}

function currentStateContext(scope: AgentScope): string {
  const draft = state.currentDrafts.get(scopeKey(scope)) ?? draftFromStoredExpense(scope)
  if (!draft) return 'Current active split: none.'
  return `Current active split: ${formatSplitSummary(buildSplitSummary(draft))}`
}

function firstNameTokens(value: string): string[] {
  return value
    .replace(/\b(total|bucks?|dollars?|usd|for|split|between|among|and|me|myself)\b/gi, ' ')
    .replace(/\$?\d+(?:\.\d{1,2})?/g, ' ')
    .split(/[,\s]+/)
    .map(cleanName)
    .filter((token) => /^[a-z][a-z.'-]*$/i.test(token))
}

function stripAmountWords(value: string): string {
  return value
    .replace(/\$?\d+(?:\.\d{1,2})?\s*(?:bucks?|dollars?|usd)?/gi, ' ')
    .replace(/\b(total|for|paid|i|split|bill|was)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleFromCasualText(value: string): string {
  const beforeWith = value.split(/\bwith\b/i)[0] ?? value
  const title = stripAmountWords(beforeWith)
    .replace(/^for\s+/i, '')
    .trim()
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : 'Shared expense'
}

function draftFromCasualText(text: string, payerName: string): ExpenseDraft | null {
  const normalized = text.trim()
  const halfMatch = normalized.match(/\b([a-z][a-z.'-]*)\s+needs?\s+to\s+pay\s+me\s+half\s+of\s+\$?(\d+(?:\.\d{1,2})?)/i)
  if (halfMatch) {
    return expenseDraftSchema.parse({
      title: 'Shared expense',
      payerName,
      total: Number(halfMatch[2]),
      people: [payerName, cleanName(halfMatch[1])],
      splitMode: 'equal',
      confidence: 0.78,
    })
  }

  if (!/\bpaid\b/i.test(normalized) || !/\bwith\b/i.test(normalized)) return null

  const amountMatch = normalized.match(/\$?\b(\d+(?:\.\d{1,2})?)\s*(?:bucks?|dollars?|usd)?\b/i)
  if (!amountMatch) return null

  const withPart = normalized.split(/\bwith\b/i).slice(1).join(' with ')
  const people = firstNameTokens(withPart)
  if (people.length === 0) return null

  return expenseDraftSchema.parse({
    title: titleFromCasualText(normalized),
    payerName,
    total: Number(amountMatch[1]),
    people,
    splitMode: 'equal',
    confidence: 0.82,
  })
}

function suggestedReplyFromToolResults(toolResults: Array<{ output: unknown }>): string | null {
  for (const result of [...toolResults].reverse()) {
    const output = result.output
    if (
      typeof output === 'object' &&
      output !== null &&
      'suggestedReply' in output &&
      typeof output.suggestedReply === 'string' &&
      output.suggestedReply.trim()
    ) {
      return enforcePlainTextReply(output.suggestedReply)
    }
  }
  return null
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

  const draft = normalizeAgentDraft(expenseDraftSchema.parse(parseJsonObject(text)))
  rememberDraft(draft)
  return draft
}

export function rememberDraft(draft: ExpenseDraft, scope: AgentScope = {}): void {
  state.currentDrafts.set(scopeKey(scope), draft)
  state.requests.set(scopeKey(scope), [])
  saveExpenseDraft(draft, scopedOwner(scope), scopedConversation(scope))
}

export function draftSplitForAgent(draft: ExpenseDraft, scope?: AgentScope): AgentToolResult<{
  draft: ExpenseDraft
  split: SplitSummary
}> {
  const parsed = normalizeAgentDraft(expenseDraftSchema.parse(draft))
  rememberDraft(parsed, scope)
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

export function reviseCurrentSplitForAgent(revision: SplitRevision, scope: AgentScope = {}): AgentToolResult<{
  draft: ExpenseDraft | null
  split: SplitSummary | null
  revision: SplitRevision
}> {
  const parsedRevision = reviseSplitSchema.parse(revision)
  const current = state.currentDrafts.get(scopeKey(scope)) ?? draftFromStoredExpense(scope)
  const startingPeople = parsedRevision.people
    ?? parsedRevision.addPeople
    ?? []

  if (!current && (!parsedRevision.total || startingPeople.length === 0)) {
    return {
      ok: false,
      action: 'revise_current_split',
      nextAction: 'collect_split_details',
      summary: 'No active split draft to revise.',
      suggestedReply: enforcePlainTextReply('What did you pay, how much was it, and who should split it?'),
      facts: {
        draft: null,
        split: null,
        revision: parsedRevision,
      },
    }
  }

  const base = current ?? expenseDraftSchema.parse({
    title: parsedRevision.title ?? 'Shared expense',
    payerName: parsedRevision.payerName ?? 'Carson',
    total: parsedRevision.total,
    people: startingPeople,
    splitMode: parsedRevision.splitMode ?? 'equal',
    confidence: parsedRevision.confidence ?? 0.7,
  })

  let people = parsedRevision.people ? uniqueNames(parsedRevision.people) : uniqueNames(base.people)
  if (!parsedRevision.people && parsedRevision.addPeople) {
    people = uniqueNames([...people, ...parsedRevision.addPeople])
  }
  if (parsedRevision.removePeople) {
    people = people.filter((name) => !parsedRevision.removePeople!.some((removed) => samePerson(name, removed)))
  }

  const draft = normalizeAgentDraft(expenseDraftSchema.parse({
    ...base,
    title: parsedRevision.title ?? base.title,
    payerName: parsedRevision.payerName ?? base.payerName,
    total: parsedRevision.total ?? base.total,
    people,
    splitMode: parsedRevision.splitMode ?? base.splitMode,
    confidence: parsedRevision.confidence ?? Math.max(base.confidence, 0.82),
  }))
  rememberDraft(draft, scope)
  const split = buildSplitSummary(draft)

  return {
    ok: true,
    action: 'revise_current_split',
    nextAction: split.requestCount > 0 ? 'confirm_send' : 'no_recipients',
    summary: formatSplitSummary(split),
    suggestedReply: enforcePlainTextReply(formatDraft(draft)),
    facts: {
      draft,
      split,
      revision: parsedRevision,
    },
  }
}

export function getCurrentSplitForAgent(scope: AgentScope = {}): AgentToolResult<{
  draft: ExpenseDraft | null
  split: SplitSummary | null
  requests: PaymentRequest[]
}> {
  const draft = state.currentDrafts.get(scopeKey(scope)) ?? draftFromStoredExpense(scope)
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
      requests: getCurrentPaymentRequests(undefined, scope),
    },
  }
}

export function sendPaymentLinksForCurrentSplit(input: {
  baseUrl?: string
  forceVariant?: PaymentRequest['uiVariant']
  ownerUserId?: string
  conversationId?: string
} = {}): AgentToolResult<{
  draft: ExpenseDraft | null
  split: SplitSummary | null
  requests: PaymentRequest[]
}> {
  const scope = { ownerUserId: input.ownerUserId, conversationId: input.conversationId }
  const draft = state.currentDrafts.get(scopeKey(scope)) ?? draftFromStoredExpense(scope)
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

  const existingRequests = getCurrentPaymentRequests(input.baseUrl, scope)
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
    ownerUserId: input.ownerUserId,
    conversationId: input.conversationId,
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
  ownerUserId?: string
  conversationId?: string
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
    ownerUserId: scopedOwner(input),
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
  ownerUserId?: string
  conversationId?: string
}): Promise<string> {
  const payerName = input.payerName ?? 'Carson'
  const scope = {
    ownerUserId: input.ownerUserId,
    conversationId: input.conversationId,
  }
  rememberUserMessage(input.text, scope)

  const existingDraft = state.currentDrafts.get(scopeKey(scope)) ?? draftFromStoredExpense(scope)
  if (existingDraft && isSendConfirmation(input.text)) {
    return rememberAssistantReply(sendPaymentLinksForCurrentSplit({
      baseUrl: input.baseUrl ?? publicBaseUrl(),
      ownerUserId: input.ownerUserId,
      conversationId: input.conversationId,
    }).suggestedReply, scope)
  }

  const wantsLocalTestSend = isLocalTestSend(input.text)
  if (wantsLocalTestSend) {
    const draft = existingDraft
    if (!draft) {
      return rememberAssistantReply('Send me a split first, then say “test send it here.”', scope)
    }

    return rememberAssistantReply(formatTestRequests(createPaymentRequests({
      draft,
      baseUrl: input.baseUrl ?? publicBaseUrl(),
      ownerUserId: input.ownerUserId,
      conversationId: input.conversationId,
    })), scope)
  }

  const directDraft = draftFromCasualText(input.text, payerName)
  if (directDraft) {
    return rememberAssistantReply(draftSplitForAgent(directDraft, scope).suggestedReply, scope)
  }

  const result = await generateText({
    model: model(),
    system: [
      plainTextSystemPrompt,
      currentStateContext(scope),
      `Default payer name: ${payerName}.`,
    ].join('\n\n'),
    stopWhen: stepCountIs(4),
    tools: {
      draft_split: tool({
        description: 'Normalize and store a split draft. Use when the user gives amount plus who shared it, even if title is vague. The tool owns split math, payer handling, and the suggested reply. Examples: "paid 87 dinner with James" -> title Dinner, total 87, payerName Carson, people Carson and James. "James needs to pay half of 87" -> total 87, people Carson and James.',
        inputSchema: expenseDraftSchema.extend({
          payerName: z.string().default(payerName),
        }),
        execute: async (draft) => draftSplitForAgent(expenseDraftSchema.parse(draft), scope),
      }),
      revise_current_split: tool({
        description: 'Revise the active split when the user corrects or completes prior info. Use conversation memory and current split state. Examples: "I meant with James" -> people Carson and James. "add Sam" -> addPeople Sam. "it was lunch" -> title Lunch. "actually 92" -> total 92.',
        inputSchema: reviseSplitSchema,
        execute: async (revision) => reviseCurrentSplitForAgent(revision, scope),
      }),
      send_payment_links_for_current_split: tool({
        description: 'Create or reuse tracked payment links for the active split after the payer confirms with "yes", "send it", or similar. The tool excludes the payer, chooses experiment variants, records events, and returns a suggested reply.',
        inputSchema: z.object({}),
        execute: async () => sendPaymentLinksForCurrentSplit({
          baseUrl: input.baseUrl ?? publicBaseUrl(),
          ownerUserId: input.ownerUserId,
          conversationId: input.conversationId,
        }),
      }),
      get_current_split_summary: tool({
        description: 'Read the active split before answering ambiguous follow-ups such as "?", "what is this", "yes", or corrections that depend on memory. Returns summary, next action, suggested reply, participants, and existing requests.',
        inputSchema: z.object({}),
        execute: async () => getCurrentSplitForAgent(scope),
      }),
      resolve_contact: tool({
        description: 'Look up whether Remy already knows a friend by name or alias.',
        inputSchema: z.object({
          alias: z.string(),
        }),
        execute: async ({ alias }) => {
          const result = resolveContact(alias, scopedOwner(scope))
          return result?.contact ?? { missing: true, alias }
        },
      }),
      save_friend_contact: tool({
        description: 'Save a friend contact only when the user shares contact details or asks for direct iMessage delivery. Do not call this before making shareable payment links; contact cards are optional.',
        inputSchema: z.object({
          displayName: z.string(),
          alias: z.string().optional(),
          phone: z.string().optional(),
          imessageHandle: z.string().optional(),
          preferredPayoutMethod: z.string().optional(),
          payoutHandle: z.string().optional(),
        }),
        execute: async (input) => saveFriendContactForAgent({
          ...input,
          ownerUserId: scopedOwner(scope),
          conversationId: scopedConversation(scope),
        }),
      }),
    },
    messages: modelMessagesForScope(scope),
  })

  const toolReply = suggestedReplyFromToolResults(result.steps.flatMap((step) => step.toolResults))
  const reply = result.text.trim() ? result.text : toolReply
  return rememberAssistantReply(reply ?? 'Got it. What did you pay, how much was it, and who shared it?', scope)
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

function draftFromStoredExpense(scope: AgentScope = {}): ExpenseDraft | null {
  const current = getCurrentExpense(scopedOwner(scope), scopedConversation(scope))
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
  ownerUserId?: string
  conversationId?: string
}): PaymentRequest[] {
  const scope = {
    ownerUserId: input.ownerUserId,
    conversationId: input.conversationId,
  }
  const draft = normalizeAgentDraft(expenseDraftSchema.parse(input.draft))
  const baseUrl = input.baseUrl ?? publicBaseUrl()
  const split = splitDraft(draft)
  const requests = split.requestPeople.map((friendName, index) => {
    const id = randomUUID()
    const uiVariant = input.forceVariant ?? selectPaymentUiVariant(`${draft.title}:${friendName}:${index}`)
    const pay = new URL(`/r/${id}`, baseUrl)
    pay.searchParams.set('friend', friendName.toLowerCase())
    pay.searchParams.set('amount', split.each.toFixed(2))
    pay.searchParams.set('title', draft.title)
    const card = new URL(`/card/${id}.svg`, baseUrl)

    return paymentRequestSchema.parse({
      id,
      uiVariant,
      friendName,
      amount: split.each,
      url: pay.toString(),
      cardUrl: card.toString(),
      message: formatPaymentRequestMessage({
        payerName: draft.payerName,
        title: draft.title,
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

  state.currentDrafts.set(scopeKey(scope), draft)
  state.requests.set(scopeKey(scope), requests)
  const currentExpense = getCurrentExpense(scopedOwner(scope), scopedConversation(scope))
  const currentPeople = currentExpense?.participants.map((participant) => participant.displayName).sort().join('|')
  const draftPeople = [...draft.people].sort().join('|')
  if (
    !currentExpense ||
    currentExpense.expense.title !== draft.title ||
    currentExpense.expense.total !== draft.total ||
    currentPeople !== draftPeople
  ) {
    saveExpenseDraft(draft, scopedOwner(scope), scopedConversation(scope))
  }
  const saved = savePaymentRequestsForCurrent(requests, scopedOwner(scope), scopedConversation(scope))
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

export function getRemyState(scope: AgentScope = {}) {
  const stored = getStoredState(scopedOwner(scope), scopedConversation(scope))
  const currentExpense = getCurrentExpense(scopedOwner(scope), scopedConversation(scope))
  return {
    currentDraft: state.currentDrafts.get(scopeKey(scope)) ?? null,
    requests: state.requests.get(scopeKey(scope)) ?? [],
    stored,
    currentExpense,
    missingContacts: getMissingContactsForCurrent(scopedOwner(scope), scopedConversation(scope)),
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

function getCurrentPaymentRequests(baseUrl?: string, scope: AgentScope = {}): PaymentRequest[] {
  const cached = state.requests.get(scopeKey(scope))
  if (cached && cached.length > 0) return cached

  const stored = getStoredState(scopedOwner(scope), scopedConversation(scope))
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
  state.requests.set(scopeKey(scope), requests)
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
