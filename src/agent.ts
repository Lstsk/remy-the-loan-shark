import { Spectrum } from 'spectrum-ts'
import { imessage } from 'spectrum-ts/providers/imessage'
import { loadEnv, publicBaseUrl, requiredEnv } from './env.ts'
import { runRemyAgent } from './tools.ts'

function isDroppedUpstream(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as {
    grpcCode?: number
    message?: string
    cause?: { code?: number; details?: string; message?: string }
  }
  const text = `${candidate.message ?? ''} ${candidate.cause?.message ?? ''} ${candidate.cause?.details ?? ''}`
  return candidate.grpcCode === 14 || candidate.cause?.code === 14 || /Connection dropped|UNAVAILABLE/i.test(text)
}

type MessageSpace = {
  send(content: string): Promise<unknown>
  responding<T>(fn: () => Promise<T>): Promise<T>
}

type InboundMessage = {
  read(): Promise<void>
  content: { type: string; text?: string }
}

async function safeRead(message: InboundMessage): Promise<void> {
  try {
    await message.read()
  } catch (error) {
    if (!isDroppedUpstream(error)) throw error
    console.warn('Spectrum read receipt dropped; continuing.')
  }
}

async function safeResponding<T>(space: MessageSpace, fn: () => Promise<T>): Promise<T> {
  try {
    return await space.responding(fn)
  } catch (error) {
    if (!isDroppedUpstream(error)) throw error

    console.warn('Spectrum typing/presence dropped; running turn without typing indicator.')
    return await fn()
  }
}

async function safeSend(space: MessageSpace, content: string): Promise<void> {
  try {
    await space.send(content)
  } catch (error) {
    if (!isDroppedUpstream(error)) throw error

    console.warn('Spectrum upstream dropped while sending; retrying once.')
    await new Promise((resolve) => setTimeout(resolve, 650))
    try {
      await space.send(content)
    } catch (retryError) {
      if (!isDroppedUpstream(retryError)) throw retryError
      console.error('Spectrum upstream dropped while sending after retry; keeping agent alive.')
    }
  }
}

export async function startAgent(): Promise<void> {
  loadEnv()

  const app = await Spectrum({
    projectId: requiredEnv('PROJECT_ID'),
    projectSecret: requiredEnv('PROJECT_SECRET'),
    providers: [imessage.config()],
    options: {
      logLevel: process.env.SPECTRUM_LOG_LEVEL === 'debug' ? 'debug' : 'info',
    },
    telemetry: false,
  })

  console.log('Remy iMessage agent is running.')
  console.log('iMessage provider enabled through Spectrum.')

  for await (const [space, message] of app.messages) {
    if (message.content.type !== 'text') continue
    const text = message.content.text

    try {
      await safeRead(message)
      await safeResponding(space, async () => {
        try {
          const reply = await runRemyAgent({ text, payerName: 'Carson', baseUrl: publicBaseUrl() })
          await safeSend(space, reply)
        } catch (error) {
          console.error(error instanceof Error ? error.message : error)
          await safeSend(space, 'Text me what you paid and who was there. Example: paid $86 dinner with Alex Brian Sam')
        }
      })
    } catch (error) {
      if (!isDroppedUpstream(error)) throw error
      console.error('Spectrum upstream dropped during iMessage turn; keeping agent alive.')
    }
  }
}

if (process.argv[1] === import.meta.filename) {
  startAgent().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
