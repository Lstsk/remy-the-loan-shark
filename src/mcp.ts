import { serve } from '@hono/node-server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Resvg } from '@resvg/resvg-js'
import { toFetchResponse, toReqRes } from 'fetch-to-node'
import { Hono } from 'hono'
import { createRequire } from 'node:module'
import { z } from 'zod'
import {
  createPaymentRequests,
  draftSplitForAgent,
  expenseDraftSchema,
  getCurrentSplitForAgent,
  getRemyState,
  reviseCurrentSplitForAgent,
  reviseSplitSchema,
  runRemyAgent,
  saveFriendContactForAgent,
  sendPaymentLinksForCurrentSplit,
} from './tools.ts'
import {
  findPaymentRequest,
  getPaymentUiExperimentSummary,
  recordPaymentRequestEvent,
  resolveContact,
  saveContact,
  updatePaymentRequestStatus,
} from './db/repository.ts'

const require = createRequire(import.meta.url)
const paymentCardFontFiles = [
  '@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf',
  '@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf',
  '@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf',
  '@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf',
  '@expo-google-fonts/inter/800ExtraBold/Inter_800ExtraBold.ttf',
  '@expo-google-fonts/inter/900Black/Inter_900Black.ttf',
].map((fontPath) => require.resolve(fontPath))

const scopeInputSchema = {
  ownerUserId: z.string().optional(),
  conversationId: z.string().optional(),
}

export function createRemyMcpServer(): McpServer {
  const server = new McpServer({
    name: 'remy',
    version: '0.1.0',
  })

  server.registerTool(
    'resolve_contact',
    {
      title: 'Resolve contact',
      description: 'Look up a saved Remy contact by alias/name.',
      inputSchema: {
        alias: z.string(),
        ownerUserId: z.string().optional(),
      },
    },
    async ({ alias, ownerUserId }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(resolveContact(alias, ownerUserId), null, 2),
      }],
    }),
  )

  server.registerTool(
    'save_contact',
    {
      title: 'Save contact',
      description: 'Save a contact mapping from a shared contact card, phone number, or iMessage handle.',
      inputSchema: {
        ...scopeInputSchema,
        displayName: z.string(),
        alias: z.string().optional(),
        phone: z.string().optional(),
        imessageHandle: z.string().optional(),
        preferredPayoutMethod: z.string().optional(),
        payoutHandle: z.string().optional(),
      },
    },
    async (input) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(saveContact({ ...input, source: 'mcp' }), null, 2),
      }],
    }),
  )

  server.registerTool(
    'save_friend_contact',
    {
      title: 'Save friend contact',
      description: 'Agent-facing contact tool. Saves a friend contact only when the user shares details or wants direct delivery.',
      inputSchema: {
        ...scopeInputSchema,
        displayName: z.string(),
        alias: z.string().optional(),
        phone: z.string().optional(),
        imessageHandle: z.string().optional(),
        preferredPayoutMethod: z.string().optional(),
        payoutHandle: z.string().optional(),
      },
    },
    async (input) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(saveFriendContactForAgent(input), null, 2),
      }],
    }),
  )

  server.registerTool(
    'run_remy_agent',
    {
      title: 'Run Remy agent',
      description: 'Let Remy decide naturally whether to chat, ask a follow-up, draft an expense, or create requests.',
      inputSchema: {
        ...scopeInputSchema,
        text: z.string(),
        payerName: z.string().default('Carson'),
        baseUrl: z.string().url().optional(),
      },
    },
    async ({ text, payerName, baseUrl, ownerUserId, conversationId }) => ({
      content: [{
        type: 'text',
        text: await runRemyAgent({ text, payerName, baseUrl, ownerUserId, conversationId }),
      }],
    }),
  )

  server.registerTool(
    'draft_split',
    {
      title: 'Draft split',
      description: 'Agent-facing split tool. Normalizes and stores a split draft, then returns summary, next action, facts, and suggested reply. Example: paid 87 dinner with James -> title Dinner, total 87, payerName Carson, people Carson and James.',
      inputSchema: {
        ...expenseDraftSchema.shape,
        ...scopeInputSchema,
      },
    },
    async (input) => {
      const { ownerUserId, conversationId, ...draft } = input
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(draftSplitForAgent(expenseDraftSchema.parse(draft), { ownerUserId, conversationId }), null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'revise_current_split',
    {
      title: 'Revise current split',
      description: 'Agent-facing revision tool. Use for corrections and follow-ups that rely on the active split. Examples: I meant James -> people Carson and James. Add Sam -> addPeople Sam. Actually 92 -> total 92.',
      inputSchema: {
        ...reviseSplitSchema.shape,
        ...scopeInputSchema,
      },
    },
    async (input) => {
      const { ownerUserId, conversationId, ...revision } = input
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(reviseCurrentSplitForAgent(reviseSplitSchema.parse(revision), { ownerUserId, conversationId }), null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'send_payment_links_for_current_split',
    {
      title: 'Send payment links for current split',
      description: 'Agent-facing send tool. Creates or reuses tracked links for the active split after confirmation, excludes the payer, records events, and returns a suggested reply.',
      inputSchema: {
        ...scopeInputSchema,
        baseUrl: z.string().url().optional(),
        forceVariant: z.enum(['link_preview', 'image_card', 'conversational_minimal']).optional(),
      },
    },
    async ({ baseUrl, forceVariant, ownerUserId, conversationId }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(sendPaymentLinksForCurrentSplit({ baseUrl, forceVariant, ownerUserId, conversationId }), null, 2),
      }],
    }),
  )

  server.registerTool(
    'get_current_split_summary',
    {
      title: 'Get current split summary',
      description: 'Agent-facing state tool. Returns the active split as summary, next action, suggested reply, facts, and existing requests.',
      inputSchema: scopeInputSchema,
    },
    async ({ ownerUserId, conversationId }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(getCurrentSplitForAgent({ ownerUserId, conversationId }), null, 2),
      }],
    }),
  )

  server.registerTool(
    'create_payment_requests',
    {
      title: 'Create payment requests',
      description: 'Create shareable payment request messages from an expense draft.',
      inputSchema: {
        ...scopeInputSchema,
        draft: expenseDraftSchema,
        baseUrl: z.string().url().optional(),
        forceVariant: z.enum(['link_preview', 'image_card', 'conversational_minimal']).optional(),
      },
    },
    async ({ draft, baseUrl, forceVariant, ownerUserId, conversationId }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(createPaymentRequests({ draft, baseUrl, forceVariant, ownerUserId, conversationId }), null, 2),
      }],
    }),
  )

  server.registerTool(
    'get_remy_state',
    {
      title: 'Get Remy state',
      description: 'Read the current in-memory Remy draft and payment requests.',
      inputSchema: scopeInputSchema,
    },
    async ({ ownerUserId, conversationId }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(getRemyState({ ownerUserId, conversationId }), null, 2),
      }],
    }),
  )

  return server
}

export function createMcpApp(): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true, service: 'remy-mcp' }))

  app.get('/experiments/payment-ui', (c) => c.json({
    experiment: 'payment-ui',
    variants: [
      'link_preview',
      'image_card',
      'conversational_minimal',
    ],
    summary: getPaymentUiExperimentSummary(),
  }))

  app.get('/r/:id', (c) => {
    const id = c.req.param('id')
    recordPaymentRequestEvent({
      requestId: id,
      eventType: 'link_clicked',
      userAgent: c.req.header('user-agent'),
      referrer: c.req.header('referer'),
    })

    const target = new URL(`/pay/${encodeURIComponent(id)}`, publicUrlFromRequest(c.req.raw))
    for (const key of ['friend', 'amount', 'title']) {
      const value = c.req.query(key)
      if (value) target.searchParams.set(key, value)
    }
    return c.redirect(target.pathname + target.search)
  })

  app.get('/card/:file', (c) => {
    const file = c.req.param('file')
    const id = file.replace(/\.(svg|png)$/i, '')
    const view = findPaymentRequest({ id })
    if (view) {
      recordPaymentRequestEvent({
        requestId: id,
        eventType: 'card_viewed',
        userAgent: c.req.header('user-agent'),
        referrer: c.req.header('referer'),
      })
    }

    c.header('Cache-Control', 'no-store')
    const svg = renderPaymentCardSvg({
      friendName: view?.request.friendName ?? 'Friend',
      payerName: view?.expense.payerName ?? 'Carson',
      title: view?.expense.title ?? 'Shared expense',
      amount: view?.request.amount ?? 0,
      status: view?.request.status ?? 'unpaid',
      paidCount: view?.participants.filter((participant) => participant.status === 'paid').length ?? 0,
      totalCount: view?.participants.length ?? 1,
    })

    if (file.toLowerCase().endsWith('.png')) {
      return new Response(Buffer.from(renderPaymentCardPng(svg)), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
        },
      })
    }

    c.header('Content-Type', 'image/svg+xml; charset=utf-8')
    return c.body(svg)
  })

  app.get('/pay', (c) => {
    const friend = c.req.query('friend') ?? undefined
    const amount = parseAmount(c.req.query('amount'))
    const title = c.req.query('title') ?? undefined
    const view = findPaymentRequest({ friendName: friend, amount, title })
    const requestId = view?.request.id
    const baseUrl = publicUrlFromRequest(c.req.raw)

    return c.html(renderPaymentSheet({
      requestId,
      friendName: view?.request.friendName ?? titleCase(friend ?? 'friend'),
      payerName: view?.expense.payerName ?? 'Carson',
      title: view?.expense.title ?? title ?? 'Expense',
      amount: view?.request.amount ?? amount ?? 0,
      status: view?.request.status ?? 'unpaid',
      splitTotal: view?.expense.total,
      participants: view?.participants.map((participant) => ({
        name: participant.displayName,
        amount: participant.amount,
        status: participant.status,
      })) ?? [],
      message: view?.request.message,
      cardUrl: requestId ? new URL(`/card/${requestId}.png`, baseUrl).toString() : undefined,
      canonicalUrl: requestId ? new URL(`/pay/${requestId}`, baseUrl).toString() : new URL(c.req.raw.url).toString(),
    }))
  })

  app.get('/pay/:id', (c) => {
    const id = c.req.param('id')
    const friend = c.req.query('friend') ?? undefined
    const amount = parseAmount(c.req.query('amount'))
    const title = c.req.query('title') ?? undefined
    const view = findPaymentRequest({ id }) ?? findPaymentRequest({ friendName: friend, amount, title })
    const requestId = view?.request.id ?? id
    const baseUrl = publicUrlFromRequest(c.req.raw)
    if (view?.request.id) {
      recordPaymentRequestEvent({
        requestId: view.request.id,
        eventType: 'payment_sheet_opened',
        userAgent: c.req.header('user-agent'),
        referrer: c.req.header('referer'),
      })
    }

    return c.html(renderPaymentSheet({
      requestId,
      friendName: view?.request.friendName ?? titleCase(friend ?? 'friend'),
      payerName: view?.expense.payerName ?? 'Carson',
      title: view?.expense.title ?? title ?? 'Expense',
      amount: view?.request.amount ?? amount ?? 0,
      status: view?.request.status ?? 'unpaid',
      splitTotal: view?.expense.total,
      participants: view?.participants.map((participant) => ({
        name: participant.displayName,
        amount: participant.amount,
        status: participant.status,
      })) ?? [],
      message: view?.request.message,
      cardUrl: new URL(`/card/${requestId}.png`, baseUrl).toString(),
      canonicalUrl: new URL(`/pay/${requestId}`, baseUrl).toString(),
    }))
  })

  app.post('/pay/paid', async (c) => {
    const body = await c.req.parseBody()
    const id = String(body.requestId ?? '')
    const friendName = String(body.friendName ?? '')
    const amount = parseAmount(String(body.amount ?? ''))
    const view = updatePaymentRequestStatus({ id: id || undefined, friendName, amount, status: 'paid' })
    if (view?.request.id) {
      recordPaymentRequestEvent({ requestId: view.request.id, eventType: 'marked_paid' })
    }
    if (!view) return c.redirect(id ? `/pay/${encodeURIComponent(id)}?paid=1` : `/pay?friend=${encodeURIComponent(friendName)}&amount=${amount ?? ''}&paid=1`)
    return c.redirect(`/pay/${encodeURIComponent(view.request.id)}?paid=1`)
  })

  app.post('/pay/dispute', async (c) => {
    const body = await c.req.parseBody()
    const id = String(body.requestId ?? '')
    const friendName = String(body.friendName ?? '')
    const amount = parseAmount(String(body.amount ?? ''))
    const view = updatePaymentRequestStatus({ id: id || undefined, friendName, amount, status: 'disputed' })
    if (view?.request.id) {
      recordPaymentRequestEvent({ requestId: view.request.id, eventType: 'disputed' })
    }
    if (!view) return c.redirect(id ? `/pay/${encodeURIComponent(id)}?disputed=1` : `/pay?friend=${encodeURIComponent(friendName)}&amount=${amount ?? ''}&disputed=1`)
    return c.redirect(`/pay/${encodeURIComponent(view.request.id)}?disputed=1`)
  })

  app.post('/mcp', async (c) => {
    const server = createRemyMcpServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    try {
      await server.connect(transport)
      const body = await c.req.raw.clone().json().catch(() => undefined)
      const { req, res } = toReqRes(c.req.raw)

      res.on('close', () => {
        transport.close()
        server.close()
      })

      await transport.handleRequest(req, res, body)
      return toFetchResponse(res)
    } catch (error) {
      console.error(error)
      transport.close()
      server.close()
      return c.json({ error: 'MCP request failed' }, 500)
    }
  })

  return app
}

function parseAmount(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function publicUrlFromRequest(request: Request): string {
  const url = new URL(request.url)
  return `${url.protocol}//${url.host}`
}

function escapeHtml(value: string | number | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

type PaymentCardTemplate = 'liquid_glass' | 'dinner_editorial' | 'premium_wallet'

function renderPaymentCardSvg(input: {
  friendName: string
  payerName: string
  title: string
  amount: number
  status: string
  paidCount: number
  totalCount: number
}): string {
  const template = selectPaymentCardTemplate(input)
  const statusLabel = input.status === 'paid'
    ? 'Paid'
    : input.status === 'disputed'
      ? 'Needs review'
      : 'Ready to pay'
  const statusFill = input.status === 'paid'
    ? '#1f9d61'
    : input.status === 'disputed'
      ? '#b9680f'
      : '#007aff'
  const statusText = `${input.paidCount} of ${input.totalCount} paid`

  const title = escapeHtml(compactCardText(input.title, 26))
  const payerName = escapeHtml(compactCardText(input.payerName, 22))
  const friendName = escapeHtml(compactCardText(input.friendName, 22))
  const amount = `$${input.amount.toFixed(2)}`
  const paidFor = `${payerName} paid for ${title}`
  const font = 'font-family="Inter, Arial, sans-serif"'

  if (template === 'dinner_editorial') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720" role="img" aria-label="Remy payment card">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#f8f1e6"/>
      <stop offset="0.58" stop-color="#fffaf3"/>
      <stop offset="1" stop-color="#e9f4f0"/>
    </linearGradient>
    <linearGradient id="paper" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#fffdf8"/>
      <stop offset="1" stop-color="#f7efe2"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#1769ff"/>
      <stop offset="1" stop-color="#16a085"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="28" stdDeviation="34" flood-color="#3f2f1f" flood-opacity="0.18"/>
    </filter>
  </defs>
  <rect width="1200" height="720" fill="url(#bg)"/>
  <circle cx="986" cy="130" r="148" fill="#d8c0a0" opacity="0.17"/>
  <circle cx="1000" cy="566" r="210" fill="#d7eee8" opacity="0.55"/>
  <rect x="96" y="74" width="1008" height="572" rx="58" fill="url(#paper)" stroke="#ffffff" stroke-width="3" filter="url(#shadow)"/>
  <rect x="146" y="122" width="86" height="86" rx="26" fill="#151316"/>
  <text x="189" y="179" text-anchor="middle" fill="#fffdf7" ${font} font-size="42" font-weight="850">R</text>
  <text x="262" y="158" fill="#8d7660" ${font} font-size="23" font-weight="760">Remy Dinner</text>
  <text x="262" y="204" fill="#211b17" ${font} font-size="38" font-weight="820">${friendName}</text>
  <rect x="852" y="130" width="182" height="54" rx="27" fill="${statusFill}" fill-opacity="0.13"/>
  <text x="943" y="166" text-anchor="middle" fill="${statusFill}" ${font} font-size="22" font-weight="820">${escapeHtml(statusLabel)}</text>

  <text x="150" y="360" fill="#181514" ${font} font-size="126" font-weight="900">${amount}</text>
  <text x="156" y="424" fill="#6e5d4d" ${font} font-size="31" font-weight="600">${paidFor}</text>
  <line x1="154" y1="496" x2="620" y2="496" stroke="#dfd1bd" stroke-width="3"/>
  <text x="154" y="552" fill="#2a211d" ${font} font-size="29" font-weight="780">Payment card ready</text>
  <text x="154" y="592" fill="#806d5b" ${font} font-size="23" font-weight="560">A clean link for settling up after the meal.</text>

  <rect x="738" y="282" width="306" height="206" rx="36" fill="#ffffff" fill-opacity="0.72" stroke="#ffffff"/>
  <text x="776" y="336" fill="#8d7660" ${font} font-size="22" font-weight="760">split status</text>
  <text x="776" y="384" fill="#211b17" ${font} font-size="40" font-weight="850">${escapeHtml(statusText)}</text>
  <rect x="776" y="418" width="224" height="16" rx="8" fill="#e7ddd0"/>
  <rect x="776" y="418" width="${progressWidth(input)}" height="16" rx="8" fill="url(#accent)"/>
  <rect x="776" y="462" width="170" height="40" rx="20" fill="#1769ff" fill-opacity="0.12"/>
  <text x="861" y="489" text-anchor="middle" fill="#1769ff" ${font} font-size="20" font-weight="820">tap to pay</text>
  <text x="1038" y="596" text-anchor="end" fill="#9b8a78" ${font} font-size="22" font-weight="700">trymomento.app</text>
</svg>`
  }

  if (template === 'premium_wallet') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720" role="img" aria-label="Remy payment card">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#06151d"/>
      <stop offset="0.48" stop-color="#0d2733"/>
      <stop offset="1" stop-color="#103f3a"/>
    </linearGradient>
    <linearGradient id="card" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#182d37"/>
      <stop offset="0.58" stop-color="#0e202a"/>
      <stop offset="1" stop-color="#0b171f"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#2d8cff"/>
      <stop offset="1" stop-color="#22d3a6"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="34" stdDeviation="40" flood-color="#000000" flood-opacity="0.32"/>
    </filter>
  </defs>
  <rect width="1200" height="720" fill="url(#bg)"/>
  <circle cx="1040" cy="126" r="220" fill="#22d3a6" opacity="0.13"/>
  <circle cx="164" cy="612" r="280" fill="#2d8cff" opacity="0.11"/>
  <rect x="96" y="76" width="1008" height="568" rx="58" fill="url(#card)" stroke="#33515c" filter="url(#shadow)"/>
  <rect x="146" y="126" width="88" height="88" rx="28" fill="#f6fbff"/>
  <text x="190" y="184" text-anchor="middle" fill="#0a171f" ${font} font-size="42" font-weight="900">R</text>
  <text x="264" y="160" fill="#99b5bf" ${font} font-size="23" font-weight="760">Remy Wallet</text>
  <text x="264" y="207" fill="#ffffff" ${font} font-size="39" font-weight="850">${friendName}</text>
  <rect x="842" y="132" width="196" height="56" rx="28" fill="#22d3a6" fill-opacity="0.14"/>
  <text x="940" y="169" text-anchor="middle" fill="#7ef5d0" ${font} font-size="22" font-weight="820">${escapeHtml(statusLabel)}</text>

  <text x="150" y="366" fill="#ffffff" ${font} font-size="126" font-weight="900">${amount}</text>
  <text x="156" y="430" fill="#a9c1ca" ${font} font-size="31" font-weight="600">${paidFor}</text>
  <rect x="154" y="504" width="286" height="54" rx="27" fill="url(#accent)"/>
  <text x="297" y="540" text-anchor="middle" fill="#ffffff" ${font} font-size="22" font-weight="850">secure pay link</text>
  <text x="156" y="600" fill="#7e9ba6" ${font} font-size="23" font-weight="580">Built for bigger balances and recurring shares.</text>

  <rect x="730" y="270" width="316" height="226" rx="38" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.12"/>
  <text x="770" y="328" fill="#89a6b0" ${font} font-size="22" font-weight="760">split status</text>
  <text x="770" y="378" fill="#ffffff" ${font} font-size="40" font-weight="850">${escapeHtml(statusText)}</text>
  <rect x="770" y="414" width="224" height="16" rx="8" fill="#29424c"/>
  <rect x="770" y="414" width="${progressWidth(input)}" height="16" rx="8" fill="url(#accent)"/>
  <text x="1038" y="596" text-anchor="end" fill="#77949d" ${font} font-size="22" font-weight="720">trymomento.app</text>
</svg>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720" role="img" aria-label="Remy payment card">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#f7fbff"/>
      <stop offset="0.48" stop-color="#edf7f5"/>
      <stop offset="1" stop-color="#fbf4e8"/>
    </linearGradient>
    <linearGradient id="card" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.96"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.58"/>
    </linearGradient>
    <linearGradient id="pay" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#007aff"/>
      <stop offset="1" stop-color="#10b981"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="30" stdDeviation="36" flood-color="#15151a" flood-opacity="0.18"/>
    </filter>
    <filter id="glassBlur" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="0.4"/>
    </filter>
  </defs>
  <rect width="1200" height="720" fill="url(#bg)"/>
  <circle cx="1010" cy="92" r="220" fill="#9bd8ff" opacity="0.18"/>
  <circle cx="1020" cy="642" r="270" fill="#e7d2a9" opacity="0.18"/>
  <rect x="104" y="78" width="992" height="564" rx="54" fill="url(#card)" stroke="#ffffff" stroke-width="2" filter="url(#shadow)"/>
  <rect x="124" y="98" width="952" height="524" rx="44" fill="#ffffff" opacity="0.18" filter="url(#glassBlur)"/>
  <rect x="150" y="126" width="84" height="84" rx="24" fill="#111115"/>
  <text x="192" y="182" text-anchor="middle" fill="#ffffff" ${font} font-size="42" font-weight="850">R</text>
  <text x="260" y="164" fill="#6d6d75" ${font} font-size="24" font-weight="760">Remy Split</text>
  <text x="260" y="206" fill="#15151a" ${font} font-size="36" font-weight="820">${friendName}</text>
  <rect x="852" y="136" width="178" height="52" rx="26" fill="${statusFill}" fill-opacity="0.12"/>
  <text x="941" y="171" text-anchor="middle" fill="${statusFill}" ${font} font-size="22" font-weight="820">${escapeHtml(statusLabel)}</text>

  <text x="150" y="360" fill="#111115" ${font} font-size="124" font-weight="900">${amount}</text>
  <text x="156" y="420" fill="#5f6068" ${font} font-size="31" font-weight="600">${paidFor}</text>

  <rect x="730" y="260" width="300" height="222" rx="34" fill="#ffffff" fill-opacity="0.76" stroke="#ffffff"/>
  <text x="768" y="316" fill="#6d6d75" ${font} font-size="22" font-weight="760">split status</text>
  <text x="768" y="364" fill="#111115" ${font} font-size="42" font-weight="850">${escapeHtml(statusText)}</text>
  <rect x="768" y="398" width="224" height="16" rx="8" fill="#e5e5ea"/>
  <rect x="768" y="398" width="${progressWidth(input)}" height="16" rx="8" fill="url(#pay)"/>
  <rect x="768" y="438" width="170" height="38" rx="19" fill="#007aff" fill-opacity="0.12"/>
  <text x="853" y="464" text-anchor="middle" fill="#007aff" ${font} font-size="20" font-weight="820">tap to pay</text>

  <line x1="150" y1="500" x2="674" y2="500" stroke="#e1e1e7" stroke-width="2"/>
  <text x="150" y="558" fill="#15151a" ${font} font-size="28" font-weight="780">Payment card ready</text>
  <text x="150" y="598" fill="#6d6d75" ${font} font-size="23" font-weight="560">Open to pay, mark paid, or ask for a review.</text>
  <text x="1032" y="598" text-anchor="end" fill="#8b8b94" ${font} font-size="23" font-weight="700">trymomento.app</text>
</svg>`
}

function compactCardText(value: string, maxLength: number): string {
  const trimmed = value.trim()
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed
}

function progressWidth(input: { paidCount: number; totalCount: number }): number {
  return Math.max(24, Math.min(224, 224 * input.paidCount / Math.max(input.totalCount, 1)))
}

function selectPaymentCardTemplate(input: { title: string; amount: number }): PaymentCardTemplate {
  const title = input.title.toLowerCase()
  if (/\b(dinner|lunch|brunch|drink|drinks|bar|restaurant|meal|coffee|pizza|taco|sushi)\b/.test(title)) {
    return 'dinner_editorial'
  }
  if (input.amount >= 100 || /\b(rent|utility|utilities|travel|trip|hotel|flight|ticket|deposit)\b/.test(title)) {
    return 'premium_wallet'
  }
  return 'liquid_glass'
}

function renderPaymentCardPng(svg: string): Uint8Array {
  return new Resvg(svg, {
    font: {
      fontFiles: paymentCardFontFiles,
      loadSystemFonts: false,
      defaultFontFamily: 'Inter',
      sansSerifFamily: 'Inter',
    },
    fitTo: {
      mode: 'width',
      value: 1200,
    },
  }).render().asPng()
}

function renderPaymentSheet(input: {
  requestId?: string
  friendName: string
  payerName: string
  title: string
  amount: number
  status: string
  splitTotal?: number
  participants: Array<{ name: string; amount: number; status: string }>
  message?: string
  cardUrl?: string
  canonicalUrl?: string
}): string {
  const statusLabel = input.status === 'paid'
    ? 'Paid'
    : input.status === 'disputed'
      ? 'Needs review'
      : 'Unpaid'
  const statusClass = input.status === 'paid'
    ? 'paid'
    : input.status === 'disputed'
      ? 'disputed'
      : 'unpaid'
  const venmoUrl = `venmo://paycharge?txn=pay&recipients=${encodeURIComponent(input.payerName)}&amount=${input.amount.toFixed(2)}&note=${encodeURIComponent(`${input.title} via Remy`)}`
  const cashUrl = `https://cash.app/$${encodeURIComponent(input.payerName.toLowerCase().replace(/\s+/g, ''))}/${input.amount.toFixed(2)}`
  const paypalUrl = `https://www.paypal.com/paypalme/${encodeURIComponent(input.payerName.replace(/\s+/g, ''))}/${input.amount.toFixed(2)}`
  const participants = input.participants.length > 0
    ? input.participants
    : [{ name: input.friendName, amount: input.amount, status: input.status }]
  const imageMeta = input.cardUrl
    ? `<meta property="og:image" content="${escapeHtml(input.cardUrl)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${escapeHtml(input.cardUrl)}">`
    : ''
  const canonicalMeta = input.canonicalUrl
    ? `<meta property="og:url" content="${escapeHtml(input.canonicalUrl)}">
  <link rel="canonical" href="${escapeHtml(input.canonicalUrl)}">`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f5f5f7">
  ${canonicalMeta}
  <meta property="og:title" content="${escapeHtml(input.friendName)} owes $${input.amount.toFixed(2)}">
  <meta property="og:description" content="${escapeHtml(input.payerName)} paid for ${escapeHtml(input.title)}. Powered by Remy.">
  ${imageMeta}
  <title>Remy · ${escapeHtml(input.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #101014;
      --muted: #6d6d75;
      --line: rgba(10, 10, 20, 0.10);
      --panel: rgba(255, 255, 255, 0.82);
      --wash: #f4f4f6;
      --blue: #007aff;
      --green: #19a765;
      --orange: #c97b15;
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.78), rgba(240, 247, 244, 0.76) 46%, rgba(246, 241, 233, 0.82)),
        linear-gradient(180deg, #fbfbfd 0%, #eeeeF2 100%);
      color: var(--ink);
      letter-spacing: 0;
    }
    .phone {
      min-height: 100svh;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      padding: max(16px, env(safe-area-inset-top)) 12px max(12px, env(safe-area-inset-bottom));
    }
    .sheet {
      width: min(430px, 100%);
      border: 1px solid rgba(255,255,255,0.72);
      border-radius: 28px;
      background: var(--panel);
      box-shadow: 0 24px 70px rgba(0,0,0,0.20);
      backdrop-filter: blur(28px) saturate(1.25);
      -webkit-backdrop-filter: blur(28px) saturate(1.25);
      overflow: hidden;
      transform-origin: bottom center;
      animation: rise 360ms cubic-bezier(.2,.9,.2,1);
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(24px) scale(.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .grabber {
      width: 42px;
      height: 5px;
      border-radius: 99px;
      background: rgba(60,60,67,.26);
      margin: 10px auto 6px;
    }
    .hero {
      padding: 14px 20px 18px;
      text-align: center;
      border-bottom: 1px solid var(--line);
    }
    .appmark {
      width: 56px;
      height: 56px;
      margin: 0 auto 10px;
      border-radius: 18px;
      display: grid;
      place-items: center;
      background: linear-gradient(145deg, #111115, #3b3b44);
      color: white;
      font-size: 28px;
      font-weight: 800;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.22), 0 10px 24px rgba(0,0,0,.22);
    }
    .eyebrow {
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
      margin-bottom: 8px;
    }
    h1 {
      margin: 0;
      font-size: 52px;
      line-height: 1;
      letter-spacing: 0;
      font-weight: 760;
    }
    .subtitle {
      margin: 10px auto 0;
      max-width: 320px;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.28;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 14px;
      border-radius: 999px;
      padding: 7px 11px;
      font-size: 13px;
      font-weight: 720;
      background: rgba(118,118,128,.12);
    }
    .status.paid { color: var(--green); background: rgba(25,167,101,.12); }
    .status.disputed { color: var(--orange); background: rgba(201,123,21,.13); }
    .status.unpaid { color: var(--blue); background: rgba(0,122,255,.12); }
    .content { padding: 14px; }
    .widget {
      margin: 14px;
      padding: 16px;
      border: 1px solid rgba(255,255,255,.72);
      border-radius: 24px;
      background:
        linear-gradient(145deg, rgba(255,255,255,.88), rgba(255,255,255,.58)),
        rgba(255,255,255,.58);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.92), 0 18px 44px rgba(15,15,20,.10);
    }
    .widget-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 720;
      margin-bottom: 14px;
    }
    .pill {
      color: var(--blue);
      border-radius: 999px;
      padding: 6px 9px;
      background: rgba(0,122,255,.10);
    }
    .widget-main {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
    }
    .widget-amount {
      color: var(--ink);
      font-size: 42px;
      line-height: .95;
      font-weight: 780;
    }
    .widget-copy {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.25;
      text-align: right;
      max-width: 156px;
    }
    .section {
      background: rgba(255,255,255,.64);
      border: 1px solid var(--line);
      border-radius: 18px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-height: 52px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }
    .row:last-child { border-bottom: 0; }
    .label { color: var(--muted); font-size: 14px; }
    .value { font-size: 16px; font-weight: 680; text-align: right; }
    .split-name { font-weight: 650; }
    .split-status { color: var(--muted); font-size: 13px; text-transform: capitalize; }
    .actions {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      margin-top: 14px;
    }
    .paygrid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 10px;
    }
    a, button {
      min-height: 52px;
      border-radius: 16px;
      border: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 14px;
      font: inherit;
      font-weight: 760;
      text-decoration: none;
      cursor: pointer;
      white-space: nowrap;
    }
    .primary {
      color: white;
      background: var(--blue);
      box-shadow: 0 10px 22px rgba(0,122,255,.25);
    }
    .option { color: var(--ink); background: rgba(118,118,128,.13); }
    .quiet { color: var(--blue); background: rgba(0,122,255,.10); width: 100%; }
    .danger { color: #b42318; background: rgba(180,35,24,.09); width: 100%; }
    .footer {
      padding: 2px 18px 18px;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }
    @media (max-width: 360px) {
      h1 { font-size: 44px; }
      .widget-main { align-items: start; flex-direction: column; }
      .widget-copy { text-align: left; max-width: none; }
      .paygrid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="phone">
    <section class="sheet" aria-label="Remy payment request">
      <div class="grabber"></div>
      <header class="hero">
        <div class="appmark">R</div>
        <div class="eyebrow">${escapeHtml(input.payerName)} paid for ${escapeHtml(input.title)}</div>
        <h1>$${input.amount.toFixed(2)}</h1>
        <p class="subtitle">${escapeHtml(input.friendName)}, this is your split. Receipt proof and everyone’s status stay visible here.</p>
        <div class="status ${statusClass}">${statusLabel}</div>
      </header>

      <section class="widget" aria-label="Payment widget preview">
        <div class="widget-top">
          <span>Remy Split</span>
          <span class="pill">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="widget-main">
          <div class="widget-amount">$${input.amount.toFixed(2)}</div>
          <div class="widget-copy">${escapeHtml(input.friendName)} owes for ${escapeHtml(input.title)}.</div>
        </div>
      </section>

      <div class="content">
        <section class="section">
          <div class="row">
            <span class="label">Total</span>
            <span class="value">${input.splitTotal ? `$${input.splitTotal.toFixed(2)}` : 'Shared split'}</span>
          </div>
          <div class="row">
            <span class="label">Paid by</span>
            <span class="value">${escapeHtml(input.payerName)}</span>
          </div>
          <div class="row">
            <span class="label">Proof</span>
            <span class="value">Receipt pending</span>
          </div>
        </section>

        <section class="section">
          ${participants.map((participant) => `
          <div class="row">
            <div>
              <div class="split-name">${escapeHtml(participant.name)}</div>
              <div class="split-status">${escapeHtml(participant.status.replaceAll('_', ' '))}</div>
            </div>
            <span class="value">$${participant.amount.toFixed(2)}</span>
          </div>`).join('')}
        </section>

        <div class="paygrid">
          <a class="primary" href="${escapeHtml(venmoUrl)}">Venmo</a>
          <a class="option" href="${escapeHtml(cashUrl)}">Cash App</a>
          <a class="option" href="${escapeHtml(paypalUrl)}">PayPal</a>
        </div>

        <form class="actions" method="post" action="/pay/paid">
          <input type="hidden" name="requestId" value="${escapeHtml(input.requestId ?? '')}">
          <input type="hidden" name="friendName" value="${escapeHtml(input.friendName)}">
          <input type="hidden" name="amount" value="${input.amount.toFixed(2)}">
          <button class="quiet" type="submit">I paid</button>
        </form>
        <form class="actions" method="post" action="/pay/dispute">
          <input type="hidden" name="requestId" value="${escapeHtml(input.requestId ?? '')}">
          <input type="hidden" name="friendName" value="${escapeHtml(input.friendName)}">
          <input type="hidden" name="amount" value="${input.amount.toFixed(2)}">
          <button class="danger" type="submit">This amount is wrong</button>
        </form>
      </div>
      <footer class="footer">powered by Remy · get paid back without asking twice</footer>
    </section>
  </main>
</body>
</html>`
}

export function startMcpServer() {
  const port = Number(process.env.PORT ?? 8787)
  const hostname = process.env.HOST ?? '0.0.0.0'
  const app = createMcpApp()

  return serve({
    fetch: app.fetch,
    hostname,
    port,
  }, () => {
    console.log(`Remy MCP server listening at http://${hostname}:${port}/mcp`)
  })
}

if (process.argv[1] === import.meta.filename) {
  startMcpServer()
}
