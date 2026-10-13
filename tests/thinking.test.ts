import { expect, test } from "bun:test"
import { stripThinking, stripThinkingBlocks } from "../src/thinking"

const MESSAGES = "https://api.commandcode.ai/provider/v1/messages"
const OPENAI = "https://api.commandcode.ai/provider/v1/chat/completions"

const thinking = { type: "thinking", thinking: "step", signature: "sig-1" }
const redacted = { type: "redacted_thinking", data: "opaque" }

test("assistant thinking blocks are stripped, text/tool blocks survive in order", () => {
  const body = stripThinkingBlocks(
    JSON.stringify({
      model: "claude-sonnet-5-5",
      max_tokens: 4096,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            thinking,
            { type: "text", text: "yo" },
            { type: "tool_use", id: "t1", name: "read", input: { path: "a" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: [redacted, { type: "text", text: "done" }] },
      ],
    }),
  )
  expect(body).not.toBeNull()
  const parsed = JSON.parse(body!) as any
  expect(parsed.model).toBe("claude-sonnet-5-5")
  expect(parsed.max_tokens).toBe(4096)
  expect(parsed.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
  expect(parsed.messages[0].content).toBe("hi")
  expect(parsed.messages[1].content).toEqual([
    { type: "text", text: "yo" },
    { type: "tool_use", id: "t1", name: "read", input: { path: "a" } },
  ])
  expect(parsed.messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "ok" }])
  expect(parsed.messages[3].content).toEqual([{ type: "text", text: "done" }])
})

test("no thinking blocks: nothing changes (null)", () => {
  const body = JSON.stringify({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }, { type: "tool_use", id: "t", name: "n", input: {} }] },
    ],
  })
  expect(stripThinkingBlocks(body)).toBeNull()
})

test("user messages and string content are never touched", () => {
  const body = JSON.stringify({
    messages: [
      { role: "user", content: [{ type: "thinking", thinking: "not ours", signature: "s" }] },
      { role: "assistant", content: "plain string" },
    ],
  })
  expect(stripThinkingBlocks(body)).toBeNull()
})

test("assistant message emptied by the strip is dropped, not sent as content: []", () => {
  const body = stripThinkingBlocks(
    JSON.stringify({
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: [thinking] },
        { role: "user", content: "b" },
        { role: "assistant", content: [redacted, thinking] },
      ],
    }),
  )
  expect(body).not.toBeNull()
  expect(JSON.parse(body!).messages).toEqual([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ])
})

test("non-object message entries survive a strip elsewhere", () => {
  const body = stripThinkingBlocks(
    JSON.stringify({ messages: [null, "x", { role: "assistant" }, { role: "assistant", content: [thinking] }, { role: "user", content: "u" }] }),
  )
  expect(JSON.parse(body!).messages).toEqual([null, "x", { role: "assistant" }, { role: "user", content: "u" }])
})

test("malformed bodies pass through untouched (null, no throw)", () => {
  for (const body of ["not json", "", "null", "[]", '"x"', "{}", '{"messages":{}}', '{"messages":[null,"x"]}']) {
    expect(stripThinkingBlocks(body)).toBeNull()
  }
})

test("stripThinking: /messages body with thinking yields a rewritten Request", async () => {
  const body = JSON.stringify({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [thinking, { type: "text", text: "a" }] },
    ],
  })
  const request = new Request(MESSAGES, { method: "POST", body, headers: { "content-type": "application/json" } })
  const out = await stripThinking(request)
  expect(out).not.toBe(request)
  expect(out.url).toBe(MESSAGES)
  expect(out.method).toBe("POST")
  expect(out.headers.get("content-type")).toBe("application/json")
  const parsed = JSON.parse(await out.text()) as any
  expect(parsed.messages[1].content).toEqual([{ type: "text", text: "a" }])
})

test("stripThinking: stale content-length is dropped with the old body", async () => {
  const body = JSON.stringify({ messages: [{ role: "assistant", content: [thinking] }] })
  const request = new Request(MESSAGES, { method: "POST", body, headers: { "content-length": String(body.length) } })
  const out = await stripThinking(request)
  expect(out.headers.get("content-length")).toBeNull()
})

test("stripThinking: OpenAI route, clean bodies, malformed bodies flow through as-is", async () => {
  const openaiBody = JSON.stringify({ messages: [{ role: "assistant", content: [thinking] }] })
  const openai = new Request(OPENAI, { method: "POST", body: openaiBody })
  expect(await stripThinking(openai)).toBe(openai)

  const clean = new Request(MESSAGES, { method: "POST", body: JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "text", text: "a" }] }] }) })
  expect(await stripThinking(clean)).toBe(clean)

  const broken = new Request(MESSAGES, { method: "POST", body: "{" })
  expect(await stripThinking(broken)).toBe(broken)
})