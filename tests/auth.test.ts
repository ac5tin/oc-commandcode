import { expect, test } from "bun:test"
import { applyApiKeyAuth } from "../src/auth"

const keyCred = { type: "key", key: "sk-live-93chars" } as const
const ANTHROPIC = "https://api.commandcode.ai/provider/v1/messages"
const OPENAI = "https://api.commandcode.ai/provider/v1/chat/completions"

test("messages route: Bearer swapped for x-api-key, anthropic-beta stripped", () => {
  const headers = new Headers({
    authorization: "Bearer sk-live-93chars",
    "anthropic-beta": "interleaved-thinking-2025-05-14",
  })
  applyApiKeyAuth(headers, ANTHROPIC, keyCred)
  expect(headers.get("x-api-key")).toBe("sk-live-93chars")
  expect(headers.get("authorization")).toBeNull()
  // The gateway's native Claude-5 path (any anthropic-beta header) rejects
  // API keys with 403 "Authentication failed"; classic mode has no betas.
  expect(headers.get("anthropic-beta")).toBeNull()
})

test("openai route: headers untouched", () => {
  const headers = new Headers({
    authorization: "Bearer sk-live-93chars",
    "anthropic-beta": "interleaved-thinking-2025-05-14",
  })
  applyApiKeyAuth(headers, OPENAI, keyCred)
  expect(headers.get("authorization")).toBe("Bearer sk-live-93chars")
  expect(headers.get("x-api-key")).toBeNull()
  expect(headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14")
})

test("messages route with query string still matches", () => {
  const headers = new Headers()
  applyApiKeyAuth(headers, `${ANTHROPIC}?beta=true`, keyCred)
  expect(headers.get("x-api-key")).toBe("sk-live-93chars")
})

test("no credential: headers untouched", () => {
  const headers = new Headers({ authorization: "Bearer x" })
  applyApiKeyAuth(headers, ANTHROPIC, undefined)
  expect(headers.get("authorization")).toBe("Bearer x")
})

test("non-key credential: headers untouched", () => {
  const headers = new Headers({ authorization: "Bearer x" })
  applyApiKeyAuth(headers, ANTHROPIC, { type: "oauth", access: "t", refresh: "r", expires: 0 })
  expect(headers.get("authorization")).toBe("Bearer x")
})
