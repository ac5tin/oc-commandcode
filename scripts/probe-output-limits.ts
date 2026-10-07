/**
 * Probe CommandCode for each model's exact server-side output-token cap and
 * write it into src/catalog.json (`output` field). Idempotent: rerunning with
 * an unchanged upstream produces an empty git diff.
 *
 * How: send max_tokens far above any real limit with a one-token prompt. The
 * API's validation error names the exact cap ("max_tokens: 1000000 > 128000,
 * which is the maximum allowed number of output tokens for …"). Rejected 400s
 * are never billed. A model that accepts the request has no server cap; it
 * keeps the CLI-default fallback and is listed at the end.
 *
 * Usage: CMD_API_KEY=… bun run probe        (fills missing caps only)
 *        CMD_API_KEY=… bun run probe --all  (re-verifies every model)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { isAnthropicRoute } from "../src/catalog"

const BASE = "https://api.commandcode.ai/provider/v1"
const PROBE_MAX = 1_000_000
const DELAY_MS = 400

type File = { commandCodeVersion: string; models: Array<Record<string, unknown> & { id: string }> }

const key =
  process.env.CMD_API_KEY ??
  process.env.COMMAND_CODE_API_KEY ??
  process.env.COMMANDCODE_API_KEY
if (!key) {
  console.error("pass the API key: CMD_API_KEY=… bun run probe")
  process.exit(1)
}

const all = process.argv.includes("--all")
const file = readFileSync(new URL("../src/catalog.json", import.meta.url), "utf8")
const doc = JSON.parse(file) as File
const targets = doc.models.filter((m) => all || typeof m.output !== "number")
console.log(`probing ${targets.length}/${doc.models.length} models`)

/** Extract a cap from a validation response. Ordered specific → generic. */
function parseCap(haystack: string): number | undefined {
  const patterns = [
    />\s*([\d,]{3,9})/, // "max_tokens: 1000000 > 128000"
    /between\s+[\d,]+\s+and\s+([\d,]+)/i, // "must be between 0 and 393216"
    /\[\s*[\d,]+\s*,\s*([\d,]{3,9})\s*\]/, // "Range of max_tokens should be [1, 262144]"
    /not less or equal to\s*([\d,]+)/i, // "... is not less or equal to 131072"
    /at most\s*([\d,]+)/i,
    /up to\s+([\d,]{3,9})/i,
    /maximum(?:\s+allowed)?(?:\s+number)?[^\d]{0,60}([\d,]{3,9})/i,
    /limit(?:ed)?(?:\s+(?:is|to|of))?[^\d]{0,30}([\d,]{3,9})/i,
  ]
  for (const re of patterns) {
    const n = Number(haystack.match(re)?.[1]?.replaceAll(",", ""))
    if (Number.isInteger(n) && n >= 1_024) return n
  }
  return undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One probe request; never throws. */
async function send(
  anthropic: boolean,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string; retryAfter?: number }> {
  const res = await fetch(anthropic ? `${BASE}/messages` : `${BASE}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: anthropic
      ? { "content-type": "application/json", "x-api-key": key!, "anthropic-version": "2023-06-01" }
      : { "content-type": "application/json", authorization: `Bearer ${key!}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text(), retryAfter: Number(res.headers.get("retry-after") ?? 0) * 1000 }
}

// When a 400 names no number, walk down standard caps until the server accepts.
// The first accepted step is a working cap (a floor, not necessarily the true max).
const LADDER = [262_144, 131_072, 65_536, 32_768, 16_384, 8_192]

async function probe(model: string, anthropic: boolean): Promise<{ cap?: number; accepted: boolean; note?: string }> {
  const body = { model, max_tokens: PROBE_MAX, messages: [{ role: "user", content: "hi" }] }

  for (let attempt = 0; ; attempt++) {
    let r: Awaited<ReturnType<typeof send>>
    try {
      r = await send(anthropic, body)
    } catch (err) {
      if (attempt < 2) continue
      return { accepted: false, note: `network: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (r.status === 429 && attempt < 3) {
      await sleep(r.retryAfter || 2_000)
      continue
    }
    if (r.status === 200) return { accepted: true } // no server-side validation; tiny billed completion
    if (r.status === 401) {
      console.error("auth rejected (401) — check CMD_API_KEY")
      process.exit(1)
    }
    if (r.status === 403) {
      // Per-model/plan entitlement, not a bad key: skip with a note.
      return { accepted: false, note: "forbidden — plan/model access" }
    }

    // Cap may sit anywhere in the envelope, including nested upstream errors.
    const cap = parseCap(r.text)
    if (cap) return { cap, accepted: false }

    // OpenAI-route models may refuse `max_tokens` itself; retry with the modern field.
    if (!anthropic && /max_tokens.*not supported|use\s+'?max_completion_tokens'?/i.test(r.text)) {
      const retry = await send(anthropic, {
        model,
        max_completion_tokens: PROBE_MAX,
        messages: body.messages,
      })
      const alt = parseCap(retry.text)
      if (alt) return { cap: alt, accepted: false }
    }

    if (r.status === 400) {
      for (const step of LADDER) {
        const lr = await send(anthropic, { ...body, max_tokens: step })
        if (lr.status === 200) return { cap: step, accepted: false, note: "ladder floor (server accepted, true max may be higher)" }
        const lc = parseCap(lr.text)
        if (lc) return { cap: lc, accepted: false }
      }
    }
    return { accepted: false, note: `unparsed (HTTP ${r.status}): ${r.text.slice(0, 160)}` }
  }
}

const results: Array<{ id: string; cap?: number; note?: string }> = []
for (const m of targets) {
  const anthropic = isAnthropicRoute(m.id)
  const r = await probe(m.id, anthropic)
  if (r.cap) {
    const entry = doc.models.find((x) => x.id === m.id)!
    entry.output = r.cap
  }
  results.push({ id: m.id, cap: r.cap, note: r.accepted ? "accepted — no server cap, keeps fallback" : r.note })
  console.log(`${r.cap ? `${r.cap}`.padStart(7) : "      -"}  ${m.id}${r.note ? `  (${r.note})` : r.accepted ? "  (accepted)" : ""}`)
  await sleep(DELAY_MS)
}

writeFileSync(new URL("../src/catalog.json", import.meta.url), JSON.stringify(doc, null, 2) + "\n")

const missing = results.filter((r) => !r.cap)
const known = doc.models.filter((m) => typeof m.output === "number").length
console.log(`\ncatalog: ${known}/${doc.models.length} models carry an exact output cap`)
if (missing.length) {
  console.error(`${missing.length} model(s) unresolved → they keep the 64k CLI-default fallback`)
  process.exit(1)
}
