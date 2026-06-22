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
npm run verify:db
npm run verify:deepseek
```

## iMessage

Text the Spectrum line from Photon. The agent handles natural messages like:

```text
paid $86 dinner with Alex Brian Sam
```

It will draft the split, then send short iMessage-native replies while the heavier tool contract lives in MCP.

## Native Contacts

Remy also has an iMessage extension scaffold in `ios/`. This is how Remy can match “James” or “Boxiang” from the user’s iPhone Contacts with permission, instead of pretending the backend can see local contacts.

For phone testing:

```bash
npm start
ngrok http 8787
```

Set `REMY_API_BASE_URL` in `ios/project.yml` to the HTTPS ngrok URL, then regenerate:

```bash
npm run ios:generate
```

Open `ios/Remy.xcodeproj` in Xcode, set your development team, run the host app on your phone, then open Remy from the Messages app drawer. The extension uses iOS Contacts permission and Contact Access Button flow so the user can grant exactly the missing contact.
