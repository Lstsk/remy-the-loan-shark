import { and, eq, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db, ensureDatabase } from './index.ts'
import {
  contactAliases,
  contacts,
  conversationState,
  expenseParticipants,
  expenses,
  paymentRequests,
  users,
} from './schema.ts'
import type { ExpenseDraft, PaymentRequest } from '../tools.ts'

export const defaultOwnerUserId = 'local-payer'

export interface ContactInput {
  ownerUserId?: string
  displayName: string
  alias?: string
  phone?: string
  imessageHandle?: string
  preferredPayoutMethod?: string
  payoutHandle?: string
  source?: string
}

export interface SavedExpense {
  expense: typeof expenses.$inferSelect
  participants: Array<typeof expenseParticipants.$inferSelect>
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function ensureDefaultUser(displayName = 'Carson'): typeof users.$inferSelect {
  ensureDatabase()
  const existing = db.select().from(users).where(eq(users.id, defaultOwnerUserId)).get()
  if (existing) return existing

  const timestamp = nowIso()
  const user = {
    id: defaultOwnerUserId,
    displayName,
    phone: null,
    preferredPayoutMethod: null,
    payoutHandle: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  db.insert(users).values(user).run()
  return user
}

export function saveContact(input: ContactInput): typeof contacts.$inferSelect {
  ensureDefaultUser()
  const timestamp = nowIso()
  const ownerUserId = input.ownerUserId ?? defaultOwnerUserId
  const alias = input.alias ?? input.displayName
  const normalizedAlias = normalizeAlias(alias)

  const existingAlias = db
    .select({ contact: contacts })
    .from(contactAliases)
    .innerJoin(contacts, eq(contactAliases.contactId, contacts.id))
    .where(and(
      eq(contactAliases.ownerUserId, ownerUserId),
      eq(contactAliases.normalizedAlias, normalizedAlias),
    ))
    .get()

  if (existingAlias) {
    db.update(contacts)
      .set({
        displayName: input.displayName,
        phone: input.phone ?? existingAlias.contact.phone,
        imessageHandle: input.imessageHandle ?? existingAlias.contact.imessageHandle,
        preferredPayoutMethod: input.preferredPayoutMethod ?? existingAlias.contact.preferredPayoutMethod,
        payoutHandle: input.payoutHandle ?? existingAlias.contact.payoutHandle,
        source: input.source ?? existingAlias.contact.source,
        updatedAt: timestamp,
      })
      .where(eq(contacts.id, existingAlias.contact.id))
      .run()
    linkContactToOpenParticipants(existingAlias.contact.id, alias, ownerUserId)
    return db.select().from(contacts).where(eq(contacts.id, existingAlias.contact.id)).get()!
  }

  const contact = {
    id: randomUUID(),
    ownerUserId,
    displayName: input.displayName,
    phone: input.phone ?? null,
    imessageHandle: input.imessageHandle ?? input.phone ?? null,
    preferredPayoutMethod: input.preferredPayoutMethod ?? null,
    payoutHandle: input.payoutHandle ?? null,
    source: input.source ?? 'manual',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  db.insert(contacts).values(contact).run()
  db.insert(contactAliases).values({
    id: randomUUID(),
    ownerUserId,
    contactId: contact.id,
    alias,
    normalizedAlias,
    createdAt: timestamp,
  }).run()

  if (normalizeAlias(input.displayName) !== normalizedAlias) {
    db.insert(contactAliases).values({
      id: randomUUID(),
      ownerUserId,
      contactId: contact.id,
      alias: input.displayName,
      normalizedAlias: normalizeAlias(input.displayName),
      createdAt: timestamp,
    }).onConflictDoNothing().run()
  }

  linkContactToOpenParticipants(contact.id, alias, ownerUserId)
  linkContactToOpenParticipants(contact.id, input.displayName, ownerUserId)
  return contact
}

export function resolveContact(alias: string, ownerUserId = defaultOwnerUserId) {
  ensureDefaultUser()
  return db
    .select({ contact: contacts, alias: contactAliases })
    .from(contactAliases)
    .innerJoin(contacts, eq(contactAliases.contactId, contacts.id))
    .where(and(
      eq(contactAliases.ownerUserId, ownerUserId),
      eq(contactAliases.normalizedAlias, normalizeAlias(alias)),
    ))
    .get() ?? null
}

export function saveExpenseDraft(draft: ExpenseDraft, ownerUserId = defaultOwnerUserId): SavedExpense {
  ensureDefaultUser(draft.payerName)
  const timestamp = nowIso()
  const expense = {
    id: randomUUID(),
    ownerUserId,
    payerName: draft.payerName,
    title: draft.title,
    total: draft.total,
    splitMode: draft.splitMode,
    confidence: draft.confidence,
    status: 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  db.insert(expenses).values(expense).run()

  const each = Math.round((draft.total / draft.people.length) * 100) / 100
  const participants = draft.people.map((displayName, index) => {
    const resolved = resolveContact(displayName, ownerUserId)
    return {
      id: randomUUID(),
      expenseId: expense.id,
      contactId: resolved?.contact.id ?? null,
      displayName,
      amount: index === draft.people.length - 1
        ? Math.round((draft.total - each * (draft.people.length - 1)) * 100) / 100
        : each,
      status: 'unpaid',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  })

  if (participants.length > 0) {
    db.insert(expenseParticipants).values(participants).run()
  }

  db.insert(conversationState).values({
    id: randomUUID(),
    ownerUserId,
    currentExpenseId: expense.id,
    lastMessage: null,
    updatedAt: timestamp,
  }).onConflictDoUpdate({
    target: conversationState.ownerUserId,
    set: {
      currentExpenseId: expense.id,
      updatedAt: timestamp,
    },
  }).run()

  return { expense, participants }
}

export function getCurrentExpense(ownerUserId = defaultOwnerUserId): SavedExpense | null {
  ensureDefaultUser()
  const current = db
    .select()
    .from(conversationState)
    .where(eq(conversationState.ownerUserId, ownerUserId))
    .get()
  if (!current?.currentExpenseId) return null

  const expense = db.select().from(expenses).where(eq(expenses.id, current.currentExpenseId)).get()
  if (!expense) return null

  const participants = db
    .select()
    .from(expenseParticipants)
    .where(eq(expenseParticipants.expenseId, expense.id))
    .all()

  return { expense, participants }
}

export function getMissingContactsForCurrent(ownerUserId = defaultOwnerUserId): string[] {
  const current = getCurrentExpense(ownerUserId)
  if (!current) return []

  return current.participants
    .filter((participant) => !participant.contactId)
    .map((participant) => participant.displayName)
}

function linkContactToOpenParticipants(contactId: string, alias: string, ownerUserId = defaultOwnerUserId): void {
  const current = getCurrentExpense(ownerUserId)
  if (!current) return

  db.update(expenseParticipants)
    .set({
      contactId,
      updatedAt: nowIso(),
    })
    .where(and(
      eq(expenseParticipants.expenseId, current.expense.id),
      eq(expenseParticipants.displayName, alias),
      isNull(expenseParticipants.contactId),
    ))
    .run()
}

export function savePaymentRequestsForCurrent(requests: PaymentRequest[], ownerUserId = defaultOwnerUserId) {
  const current = getCurrentExpense(ownerUserId)
  if (!current) throw new Error('No current expense')

  const timestamp = nowIso()
  const values = requests.map((request) => {
    const participant = current.participants.find((candidate) => (
      normalizeAlias(candidate.displayName) === normalizeAlias(request.friendName)
    ))
    if (!participant) {
      throw new Error(`No participant found for ${request.friendName}`)
    }

    return {
      id: randomUUID(),
      expenseId: current.expense.id,
      participantId: participant.id,
      contactId: participant.contactId,
      friendName: request.friendName,
      amount: request.amount,
      url: request.url,
      message: request.message,
      status: 'unpaid',
      reminderCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  })

  if (values.length > 0) {
    db.insert(paymentRequests).values(values).run()
    db.update(expenses)
      .set({ status: 'sent', updatedAt: timestamp })
      .where(eq(expenses.id, current.expense.id))
      .run()
  }

  return values
}

export function getStoredState(ownerUserId = defaultOwnerUserId) {
  ensureDefaultUser()
  const current = getCurrentExpense(ownerUserId)
  const requests = current
    ? db.select().from(paymentRequests).where(eq(paymentRequests.expenseId, current.expense.id)).all()
    : []

  return {
    currentExpense: current,
    requests,
  }
}
