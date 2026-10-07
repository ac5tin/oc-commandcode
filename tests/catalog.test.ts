import { describe, expect, test } from "bun:test"
import { Provider } from "@opencode/plugin"
import {
  buildModels,
  isAnthropicRoute,
  mergeCatalog,
  toVariants,
  type CatalogEntry,
} from "../src/catalog"

const pid = Provider.ID.make("commandcode")

/** Brands are phantom types; strip them for structural assertions. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as any
const one = <T>(arr: readonly T[]): T => arr[0]!

describe("isAnthropicRoute", () => {
  test("claude- id with no endpoint info is anthropic", () => {
    expect(isAnthropicRoute("claude-sonnet-5")).toBe(true)
  })

  test("model whose live endpoints include /messages is anthropic", () => {
    expect(isAnthropicRoute("some-vendor/model", ["/messages"])).toBe(true)
  })

  test("model with both /messages and /chat/completions prefers anthropic", () => {
    expect(isAnthropicRoute("some-vendor/model", ["/chat/completions", "/messages"])).toBe(true)
  })

  test("openai-route models are not anthropic", () => {
    expect(isAnthropicRoute("gpt-5.5", ["/chat/completions", "/responses"])).toBe(false)
    expect(isAnthropicRoute("deepseek/deepseek-v4-flash", ["/chat/completions"])).toBe(false)
  })

  test("non-claude id with no endpoints is not anthropic", () => {
    expect(isAnthropicRoute("deepseek/deepseek-v4-flash")).toBe(false)
  })
})

describe("toVariants", () => {
  test("maps each effort to a reasoningEffort variant", () => {
    const plain = toVariants(["low", "high"]).map((v) => ({ id: v.id as string, settings: v.settings }))
    expect(plain).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ])
  })

  test("anthropic route uses effort (output_config.effort), not reasoningEffort", () => {
    const plain = toVariants(["low", "high"], true).map((v) => ({ id: v.id as string, settings: v.settings }))
    expect(plain).toEqual([
      { id: "low", settings: { effort: "low" } },
      { id: "high", settings: { effort: "high" } },
    ])
  })

  test("passes through unusual effort names like xhigh and max", () => {
    const variants = toVariants(["low", "medium", "high", "xhigh", "max"])
    expect(variants.map((v) => v.id as string)).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("no efforts means no variants", () => {
    expect(toVariants(undefined)).toEqual([])
    expect(toVariants([])).toEqual([])
  })
})

describe("buildModels", () => {
  const entry: CatalogEntry = {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    context: 1_000_000,
    efforts: ["low", "high"],
    vision: true,
    cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  }

  test("sets id, modelID, name, and context limit", () => {
    const model = one(buildModels([entry], pid))
    expect(plain(model.id)).toBe("claude-fable-5")
    expect(plain(model.modelID)).toBe("claude-fable-5")
    expect(model.name).toBe("Claude Fable 5")
    expect(model.limit.context).toBe(1_000_000)
  })

  test("carries cache-aware cost per million tokens", () => {
    const model = one(buildModels([entry], pid))
    expect(plain(model.cost)).toEqual([
      { input: 10, output: 50, cache: { read: 1, write: 12.5 } },
    ])
  })

  test("free models carry zero costs", () => {
    const model = one(
      buildModels([{ ...entry, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }], pid),
    )
    expect(plain(model.cost)).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
  })

  test("missing cost data yields no cost tiers rather than a guess", () => {
    const model = one(buildModels([{ ...entry, cost: undefined }], pid))
    expect(model.cost).toEqual([])
  })

  test("efforts become effort variants on the anthropic route", () => {
    const model = one(buildModels([entry], pid))
    expect(plain(model.variants)).toEqual([
      { id: "low", settings: { effort: "low" } },
      { id: "high", settings: { effort: "high" } },
    ])
  })

  test("efforts become reasoningEffort variants on openai routes", () => {
    const model = one(buildModels([{ ...entry, id: "deepseek/deepseek-v4-flash" }], pid))
    expect(plain(model.variants)).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ])
  })

  test("anthropic model overrides package and baseURL for /v1/messages", () => {
    const model = one(buildModels([entry], pid))
    expect(model.package).toBe("@opencode/ai/providers/anthropic")
    expect(plain(model.settings)).toEqual({ baseURL: "https://api.commandcode.ai/provider/v1" })
  })

  test("openai-route model keeps the provider default package", () => {
    const model = one(buildModels([{ ...entry, id: "deepseek/deepseek-v4-flash" }], pid))
    expect(model.package).toBeUndefined()
    expect(model.settings).toBeUndefined()
  })

  test("vision flag adds image to input capabilities", () => {
    const model = one(buildModels([entry], pid))
    expect(model.capabilities.input).toEqual(["text", "image"])
  })

  test("text-only model gets text input only", () => {
    const model = one(buildModels([{ ...entry, vision: false }], pid))
    expect(model.capabilities.input).toEqual(["text"])
  })

  test("default output limit matches the official CLI's max_tokens", () => {
    const model = one(buildModels([{ ...entry, output: undefined }], pid))
    expect(model.limit.output).toBe(64_000)
    const known = one(buildModels([{ ...entry, output: 64 }], pid))
    expect(known.limit.output).toBe(64)
  })
})

describe("mergeCatalog", () => {
  const bundled: CatalogEntry[] = [
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      context: 200_000,
      efforts: ["high"],
      cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
    },
    {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      context: 1_000_000,
    },
  ]

  test("null live list keeps the bundled catalog untouched", () => {
    expect(mergeCatalog(bundled, null)).toEqual(bundled)
  })

  test("live context_length wins for known models", () => {
    const merged = mergeCatalog(bundled, [
      { id: "claude-sonnet-5", context_length: 1_000_000, supported_endpoints: ["/messages"] },
      { id: "deepseek/deepseek-v4-flash", context_length: 1_000_000 },
    ])
    expect(merged.find((m) => m.id === "claude-sonnet-5")?.context).toBe(1_000_000)
  })

  test("bundled metadata (efforts, cost) survives a live refresh", () => {
    const merged = mergeCatalog(bundled, [
      { id: "claude-sonnet-5", context_length: 1_000_000 },
      { id: "deepseek/deepseek-v4-flash" },
    ])
    const claude = merged.find((m) => m.id === "claude-sonnet-5")
    expect(claude?.efforts).toEqual(["high"])
    expect(claude?.cost?.cache_write).toBe(2.5)
  })

  test("brand-new live models are added with live name and context", () => {
    const merged = mergeCatalog(bundled, [
      { id: "claude-sonnet-5" },
      { id: "deepseek/deepseek-v4-flash" },
      { id: "newco/new-model", name: "New Model", context_length: 512_000 },
    ])
    const added = merged.find((m) => m.id === "newco/new-model")
    expect(added).toEqual({
      id: "newco/new-model",
      name: "New Model",
      context: 512_000,
    })
  })

  test("live /messages-only model with a non-claude id routes to the anthropic package", () => {
    const merged = mergeCatalog(bundled, [
      { id: "claude-sonnet-5" },
      { id: "deepseek/deepseek-v4-flash" },
      { id: "newco/claude-compatible", supported_endpoints: ["/messages"] },
    ])
    const model = buildModels(merged, pid).find((m) => (m.id as string) === "newco/claude-compatible")!
    expect(model.package).toBe("@opencode/ai/providers/anthropic")
  })

  test("bundled models missing from the live list are dropped", () => {
    const merged = mergeCatalog(bundled, [{ id: "claude-sonnet-5" }])
    expect(merged.map((m) => m.id)).toEqual(["claude-sonnet-5"])
  })
})
