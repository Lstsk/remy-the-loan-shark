# Remy

Text Remy what you paid for. Remy gets you paid back.

This reset follows the Spectrum docs shape:

- `src/agent.ts` runs the iMessage agent with `Spectrum`, `imessage.config()`, `app.messages`, and `space.responding(...)`.
- `src/mcp.ts` exposes Remy tools over MCP Streamable HTTP using Hono.
- `src/tools.ts` holds the shared TypeScript tool implementations used by both the agent and MCP server.

## Run

```bash
npm install
npm start
```

The agent reads credentials from `.env`.

## Test

```bash
npm run verify
```

## Payment UI Experiment

Remy can A/B test chat-native payment UI without requiring an iOS app install.

Variants:

- `link_preview`: short message plus tracked pay link, relying on Messages link previews.
- `image_card`: generated receipt/payment image at `/card/:id.svg`, followed by the tracked pay link.
- `conversational_minimal`: fastest text-first payment request.

By default, Remy assigns variants deterministically across requests. To force one variant during a live test:

```bash
REMY_PAYMENT_UI_VARIANT=image_card npm start
```

Tracked surfaces:

- `/r/:id` records a payment-link tap, then redirects to `/pay/:id`.
- `/card/:id.svg` renders the image-card treatment and records a card view.
- `/pay/:id` records payment-sheet opens.
- `/experiments/payment-ui` returns variant-level counts and rates.

## iMessage

Text the Spectrum line from Photon. The agent handles natural messages like:

```text
paid $86 dinner with Alex Brian Sam
```

It will draft the split, then send short iMessage-native replies while the heavier tool contract lives in MCP.

## Coolify Deploy

Use Dockerfile deployment from the GitHub repo.

Required settings:

```bash
PORT=8787
HOST=0.0.0.0
PUBLIC_APP_URL=https://trymomento.app
REMY_DATABASE_URL=/app/data/remy.sqlite
PROJECT_ID=...
PROJECT_SECRET=...
DEEPSEEK_API_KEY=...
MISTRAL_API_KEY=...
```

Add a persistent volume:

```text
/app/data
```

Point `trymomento.app` DNS to the Coolify app, then verify:

```bash
curl https://trymomento.app/health
curl "https://trymomento.app/pay?friend=alex&amount=28.67&title=Dinner"
```
