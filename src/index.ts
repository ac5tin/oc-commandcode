import { Integration, Plugin, Provider } from "@opencode/plugin"
import catalogJson from "./catalog.json"
import { buildModels, mergeCatalog, type LiveModel } from "./catalog"

const PROVIDER_ID = "commandcode"
const OPENAI_PACKAGE = "@opencode/ai/providers/openai-compatible"
const BASE_URL = "https://api.commandcode.ai/provider/v1"
const MODELS_URL = "https://api.commandcode.ai/provider/v1/models"
const REFRESH_MS = 60 * 60 * 1000

async function fetchLiveModels(): Promise<LiveModel[] | null> {
  try {
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: LiveModel[] }
    return data.data && data.data.length > 0 ? data.data : null
  } catch {
    return null
  }
}

export default Plugin.define({
  id: "commandcode",
  async setup(ctx) {
    // /connect → Command Code → paste API key. No env-var auth by design.
    const integrationID = Integration.ID.make(PROVIDER_ID)
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID,
        method: { type: "key", label: "API Key" },
      })
      editor.update(PROVIDER_ID, (integration) => {
        integration.name = "Command Code"
      })
    })

    const providerID = Provider.ID.make(PROVIDER_ID)
    const source = { models: buildModels(catalogJson.models, providerID) }

    await ctx.provider.transform((editor) => {
      if (editor.get(PROVIDER_ID)) return // a user-defined provider block wins
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Command Code",
          activation: "enabled",
          integrationID,
          package: OPENAI_PACKAGE,
          settings: { baseURL: BASE_URL },
        },
        models: source.models,
      })
    })

    const refresh = async () => {
      const live = await fetchLiveModels()
      if (!live) return
      source.models = buildModels(mergeCatalog(catalogJson.models, live), providerID)
      await ctx.provider.reload()
    }

    void refresh().catch((err) => console.error("[commandcode] catalog refresh failed:", err))
    const timer = setInterval(
      () => void refresh().catch((err) => console.error("[commandcode] catalog refresh failed:", err)),
      REFRESH_MS,
    )
    return () => clearInterval(timer)
  },
})
