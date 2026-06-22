import { loadEnv } from './env.ts'
import { startAgent } from './agent.ts'
import { startMcpServer } from './mcp.ts'
import { ensureDatabase } from './db/index.ts'

loadEnv()
ensureDatabase()

const server = startMcpServer()

process.on('SIGINT', () => {
  console.log('\nSIGINT received. Shutting down Remy.')
  server.close()
  process.exit(0)
})

await startAgent()
