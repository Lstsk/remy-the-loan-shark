import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  phone: text('phone'),
  preferredPayoutMethod: text('preferred_payout_method'),
  payoutHandle: text('payout_handle'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  displayName: text('display_name').notNull(),
  phone: text('phone'),
  imessageHandle: text('imessage_handle'),
  preferredPayoutMethod: text('preferred_payout_method'),
  payoutHandle: text('payout_handle'),
  source: text('source').notNull().default('manual'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('contacts_owner_phone_idx').on(table.ownerUserId, table.phone),
])

export const contactAliases = sqliteTable('contact_aliases', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  contactId: text('contact_id').notNull().references(() => contacts.id),
  alias: text('alias').notNull(),
  normalizedAlias: text('normalized_alias').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('contact_aliases_owner_alias_idx').on(table.ownerUserId, table.normalizedAlias),
])

export const expenses = sqliteTable('expenses', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  payerName: text('payer_name').notNull(),
  title: text('title').notNull(),
  total: real('total').notNull(),
  splitMode: text('split_mode').notNull(),
  confidence: real('confidence').notNull(),
  status: text('status').notNull().default('draft'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const expenseParticipants = sqliteTable('expense_participants', {
  id: text('id').primaryKey(),
  expenseId: text('expense_id').notNull().references(() => expenses.id),
  contactId: text('contact_id').references(() => contacts.id),
  displayName: text('display_name').notNull(),
  amount: real('amount').notNull(),
  status: text('status').notNull().default('unpaid'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const paymentRequests = sqliteTable('payment_requests', {
  id: text('id').primaryKey(),
  expenseId: text('expense_id').notNull().references(() => expenses.id),
  participantId: text('participant_id').notNull().references(() => expenseParticipants.id),
  contactId: text('contact_id').references(() => contacts.id),
  uiVariant: text('ui_variant').notNull().default('link_preview'),
  friendName: text('friend_name').notNull(),
  amount: real('amount').notNull(),
  url: text('url').notNull(),
  message: text('message').notNull(),
  status: text('status').notNull().default('unpaid'),
  reminderCount: integer('reminder_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const paymentRequestEvents = sqliteTable('payment_request_events', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull().references(() => paymentRequests.id),
  expenseId: text('expense_id').references(() => expenses.id),
  uiVariant: text('ui_variant').notNull(),
  eventType: text('event_type').notNull(),
  userAgent: text('user_agent'),
  referrer: text('referrer'),
  createdAt: text('created_at').notNull(),
})

export const conversationState = sqliteTable('conversation_state', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  currentExpenseId: text('current_expense_id').references(() => expenses.id),
  lastMessage: text('last_message'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('conversation_state_owner_idx').on(table.ownerUserId),
])
