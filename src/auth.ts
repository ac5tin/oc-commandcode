/**
 * The OpenCode host attaches integration credentials as `Authorization:
 * Bearer`, but the CommandCode gateway's Anthropic `/messages` route only
 * accepts `x-api-key` (Bearer gets 403 "Authentication failed"). Rewrites the
 * auth header for that route only; OpenAI-route traffic keeps Bearer.
 */
export function applyApiKeyAuth(headers: Headers, url: string, credential: unknown): void {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return
  }
  if (!pathname.endsWith("/messages")) return
  if (typeof credential !== "object" || credential === null) return
  const { type, key } = credential as { type?: string; key?: string }
  if (type !== "key" || !key) return
  headers.set("x-api-key", key)
  headers.delete("authorization")
}
