import type { CatalogEntry } from "../src/catalog"

export type ExtractedModel = Pick<
  CatalogEntry,
  "id" | "name" | "context" | "vision" | "efforts" | "output"
>

export interface ExtractedCost {
  input: number
  output: number
  cache_read: number
  cache_write: number
  /** 1h cache-write tier; present only when upstream declares it. */
  cache_write_1h?: number
}

/** Extract the balanced `{...}` object starting at `openIdx`. */
function extractBalanced(source: string, openIdx: number): string {
  let depth = 0
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(openIdx, i + 1)
    }
  }
  return source.slice(openIdx)
}

function parseNumber(raw: string): number {
  return Number.parseFloat(raw)
}

/**
 * Pull model registry entries out of the minified command-code bundle by
 * anchoring on `inputModalities:` and extracting each enclosing object.
 * Field-level regexes keep this robust to minifier key renames.
 */
export function parseModelEntries(source: string): ExtractedModel[] {
  const entries = new Map<string, ExtractedModel>()

  let anchor = source.indexOf("inputModalities:")
  while (anchor !== -1) {
    const open = source.lastIndexOf("{", anchor)
    if (open !== -1) {
      const blob = extractBalanced(source, open)
      const id = blob.match(/[{,]id:"([^"]+)"/)?.[1]
      const name = blob.match(/[{,]name:"((?:[^"\\]|\\.)*)"/)?.[1]
      const context = blob.match(/contextWindow:([\d.]+(?:e\d+)?)/)?.[1]

      if (id && name && context !== undefined) {
        const effortsRaw = blob.match(/reasoningEfforts:\[([^\]]*)\]/)?.[1]
        const efforts = effortsRaw
          ? [...effortsRaw.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
          : undefined
        // Only some registry entries declare an output cap; absence means "CLI default".
        const outputRaw = blob.match(/maxOutputTokens:([\d.]+(?:e\d+)?)/)?.[1]
        const output = outputRaw !== undefined ? parseNumber(outputRaw) : undefined
        const entry: ExtractedModel = {
          id,
          name: name.replaceAll("\\'", "'"),
          context: parseNumber(context),
          vision: blob.includes('"image"'),
          ...(efforts && efforts.length > 0 ? { efforts } : {}),
          ...(output !== undefined && Number.isFinite(output) && output > 0
            ? { output }
            : {}),
        }
        if (!entries.has(id)) entries.set(id, entry)
      }
    }
    anchor = source.indexOf("inputModalities:", anchor + 1)
  }

  return [...entries.values()]
}

/**
 * Walk backward from `from` to the `{` opening the object enclosing it,
 * skipping balanced inner `{...}` pairs.
 */
function findObjectStart(source: string, from: number): number {
  let depth = 0
  for (let i = from; i >= 0; i--) {
    if (source[i] === "}") depth++
    else if (source[i] === "{") {
      if (depth === 0) return i
      depth--
    }
  }
  return -1
}

/** Parse one flat `pricing:{...}` object literal (numeric fields only). */
function parsePricingObject(blob: string): ExtractedCost | undefined {
  let json: Record<string, unknown>
  try {
    const normalized = blob
      .replace(/([{,])([A-Za-z_$][A-Za-z0-9_$]*)(:)/g, (_m, brace: string, key: string, colon: string) => `${brace}"${key}"${colon}`)
      .replace(/:(\s*)\.(\d)/g, (_m, space: string, digit: string) => `:${space}0.${digit}`)
    json = JSON.parse(normalized) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (typeof json.inputCost !== "number") return undefined
  return {
    input: json.inputCost,
    output: typeof json.outputCost === "number" ? json.outputCost : 0,
    cache_read: typeof json.cacheReadCost === "number" ? json.cacheReadCost : 0,
    cache_write: typeof json.cacheWriteCost === "number" ? json.cacheWriteCost : 0,
    ...(typeof json.cacheWrite1hCost === "number" ? { cache_write_1h: json.cacheWrite1hCost } : {}),
  }
}

/**
 * Pull per-model pricing (per-million tokens) out of the bundled live-models
 * dataset: `{catalogVersion:"...",data:[{...,id,pricing:{inputCost,outputCost,
 * cacheReadCost,cacheWriteCost,cacheWrite1hCost?},...}]}` whose entries carry
 * `owned_by:"command-code"`. command-code 1.83 inlined pricing into these
 * entries and deleted the old standalone `{"vendor/model":{inputCost:...}}`
 * map; keys are the plain model ids, so no `anthropic:` prefixes anymore.
 *
 * Tiered `rates` (context-dependent pricing) are ignored — the catalog has
 * only ever modeled base rates.
 *
 * Throws instead of returning an empty map when the dataset is missing or
 * yields nothing: a silent empty map is exactly how the 1.83 restructure
 * produced a 0%-coverage sync.
 */
export function parseCostMap(source: string): Map<string, ExtractedCost> {
  const costs = new Map<string, ExtractedCost>()

  let anchor = source.indexOf('owned_by:"command-code"')
  if (anchor === -1) {
    throw new Error(
      'pricing dataset not found: no `owned_by:"command-code"` entries in the bundle (upstream shape changed again?)',
    )
  }

  while (anchor !== -1) {
    const open = findObjectStart(source, anchor)
    if (open !== -1) {
      const blob = extractBalanced(source, open)
      const id = blob.match(/[{,]id:"([^"]+)"/)?.[1]
      const pricingIdx = blob.indexOf("pricing:{")
      if (id && pricingIdx !== -1) {
        const cost = parsePricingObject(extractBalanced(blob, blob.indexOf("{", pricingIdx)))
        if (cost) costs.set(id, cost)
      }
    }
    anchor = source.indexOf('owned_by:"command-code"', anchor + 1)
  }

  if (costs.size === 0) {
    throw new Error("pricing dataset found but no entry had parseable pricing")
  }
  return costs
}
