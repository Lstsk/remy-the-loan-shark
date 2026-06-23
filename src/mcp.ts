import { serve } from '@hono/node-server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { toFetchResponse, toReqRes } from 'fetch-to-node'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  createPaymentRequests,
  expenseDraftSchema,
  getRemyState,
  runRemyAgent,
  understandExpenseMessage,
} from './tools.ts'
import { findPaymentRequest, resolveContact, saveContact, updatePaymentRequestStatus } from './db/repository.ts'

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
      },
    },
    async ({ alias }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(resolveContact(alias), null, 2),
      }],
    }),
  )

  server.registerTool(
    'save_contact',
    {
      title: 'Save contact',
      description: 'Save a contact mapping from a shared contact card, phone number, or iMessage handle.',
      inputSchema: {
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
    'run_remy_agent',
    {
      title: 'Run Remy agent',
      description: 'Let Remy decide naturally whether to chat, ask a follow-up, draft an expense, or create requests.',
      inputSchema: {
        text: z.string(),
        payerName: z.string().default('Carson'),
        baseUrl: z.string().url().optional(),
      },
    },
    async ({ text, payerName, baseUrl }) => ({
      content: [{
        type: 'text',
        text: await runRemyAgent({ text, payerName, baseUrl }),
      }],
    }),
  )

  server.registerTool(
    'understand_expense_message',
    {
      title: 'Understand expense message',
      description: 'Extract an expense draft from a casual iMessage like "paid $86 dinner with Alex Brian Sam".',
      inputSchema: {
        text: z.string(),
        payerName: z.string().default('Carson'),
      },
    },
    async ({ text, payerName }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(await understandExpenseMessage({ text, payerName }), null, 2),
      }],
    }),
  )

  server.registerTool(
    'create_payment_requests',
    {
      title: 'Create payment requests',
      description: 'Create shareable payment request messages from an expense draft.',
      inputSchema: {
        draft: expenseDraftSchema,
        baseUrl: z.string().url().optional(),
      },
    },
    async ({ draft, baseUrl }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(createPaymentRequests({ draft, baseUrl }), null, 2),
      }],
    }),
  )

  server.registerTool(
    'get_remy_state',
    {
      title: 'Get Remy state',
      description: 'Read the current in-memory Remy draft and payment requests.',
      inputSchema: {},
    },
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify(getRemyState(), null, 2),
      }],
    }),
  )

  return server
}

export function createMcpApp(): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true, service: 'remy-mcp' }))

  app.get('/.well-known/apple-app-site-association', (c) => {
    const appIdPrefix = process.env.APPLE_APP_ID_PREFIX ?? 'QCW9XJC54W'
    const appBundleId = process.env.IOS_APP_BUNDLE_ID ?? 'com.lstsk.remy'
    const appClipBundleId = process.env.IOS_APP_CLIP_BUNDLE_ID ?? 'com.lstsk.remy.Clip'

    return c.json({
      applinks: {
        apps: [],
        details: [{
          appIDs: [`${appIdPrefix}.${appBundleId}`, `${appIdPrefix}.${appClipBundleId}`],
          components: [{
            '/': '/pay*',
            comment: 'Open Remy pay requests in the installed app or App Clip.',
          }],
        }],
      },
      appclips: {
        apps: [`${appIdPrefix}.${appClipBundleId}`],
      },
    })
  })

  app.get('/pay', (c) => {
    const friend = c.req.query('friend') ?? undefined
    const amount = parseAmount(c.req.query('amount'))
    const title = c.req.query('title') ?? undefined
    const view = findPaymentRequest({ friendName: friend, amount, title })

    return c.html(renderPaymentSheet({
      requestId: view?.request.id,
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
    }))
  })

  app.get('/pay/:id', (c) => {
    const id = c.req.param('id')
    const friend = c.req.query('friend') ?? undefined
    const amount = parseAmount(c.req.query('amount'))
    const title = c.req.query('title') ?? undefined
    const view = findPaymentRequest({ id }) ?? findPaymentRequest({ friendName: friend, amount, title })

    return c.html(renderPaymentSheet({
      requestId: view?.request.id ?? id,
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
    }))
  })

  app.post('/pay/paid', async (c) => {
    const body = await c.req.parseBody()
    const id = String(body.requestId ?? '')
    const friendName = String(body.friendName ?? '')
    const amount = parseAmount(String(body.amount ?? ''))
    const view = updatePaymentRequestStatus({ id: id || undefined, friendName, amount, status: 'paid' })
    if (!view) return c.redirect(id ? `/pay/${encodeURIComponent(id)}?paid=1` : `/pay?friend=${encodeURIComponent(friendName)}&amount=${amount ?? ''}&paid=1`)
    return c.redirect(`/pay/${encodeURIComponent(view.request.id)}?paid=1`)
  })

  app.post('/pay/dispute', async (c) => {
    const body = await c.req.parseBody()
    const id = String(body.requestId ?? '')
    const friendName = String(body.friendName ?? '')
    const amount = parseAmount(String(body.amount ?? ''))
    const view = updatePaymentRequestStatus({ id: id || undefined, friendName, amount, status: 'disputed' })
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

function escapeHtml(value: string | number | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f5f5f7">
  <meta property="og:title" content="${escapeHtml(input.friendName)} owes $${input.amount.toFixed(2)}">
  <meta property="og:description" content="${escapeHtml(input.payerName)} paid for ${escapeHtml(input.title)}. Powered by Remy.">
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
        radial-gradient(circle at 18% -8%, rgba(255, 138, 76, 0.20), transparent 32%),
        radial-gradient(circle at 82% 0%, rgba(0, 122, 255, 0.18), transparent 34%),
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
