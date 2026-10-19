import { describe, expect, test } from "bun:test"
import { parseCostMap, parseModelEntries } from "../scripts/extract"

// Mirrors the command-code >=1.83 bundle: validator helpers that mention
// `inputCost` come FIRST (they broke the first-anchor parser on 2026-10-19),
// the model registry still uses `contextWindow`, and pricing lives in a
// separate live-models dataset keyed by plain model ids — the old standalone
// `{"vendor/model":{inputCost:...}}` map no longer exists.
const BUNDLE = `
function isRecord(e){return typeof e=="object"&&e!==null}
function isRate(e){return typeof e=="number"&&Number.isFinite(e)&&e>=0}
function isOptionalRate(e){return void 0===e||isRate(e)}
function parseRates(e){if(!isRecord(e))return;const{inputCost:n,outputCost:o,cacheReadCost:r,cacheWriteCost:s,cacheWrite1hCost:a}=e;return isRate(n)&&isRate(o)&&isRate(r)&&isOptionalRate(s)&&isOptionalRate(a)?{inputCost:n,outputCost:o,cacheReadCost:r,...void 0===s?{}:{cacheWriteCost:s},...void 0===a?{}:{cacheWrite1hCost:a}}:void 0}
var fL={SONNET_5_5:{id:"claude-sonnet-5-5",inputModalities:["text","image"],provider:lL,spec:gL,label:"Claude Sonnet 5.5",name:"Claude Sonnet 5.5",description:"best combo of speed & intelligence (recommended)",reasoning:!0,reasoningEfforts:["low","medium","high","xhigh","max"],contextWindow:1e6},KIMI_K2_5:{id:"moonshotai/Kimi-K2.5",inputModalities:["text","image"],provider:mL,spec:gL,label:"Kimi K2.5",name:"Kimi K2.5",description:"multimodal frontend coding",reasoning:!0,reasoningEfforts:["low","medium","high"],contextWindow:262144},FLASH_FAST:{id:"deepseek/deepseek-v4-flash-fast",inputModalities:["text"],provider:nL,spec:gL,label:"DeepSeek V4 Flash Fast",name:"DeepSeek V4 Flash Fast",description:"low-latency",reasoning:!1,contextWindow:1e6}};
var xn={catalogVersion:"d6177bab",data:[{aliases:[],behaviorProfile:"anthropic-prefix-bound-v1",category:"opensource",context_length:1e6,display:{badge:null,description:"best combo of speed & intelligence (recommended)",group:"Anthropic",label:"Claude Sonnet 5.5",notice:null,order:60},id:"claude-sonnet-5-5",inputModalities:["text","image"],maxOutputTokens:null,minimumPlan:"individual-goat",name:"Claude Sonnet 5.5",object:"model",owned_by:"command-code",pricing:{cacheReadCost:.1,cacheWrite1hCost:4,cacheWriteCost:2.5,inputCost:2,outputCost:10},reasoningEfforts:["low","medium","high","xhigh","max"],zdr:!0},{aliases:[],category:"general",context_length:262144,display:{badge:null,description:"multimodal frontend coding",group:"Moonshot",label:"Kimi K2.5",notice:null,order:71},id:"moonshotai/Kimi-K2.5",maxOutputTokens:null,name:"Kimi K2.5",object:"model",owned_by:"command-code",pricing:{cacheReadCost:.03,inputCost:.3,outputCost:1.2},reasoningEfforts:["low","medium","high"],zdr:!0},{aliases:[],category:"general",context_length:1e6,display:{badge:null,description:"low-latency",group:"DeepSeek",label:"DeepSeek V4 Flash Fast",notice:null,order:80},id:"deepseek/deepseek-v4-flash-fast",maxOutputTokens:16384,name:"DeepSeek V4 Flash Fast",object:"model",owned_by:"command-code",reasoningEfforts:null,zdr:!0},{aliases:[],category:"general",context_length:1e6,display:{badge:null,description:"tiered",group:"Example",label:"Tiered Model",notice:null,order:90},id:"example/tiered-model",maxOutputTokens:8192,name:"Tiered Model",object:"model",owned_by:"command-code",pricing:{cacheReadCost:.5,inputCost:2,outputCost:6,rates:[{maxContext:2e5,rates:{cacheReadCost:.5,inputCost:2,outputCost:6}},{rates:{cacheReadCost:1,inputCost:4,outputCost:12}}]},reasoningEfforts:["low","medium","high"],zdr:!1}]};
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

  test("extracts declared maxOutputTokens as the output cap", () => {
    const withCap = BUNDLE.replace(
      'contextWindow:262144}',
      'contextWindow:262144,maxOutputTokens:32768}',
    )
    const entries = parseModelEntries(withCap)
    expect(entries.find((e) => e.id === "moonshotai/Kimi-K2.5")?.output).toBe(32_768)
    // absent field stays absent so the CLI-default fallback applies
    expect(entries.find((e) => e.id === "claude-sonnet-5-5")?.output).toBeUndefined()
  })

  test("parses plain integer context windows", () => {
    const entries = parseModelEntries(BUNDLE)
    expect(entries.find((e) => e.id === "moonshotai/Kimi-K2.5")?.context).toBe(262_144)
  })

  test("ignores live-models dataset entries (context_length, not contextWindow)", () => {
    const entries = parseModelEntries(BUNDLE)
    expect(entries).toHaveLength(3)
    expect(entries.find((e) => e.id === "example/tiered-model")).toBeUndefined()
  })

  test("deduplicates repeated ids", () => {
    const doubled = BUNDLE + BUNDLE
    const entries = parseModelEntries(doubled)
    expect(entries.filter((e) => e.id === "claude-sonnet-5-5")).toHaveLength(1)
  })
})

describe("parseCostMap", () => {
  test("extracts per-million costs keyed by plain model id", () => {
    const costs = parseCostMap(BUNDLE)
    expect(costs.get("claude-sonnet-5-5")).toEqual({
      input: 2,
      output: 10,
      cache_read: 0.1,
      cache_write: 2.5,
      cache_write_1h: 4,
    })
    // The old cost map's `anthropic:`-prefixed keys are gone for good.
    expect([...costs.keys()].every((k) => !k.startsWith("anthropic:"))).toBe(true)
  })

  test("parses leading-dot decimals and omits absent cache tiers", () => {
    const costs = parseCostMap(BUNDLE)
    expect(costs.get("moonshotai/Kimi-K2.5")).toEqual({
      input: 0.3,
      output: 1.2,
      cache_read: 0.03,
      cache_write: 0,
    })
    expect(costs.get("moonshotai/Kimi-K2.5")?.cache_write_1h).toBeUndefined()
  })

  test("entries without pricing contribute no cost", () => {
    const costs = parseCostMap(BUNDLE)
    expect(costs.has("deepseek/deepseek-v4-flash-fast")).toBe(false)
  })

  test("uses base rates and ignores tiered rates", () => {
    const costs = parseCostMap(BUNDLE)
    expect(costs.get("example/tiered-model")).toEqual({
      input: 2,
      output: 6,
      cache_read: 0.5,
      cache_write: 0,
    })
  })

  test("validator helpers mentioning inputCost are not mistaken for pricing", () => {
    // 1.83.0 regression: parseRates destructures `inputCost` and builds a
    // cost-shaped object long before the dataset appears in the bundle.
    const costs = parseCostMap(BUNDLE)
    expect(costs.size).toBe(3)
    expect(new Set(costs.keys())).toEqual(
      new Set(["claude-sonnet-5-5", "moonshotai/Kimi-K2.5", "example/tiered-model"]),
    )
  })

  test("missing dataset throws instead of yielding an empty map", () => {
    expect(() => parseCostMap("")).toThrow(/pricing dataset not found/)
    expect(() => parseCostMap("no dataset here")).toThrow(/pricing dataset not found/)
  })

  test("dataset whose pricing never parses throws", () => {
    const broken = BUNDLE.replace(/inputCost:[\d.]+/g, "inputCost:ref")
    expect(() => parseCostMap(broken)).toThrow(/no entry had parseable pricing/)
  })
})
