export function loadEnv(): void {
  try {
    process.loadEnvFile('.env')
  } catch {
    // Hosts can provide env vars directly.
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function publicBaseUrl(): string {
  return process.env.PUBLIC_APP_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8787'}`
}
