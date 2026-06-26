import { Spectrum } from 'spectrum-ts'
import { imessage } from 'spectrum-ts/providers/imessage'
import { loadEnv, publicBaseUrl, requiredEnv } from './env.ts'
import { runRemyAgent } from './tools.ts'
import { defaultConversationId, saveContact } from './db/repository.ts'

function isDroppedUpstream(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as {
    status?: number
    code?: string
    grpcCode?: number
    message?: string
    cause?: { code?: number; details?: string; message?: string }
  }
  const text = `${candidate.message ?? ''} ${candidate.cause?.message ?? ''} ${candidate.cause?.details ?? ''}`
  return candidate.grpcCode === 14 || candidate.cause?.code === 14 || /Connection dropped|UNAVAILABLE/i.test(text)
}

function isRateLimited(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { status?: number; code?: string; message?: string }
  return candidate.status === 429 || candidate.code === 'RATE_LIMITED' || /rate limited/i.test(candidate.message ?? '')
}

function rateLimitDelayMs(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 60_000
  const message = String((error as { message?: string }).message ?? '')
  const match = message.match(/retry after\s+(\d+)s/i)
  return match ? Math.max(Number(match[1]) * 1000, 5_000) : 60_000
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type MessageSpace = {
  send(content: string): Promise<unknown>
  responding<T>(fn: () => Promise<T>): Promise<T>
}

type InboundMessage = {
  read(): Promise<void>
}

type ContactContent = {
  type: 'contact'
  name?: {
    formatted?: string
    first?: string
    last?: string
  }
  phones?: Array<{ value: string; type?: string }>
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

function conversationIdFromSpace(space: MessageSpace): string {
  const candidate = space as unknown as Record<string, unknown>
  for (const key of ['id', 'spaceId', 'conversationId', 'threadId']) {
    const value = candidate[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  const nested = candidate.space
  if (typeof nested === 'object' && nested !== null) {
    const nestedRecord = nested as Record<string, unknown>
    for (const key of ['id', 'spaceId', 'conversationId', 'threadId']) {
      const value = nestedRecord[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }

  return defaultConversationId
}

function displayNameFromContact(content: ContactContent): string | null {
  const formatted = content.name?.formatted?.trim()
  if (formatted) return formatted

  const parts = [content.name?.first, content.name?.last]
    .map((part) => part?.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : null
}

export async function startAgent(): Promise<void> {
  loadEnv()

  let app: Awaited<ReturnType<typeof Spectrum>>
  for (;;) {
    try {
      app = await Spectrum({
        projectId: requiredEnv('PROJECT_ID'),
        projectSecret: requiredEnv('PROJECT_SECRET'),
        providers: [imessage.config()],
        options: {
          logLevel: process.env.SPECTRUM_LOG_LEVEL === 'debug' ? 'debug' : 'info',
        },
        telemetry: false,
      })
      break
    } catch (error) {
      if (!isRateLimited(error)) throw error
      const delayMs = rateLimitDelayMs(error)
      console.warn(`Spectrum startup rate limited. Retrying in ${Math.round(delayMs / 1000)}s.`)
      await sleep(delayMs)
    }
  }

  console.log('Remy iMessage agent is running.')
  console.log('iMessage provider enabled through Spectrum.')

  for await (const [space, message] of app.messages) {
    try {
      await safeRead(message)
      await safeResponding(space, async () => {
        const conversationId = conversationIdFromSpace(space)

        if (message.content.type === 'contact') {
          const contactContent = message.content as ContactContent
          const displayName = displayNameFromContact(contactContent)
          const phone = contactContent.phones?.find((candidate) => candidate.type === 'mobile')?.value
            ?? contactContent.phones?.[0]?.value

          if (!displayName && !phone) {
            await safeSend(space, 'I got the contact card, but I could not read the name or number.')
            return
          }

          const contact = saveContact({
            displayName: displayName ?? phone!,
            alias: displayName?.split(/\s+/)[0] ?? phone,
            phone,
            imessageHandle: phone,
            conversationId,
            source: 'contact-card',
          })

          await safeSend(space, `Got ${contact.displayName}. I’ll remember them for next time.`)
          return
        }

        if (message.content.type !== 'text') {
          await safeSend(space, 'Send me text or a contact card for now.')
          return
        }

        try {
          const text = message.content.text ?? ''
          const reply = await runRemyAgent({
            text,
            payerName: 'Carson',
            baseUrl: publicBaseUrl(),
            conversationId,
          })
          await safeSend(space, reply)
        } catch (error) {
          console.error(error instanceof Error ? error.message : error)
          await safeSend(space, "I hit a hiccup on my side. Send that last bit once more and I'll pick it up.")
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
