/**
 * Wire shaping for the CommandCode gateway's classic Anthropic `/messages`
 * route. The gateway's native Claude-5 path — selected by ANY `anthropic-beta`
 * header — rejects API keys with 403 "Authentication failed", and the route
 * wants `x-api-key` rather than `Authorization`. Applies to `/messages` only;
 * OpenAI-route traffic passes through untouched.
 */
export function applyApiKeyAuth(headers: Headers, url: string, credential: unknown): void {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return
  }
  if (!pathname.endsWith("/messages")) return
  headers.delete("anthropic-beta")
  if (typeof credential !== "object" || credential === null) return
  const { type, key } = credential as { type?: string; key?: string }
  if (type !== "key" || !key) return
  headers.set("x-api-key", key)
  headers.delete("authorization")
}
