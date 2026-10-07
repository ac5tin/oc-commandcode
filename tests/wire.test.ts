import { expect, test } from "bun:test"
import { Provider } from "@opencode/plugin"
import { LanguageModel, Message } from "@opencode/ai"
import * as P from "@opencode/ai/promise"
import { buildModels } from "../src/catalog"

// Guards billing: the Claude route must send cache_control breakpoints and report cache usage.
const sse = [
  `data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"usage":{"input_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20,"output_tokens":1}}}\n\n`,
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n`,
  `data: {"type":"message_stop"}\n\n`,
].join("")

test("claude route: caching breakpoints on the wire, cache usage parsed", async () => {
  const entry = { id: "claude-sonnet-5-5", name: "S", context: 200_000, efforts: ["low", "max"] }
  const info = buildModels([entry], Provider.ID.make("commandcode"))[0]!
  const pkg = (await import(info.package!)) as any
  // Mirror the host: it overrides model.provider with the provider id (affects ?beta=true on the URL).
  // The host applies variant body as an http.body overlay; mirror that here.
  const max = info.variants.find((v) => (v.id as string) === "max")!
  const model = LanguageModel.update(
    pkg.model(entry.id, { apiKey: "KEY", ...info.settings, ...max.settings, body: (max as any).body }),
    { provider: "commandcode" } as any,
  )

  let seen: { url: string; key: string | null; body: any } | undefined
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any) => {
    const req = input instanceof Request ? input : new Request(input, init)
    seen = { url: req.url, key: req.headers.get("x-api-key"), body: JSON.parse(await req.text()) }
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
  }) as any
  try {
    const tool = (name: string) => ({ type: "tool", name, description: "d", inputSchema: { type: "object" } })
    const res: any = await P.make().llm.generate({
      model,
      system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
      tools: [tool("t1"), tool("t2")],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
        { role: "user", content: "again" },
      ],
    } as any)

    expect(seen!.url).toBe("https://api.commandcode.ai/provider/v1/messages")
    expect(seen!.key).toBe("KEY")
    const b = seen!.body
    expect(b.tools.at(-1).cache_control).toEqual({ type: "ephemeral" })
    expect(b.system.at(-1).cache_control).toEqual({ type: "ephemeral" })
    expect(b.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" })
    // At most 4 breakpoints (Anthropic cap), all 5-minute (no ttl => no 2x 1h write premium).
    const marks = [...b.tools, ...b.system, ...b.messages.flatMap((m: any) => m.content)]
      .map((x: any) => x.cache_control)
      .filter(Boolean)
    expect(marks.length).toBeLessThanOrEqual(4)
    for (const m of marks) expect(m).toEqual({ type: "ephemeral" })
    // Guards the effort variants: output_config.effort lands on the wire via
    // the variant body overlay (settings.reasoningEffort would be silently dropped).
    expect(b.output_config).toEqual({ effort: "max" })
    expect(res.usage.cacheReadInputTokens).toBe(100)
    expect(res.usage.cacheWriteInputTokens).toBe(20)

    // Guards the mid-session variant switch: an effort marker in a long history
    // must not produce mid-conversation system+output_config messages (the
    // CommandCode gateway rejects role "system" in messages). Markers are
    // stripped; the variant effort still applies top-level.
    const pairs: any[] = []
    for (let i = 0; i < 42; i++) {
      pairs.push({ role: "user", content: `q${i}` })
      pairs.push({ role: "assistant", content: `a${i}` })
    }
    await P.make().llm.generate({
      model,
      messages: [...pairs, Message.effort({ effort: "max", previous: "low" }), { role: "user", content: "again" }],
    } as any)
    const roles = seen!.body.messages.map((m: any) => m.role)
    expect(roles).not.toContain("system")
    expect(seen!.body.messages[84]).toEqual({
      role: "user",
      content: [{ type: "text", text: "again", cache_control: { type: "ephemeral" } }],
    })
    expect(seen!.body.output_config).toEqual({ effort: "max" })
  } finally {
    globalThis.fetch = realFetch
  }
})
// NOTE: keep wire assertions in this one test. @opencode/ai's executor layer
// binds fetch at first build, so a second test's fetch stub is bypassed.
