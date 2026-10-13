import { expect, test } from "bun:test"
import plugin from "../src/index"

const FLAKE = '{"type":"error","error":{"type":"permission_error","message":"Authentication failed. Please check your credentials."}}'
const MESSAGES = "https://api.commandcode.ai/provider/v1/messages"
const OPENAI = "https://api.commandcode.ai/provider/v1/chat/completions"

const thinking = { type: "thinking", thinking: "step", signature: "sig-1" }
const signed = JSON.stringify({
  model: "claude-sonnet-5-5",
  messages: [
    { role: "user", content: "q" },
    { role: "assistant", content: [thinking, { type: "text", text: "a" }] },
    { role: "user", content: "again" },
  ],
})
const strippedMessages = [
  { role: "user", content: "q" },
  { role: "assistant", content: [{ type: "text", text: "a" }] },
  { role: "user", content: "again" },
]

/** Captures the session hooks setup() registers; same shape as plugin-retry.test.ts. */
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

test("http.request rewrites a signed /messages body before it is sent", async () => {
  const { ctx, hooks } = fakeContext()
  const cleanup = await (plugin as any).setup(ctx)
  const request = new Request(MESSAGES, {
    method: "POST",
    body: signed,
    headers: { authorization: "Bearer k", "anthropic-beta": "interleaved-thinking-2025-05-14" },
  })
  const event = { request }
  await hooks["http.request"]!(event)

  expect(event.request).not.toBe(request)
  expect(event.request.url).toBe(MESSAGES)
  expect(event.request.method).toBe("POST")
  expect(event.request.headers.get("x-api-key")).toBe("k") // auth still shaped
  expect(event.request.headers.get("anthropic-beta")).toBeNull()
  const sent = JSON.parse(await event.request.text()) as any
  expect(sent.messages).toEqual(strippedMessages)
  await cleanup?.()
})

test("a gateway auth flake is re-sent with the stripped body", async () => {
  const seen: { key: string | null; beta: string | null; body: string }[] = []
  const realFetch = globalThis.fetch
  const realError = console.error
  console.error = () => {}
  globalThis.fetch = (async (input: any) => {
    const request = input instanceof Request ? input : new Request(input)
    if (request.url.includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 })
    seen.push({ key: request.headers.get("x-api-key"), beta: request.headers.get("anthropic-beta"), body: await request.text() })
    if (seen.length === 1) return new Response(FLAKE, { status: 403 })
    return new Response("good", { status: 200 })
  }) as unknown as typeof fetch

  try {
    const { ctx, hooks } = fakeContext()
    const cleanup = await (plugin as any).setup(ctx)
    const request = new Request(MESSAGES, { method: "POST", body: signed })
    const event = { request }
    await hooks["http.request"]!(event)
    // The runtime hands the response hook the request it actually sent.
    const responseEvent = { request: event.request, response: new Response(FLAKE, { status: 403 }) }
    await hooks["http.response"]!(responseEvent)

    expect(await responseEvent.response.text()).toBe("good")
    expect(seen.length).toBe(2)
    expect(seen[1]!.key).toBe("k")
    expect(seen[1]!.beta).toBeNull()
    expect(JSON.parse(seen[1]!.body).messages).toEqual(strippedMessages)
    await cleanup?.()
  } finally {
    globalThis.fetch = realFetch
    console.error = realError
  }
})

test("the retry also finds its replay when handed the original request object", async () => {
  const realFetch = globalThis.fetch
  const realError = console.error
  console.error = () => {}
  let resent: string | undefined
  globalThis.fetch = (async (input: any) => {
    const request = input instanceof Request ? input : new Request(input)
    if (request.url.includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 })
    resent = await request.text()
    return new Response("good", { status: 200 })
  }) as unknown as typeof fetch

  try {
    const { ctx, hooks } = fakeContext()
    const cleanup = await (plugin as any).setup(ctx)
    const request = new Request(MESSAGES, { method: "POST", body: signed })
    const event = { request }
    await hooks["http.request"]!(event)
    // Pessimistic host: the response event still points at the pre-rewrite object.
    const responseEvent = { request, response: new Response(FLAKE, { status: 403 }) }
    await hooks["http.response"]!(responseEvent)

    expect(await responseEvent.response.text()).toBe("good")
    expect(JSON.parse(resent!).messages).toEqual(strippedMessages)
    await cleanup?.()
  } finally {
    globalThis.fetch = realFetch
    console.error = realError
  }
})

test("OpenAI-route and unparseable bodies flow through the hook untouched", async () => {
  const { ctx, hooks } = fakeContext()
  const cleanup = await (plugin as any).setup(ctx)

  const openaiBody = JSON.stringify({ messages: [{ role: "assistant", content: [thinking] }] })
  const openai = new Request(OPENAI, { method: "POST", body: openaiBody, headers: { authorization: "Bearer k" } })
  const openaiEvent = { request: openai }
  await hooks["http.request"]!(openaiEvent)
  expect(openaiEvent.request).toBe(openai)
  expect(await openaiEvent.request.text()).toBe(openaiBody)
  expect(openai.headers.get("authorization")).toBe("Bearer k")
  expect(openai.headers.get("x-api-key")).toBeNull()

  const broken = new Request(MESSAGES, { method: "POST", body: "{" })
  const brokenEvent = { request: broken }
  await hooks["http.request"]!(brokenEvent)
  expect(brokenEvent.request).toBe(broken)
  expect(await brokenEvent.request.text()).toBe("{")
  await cleanup?.()
})