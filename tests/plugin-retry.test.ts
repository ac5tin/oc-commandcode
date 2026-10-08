import { expect, test } from "bun:test"
import plugin from "../src/index"

const FLAKE = '{"type":"error","error":{"type":"permission_error","message":"Authentication failed. Please check your credentials."}}'
const MESSAGES = "https://api.commandcode.ai/provider/v1/messages"

/** Captures the session hooks setup() registers, with the integration a key credential. */
function fakeContext() {
  const hooks: Record<string, (event: any) => Promise<void>> = {}
  const ctx = {
    app: { version: "test" },
    integration: {
      transform: async () => {},
      connection: {
        active: async () => ({}),
        resolve: async () => ({ type: "key", key: "k" }),
      },
    },
    provider: { transform: async () => {}, reload: async () => {} },
    session: {
      hook: async (name: string, handler: (event: any) => Promise<void>) => {
        hooks[name] = handler
      },
    },
  }
  return { ctx: ctx as any, hooks }
}

test("a gateway auth flake is re-sent on the shaped wire and the good response wins", async () => {
  const seen: { url: string; key: string | null; beta: string | null; body: string }[] = []
  const realFetch = globalThis.fetch
  const realError = console.error
  console.error = () => {} // the retry log line would pollute test output
  globalThis.fetch = (async (input: any) => {
    const request = input instanceof Request ? input : new Request(input)
    if (request.url.includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 })
    seen.push({
      url: request.url,
      key: request.headers.get("x-api-key"),
      beta: request.headers.get("anthropic-beta"),
      body: await request.text(),
    })
    if (seen.length === 1) return new Response(FLAKE, { status: 403 })
    return new Response("good", { status: 200 })
  }) as unknown as typeof fetch

  try {
    const { ctx, hooks } = fakeContext()
    const cleanup = await (plugin as any).setup(ctx)
    const request = new Request(MESSAGES, {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer k", "anthropic-beta": "interleaved-thinking-2025-05-14" },
    })
    await hooks["http.request"]!({ request })
    const event = { request, response: new Response(FLAKE, { status: 403 }) }
    await hooks["http.response"]!(event)

    expect(await event.response.text()).toBe("good")
    expect(seen.length).toBe(2)
    expect(seen[1]!.url).toBe(MESSAGES)
    expect(seen[1]!.key).toBe("k") // shaped clone: x-api-key set...
    expect(seen[1]!.beta).toBeNull() // ...anthropic-beta stripped
    expect(seen[1]!.body).toBe("{}")
    await cleanup?.()
  } finally {
    globalThis.fetch = realFetch
    console.error = realError
  }
})

test("a non-flake 403 is handed back untouched, no resend", async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (input: any) => {
    const request = input instanceof Request ? input : new Request(input)
    if (request.url.includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 })
    calls++
    return new Response("nope", { status: 403 })
  }) as unknown as typeof fetch

  try {
    const { ctx, hooks } = fakeContext()
    const cleanup = await (plugin as any).setup(ctx)
    const request = new Request(MESSAGES, { method: "POST", body: "{}" })
    await hooks["http.request"]!({ request })
    const event = { request, response: new Response("MODEL_NOT_IN_PLAN", { status: 403 }) }
    await hooks["http.response"]!(event)

    expect(event.response.status).toBe(403)
    expect(await event.response.text()).toBe("MODEL_NOT_IN_PLAN")
    expect(calls).toBe(0)
    await cleanup?.()
  } finally {
    globalThis.fetch = realFetch
  }
})
