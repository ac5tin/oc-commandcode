import { Integration, Plugin, Provider } from "@opencode/plugin"
import catalogJson from "./catalog.json"
import { buildModels, mergeCatalog, type LiveModel } from "./catalog"
import { applyApiKeyAuth } from "./auth"

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

    // The host attaches the integration credential as Authorization: Bearer,
    // which the gateway rejects on the Anthropic /messages route (403). Swap
    // it for x-api-key there; OpenAI-route models keep Bearer.
    await ctx.session.hook(
      "http.request",
      async (event) => {
        try {
          const connection = await ctx.integration.connection.active(PROVIDER_ID)
          const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
          applyApiKeyAuth(event.request.headers, event.request.url, credential)
        } catch {
          // auth bookkeeping must never kill the request; the gateway's own
          // 401/403 error is the better failure surface
        }
      },
      { providerID },
    )

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
