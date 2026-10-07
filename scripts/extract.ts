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
 * Pull the per-model cost map (input/output/cache-read/cache-write per million
 * tokens) out of the bundle. Claude keys arrive `anthropic:`-prefixed.
 */
export function parseCostMap(source: string): Map<string, ExtractedCost> {
  const costs = new Map<string, ExtractedCost>()
  const anchor = source.indexOf("inputCost:")
  if (anchor === -1) return costs

  const entryOpen = source.lastIndexOf("{", anchor)
  const mapOpen = entryOpen === -1 ? -1 : source.lastIndexOf("{", entryOpen - 1)
  if (mapOpen === -1) return costs

  const blob = extractBalanced(source, mapOpen)
  if (!blob.includes("inputCost:")) return costs

  let json: Record<string, Record<string, number>>
  try {
    const normalized = blob
      .replace(/([{,])([A-Za-z_$][A-Za-z0-9_$]*)(:)/g, (_m, brace: string, key: string, colon: string) => `${brace}"${key}"${colon}`)
      .replace(/:(\s*)\.(\d)/g, (_m, space: string, digit: string) => `:${space}0.${digit}`)
    json = JSON.parse(normalized) as typeof json
  } catch {
    return costs
  }

  for (const [id, raw] of Object.entries(json)) {
    if (typeof raw?.inputCost !== "number") continue
    costs.set(id, {
      input: raw.inputCost,
      output: typeof raw.outputCost === "number" ? raw.outputCost : 0,
      cache_read: typeof raw.cacheReadCost === "number" ? raw.cacheReadCost : 0,
      cache_write: typeof raw.cacheWriteCost === "number" ? raw.cacheWriteCost : 0,
    })
  }
  return costs
}
