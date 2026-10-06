import { describe, expect, test } from "bun:test"
import { parseCostMap, parseModelEntries } from "../scripts/extract"

const BUNDLE = `
var gL="chatComplete",hL="responses",fL={SONNET_5_5:{id:"claude-sonnet-5-5",inputModalities:["text","image"],provider:lL,spec:gL,label:"Claude Sonnet 5.5",name:"Claude Sonnet 5.5",description:"best combo of speed & intelligence (recommended)",reasoning:!0,reasoningEfforts:["low","medium","high","xhigh","max"],contextWindow:1e6},KIMI_K2_5:{id:"moonshotai/Kimi-K2.5",inputModalities:["text","image"],provider:mL,spec:gL,label:"Kimi K2.5",name:"Kimi K2.5",description:"multimodal frontend coding",reasoning:!0,reasoningEfforts:["low","medium","high"],contextWindow:262144},FLASH_FAST:{id:"deepseek/deepseek-v4-flash-fast",inputModalities:["text"],provider:nL,spec:gL,label:"DeepSeek V4 Flash Fast",name:"DeepSeek V4 Flash Fast",description:"low-latency",reasoning:!1,contextWindow:1e6}};
var iL={"MiniMaxAI/MiniMax-M2.5":{inputCost:.3,outputCost:1.2,cacheReadCost:.03},"anthropic:claude-fable-5":{inputCost:10,outputCost:50,cacheReadCost:1,cacheWriteCost:12.5,cacheWrite1hCost:20},"Qwen/Qwen3.7-Flash":{inputCost:.03,outputCost:.13,cacheReadCost:.006,cacheWriteCost:.038}};
`

describe("parseModelEntries", () => {
  test("extracts id, name, context window, and efforts", () => {
    const entries = parseModelEntries(BUNDLE)
    const claude = entries.find((e) => e.id === "claude-sonnet-5-5")
    expect(claude).toEqual({
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      context: 1_000_000,
      vision: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    })
  })

  test("handles text-only non-reasoning models", () => {
    const entries = parseModelEntries(BUNDLE)
    const fast = entries.find((e) => e.id === "deepseek/deepseek-v4-flash-fast")
    expect(fast?.vision).toBe(false)
    expect(fast?.efforts).toBeUndefined()
    expect(fast?.context).toBe(1_000_000)
  })

  test("parses plain integer context windows", () => {
    const entries = parseModelEntries(BUNDLE)
    expect(entries.find((e) => e.id === "moonshotai/Kimi-K2.5")?.context).toBe(262_144)
  })

  test("deduplicates repeated ids", () => {
    const doubled = BUNDLE + BUNDLE
    const entries = parseModelEntries(doubled)
    expect(entries.filter((e) => e.id === "claude-sonnet-5-5")).toHaveLength(1)
  })
})

describe("parseCostMap", () => {
  test("extracts per-million costs including cache read and write", () => {
    const costs = parseCostMap(BUNDLE)
    expect(costs.get("anthropic:claude-fable-5")).toEqual({
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
    })
  })

  test("parses leading-dot decimal numbers", () => {
    const costs = parseCostMap(BUNDLE)
    expect(costs.get("MiniMaxAI/MiniMax-M2.5")).toEqual({
      input: 0.3,
      output: 1.2,
      cache_read: 0.03,
      cache_write: 0,
    })
    expect(costs.get("Qwen/Qwen3.7-Flash")?.cache_write).toBe(0.038)
  })

  test("missing bundle source yields an empty map", () => {
    expect(parseCostMap("").size).toBe(0)
    expect(parseCostMap("no cost data here").size).toBe(0)
  })
})
