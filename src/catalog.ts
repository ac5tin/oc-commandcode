import { Model, type Provider } from "@opencode/plugin"
/** One bundled model entry, produced by scripts/sync.ts from the command-code package. */
export interface CatalogEntry {
  id: string
  name: string
  context: number
  output?: number
  vision?: boolean
  efforts?: string[]
  cost?: {
    input: number
    output: number
    cache_read: number
    cache_write: number
  }
}

/** One model from the live CommandCode models endpoint. */
export interface LiveModel {
  id: string
  name?: string
  context_length?: number
  supported_endpoints?: readonly string[]
}

const ANTHROPIC_PACKAGE = "@opencode/ai/providers/anthropic-compatible"
const ANTHROPIC_BASE_URL = "https://api.commandcode.ai/provider"
const usd = Model.Cost.fields.input.make

/** ponytail: 131072 output default matches the CLI's generous reasoning budgets; bundle sets real caps when known. */
const DEFAULT_OUTPUT = 131_072

/**
 * CommandCode serves Claude models only on the Anthropic /v1/messages route and
 * everything else on OpenAI routes. Live `supported_endpoints` is authoritative;
 * the `claude-` prefix covers the bundled catalog when offline.
 */
export function isAnthropicRoute(
  id: string,
  endpoints?: readonly string[],
): boolean {
  if (endpoints && endpoints.length > 0) return endpoints.includes("/messages")
  return id.startsWith("claude-")
}

/** Each reasoning effort becomes a selectable variant: `commandcode/<model>#high`. */
export function toVariants(efforts?: readonly string[]): Model.Variant[] {
  if (!efforts) return []
  return efforts.map((effort) => ({
    id: Model.VariantID.make(effort),
    settings: { reasoningEffort: effort },
  }))
}

export function buildModels(
  entries: readonly CatalogEntry[],
  providerID: Provider.ID,
): Model.Info[] {
  return entries.map((entry) => {
    const base = Model.Info.default(providerID, Model.ID.make(entry.id))
    const anthropic = isAnthropicRoute(entry.id)
    return {
      ...base,
      name: entry.name,
      capabilities: {
        tools: true,
        input: entry.vision ? ["text", "image"] : ["text"],
        output: ["text"],
      },
      variants: toVariants(entry.efforts),
      ...(entry.cost
        ? {
            cost: [
              {
                input: usd(entry.cost.input),
                output: usd(entry.cost.output),
                cache: { read: usd(entry.cost.cache_read), write: usd(entry.cost.cache_write) },
              },
            ],
          }
        : {}),
      limit: {
        ...base.limit,
        context: entry.context,
        output: entry.output ?? DEFAULT_OUTPUT,
      },
      ...(anthropic
        ? { package: ANTHROPIC_PACKAGE, settings: { baseURL: ANTHROPIC_BASE_URL } }
        : {}),
    }
  })
}

/**
 * Fold the live models list into the bundled catalog: live context windows win,
 * unknown live models are added (without efforts/cost until the next sync), and
 * bundled models the API no longer serves are dropped.
 */
export function mergeCatalog(
  bundled: readonly CatalogEntry[],
  live: readonly LiveModel[] | null,
): CatalogEntry[] {
  if (!live) return [...bundled]

  const remaining = new Map(live.map((model) => [model.id, model]))
  const merged: CatalogEntry[] = []

  for (const entry of bundled) {
    const remote = remaining.get(entry.id)
    if (!remote) continue
    remaining.delete(entry.id)
    merged.push(remote.context_length ? { ...entry, context: remote.context_length } : entry)
  }

  for (const remote of remaining.values()) {
    merged.push({
      id: remote.id,
      name: remote.name ?? remote.id.split("/").pop() ?? remote.id,
      context: remote.context_length ?? 200_000,
    })
  }

  return merged
}
