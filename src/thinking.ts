/**
 * Claude Sonnet 5.5 thinking blocks are cryptographically signed and bound to
 * the exact conversation prefix and tools list of the request that created
 * them. Replaying one after the session's shape changes (plan↔build swaps the
 * tools list, plan-mode system reminders move the prefix) 400s with "Invalid
 * `signature` in `thinking` block". OpenCode's prefix-mismatch mitigation
 * cannot engage for this plugin — the decoy `cmd:` modelID defeats its Claude
 * detection (src/catalog.ts) and the gateway rejects any anthropic-beta header
 * (src/auth.ts) — so outbound /messages bodies never carry signed blocks.
 *
 * Returns the re-serialized body when at least one block was removed or a
 * role was folded, null when nothing changed or the body cannot be parsed
 * (the caller passes it on).
 *
 * The same pass folds any `messages[].role` outside user/assistant into a
 * user turn: the CommandCode gateway 400s them ("Invalid input at
 * messages.N.role"), and replayed sessions have leaked mid-conversation
 * `system` date notices past the decoy's classic-Messages lowering
 * (src/catalog.ts).
 */
export function stripThinkingBlocks(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const root = parsed as Record<string, unknown>
  if (!Array.isArray(root.messages)) return null

  let changed = false
  const kept: unknown[] = []
  for (const message of root.messages) {
    if (typeof message !== "object" || message === null) {
      kept.push(message)
      continue
    }
    const { role, content } = message as { role?: unknown; content?: unknown }
    if (role !== "user" && role !== "assistant") {
      changed = true
      // Adjacent same-role turns are fine — the API merges them.
      kept.push({ ...(message as Record<string, unknown>), role: "user" })
      continue
    }
    if (role !== "assistant" || !Array.isArray(content)) {
      kept.push(message)
      continue
    }
    const blocks = content.filter(
      (block) =>
        typeof block !== "object" ||
        block === null ||
        ((block as { type?: unknown }).type !== "thinking" &&
          (block as { type?: unknown }).type !== "redacted_thinking"),
    )
    if (blocks.length === content.length) {
      kept.push(message)
      continue
    }
    changed = true
    // A turn that was pure thinking carries nothing once stripped; dropping it
    // keeps alternation valid (the API merges adjacent same-role turns).
    if (blocks.length === 0) continue
    kept.push({ ...(message as Record<string, unknown>), content: blocks })
  }
  if (!changed) return null
  return JSON.stringify({ ...root, messages: kept })
}

/**
 * Request-side wiring: apply the body shaping (thinking strip + role fold)
 * to /messages bodies only (mirrors the route scope in src/auth.ts). Returns
 * `request` itself when there is nothing to change, so untouched requests
 * keep flowing byte-identical.
 */
export async function stripThinking(request: Request): Promise<Request> {
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return request
  }
  if (!pathname.endsWith("/messages")) return request
  let body: string
  try {
    body = await request.clone().text()
  } catch {
    return request
  }
  const stripped = stripThinkingBlocks(body)
  if (stripped === null) return request
  const rewritten = new Request(request, { body: stripped })
  // The copied header still declares the old length; let the runtime recompute.
  rewritten.headers.delete("content-length")
  return rewritten
}