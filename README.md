# oc-commandcode

[Command Code](https://commandcode.ai) provider plugin for [OpenCode](https://opencode.ai) v2. Every Command Code model — Claude, GPT, Gemini, DeepSeek, Kimi, GLM, Qwen, MiniMax, and more — through one `/connect` API key.

## Install

Add to `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["oc-commandcode@git+https://github.com/ac5tin/oc-commandcode.git"]
}
```

## Connect

1. Create an API key in [Studio → API keys](https://commandcode.ai/settings/keys) (API access requires GOAT, Pro, Max, Team, or the Provider plan).
2. Run `/connect` in OpenCode, pick **Command Code**, paste the key. Auth is via `/connect` only — no environment variable.
3. Run `/models` and pick a model, e.g. `commandcode/deepseek/deepseek-v4-flash`.

The provider appears in `/models` after connecting.

## Usage

Select models as `commandcode/<model-id>` with an optional `#effort` variant:

```text
commandcode/claude-sonnet-5#max
commandcode/deepseek/deepseek-v4-flash#high
commandcode/gpt-6-sol
```

- **Thinking effort** — models that support reasoning expose their effort levels as variants (`#low`, `#medium`, `#high`, `#xhigh`, `#max`, and `#off` where offered). Effort levels come from Command Code's own model registry.
- **Protocol routing** — Claude models are served on the Anthropic `/v1/messages` endpoint; everything else uses OpenAI chat completions. The plugin routes each model automatically. Claude models run in "classic Messages" mode: the CommandCode gateway rejects mid-conversation `system`-role messages that Claude 5 models otherwise get, so the plugin pins the protocol to the classic behavior (system history wrapped into user turns) while keeping the real model id on the wire.
- **Token caching** — per-model cache-read and cache-write rates are bundled so cost tracking bills cached tokens at their real price, and prompt caching itself is applied by OpenCode's provider runtime (Anthropic `cache_control` breakpoints on `/messages`; automatic server-side caching on OpenAI routes).

## Keeping the catalog current

- On startup (and hourly) the plugin fetches the live model list from `https://api.commandcode.ai/provider/v1/models`: new models appear immediately, context windows update, retired models disappear.
- Reasoning efforts, pricing, and exact output-token caps ship in a bundled catalog; the flow below refreshes them. New models show up live right away and gain efforts/pricing/caps at the next plugin update.

### Maintenance flow (idempotent)

Run this when CommandCode ships new models or changes limits — rerunning against an unchanged upstream leaves an empty `git diff`:

```sh
bun run sync    # models, names, context, vision, efforts, pricing from the command-code npm bundle + live models list
bun run probe   # exact per-model output caps from the API's own validation errors (needs CMD_API_KEY)
bun test && bunx tsc --noEmit && bun run bundle
git add -A && git commit && git push
opencode plugin update oc-commandcode@git+https://github.com/ac5tin/oc-commandcode.git && opencode service restart
```

`bun run probe` sends `max_tokens: 1000000` with a one-token prompt per model and reads the cap out of the rejection ("max_tokens: 1000000 > 128000 …"). Rejected 400s are not billed; a model that accepts the request completes one tiny generation (fractions of a cent). `bun run probe --all` re-verifies models that already carry a cap. Models whose caps can't be resolved — plan-gated models (403 `MODEL_NOT_IN_PLAN`), upstreams that don't validate `max_tokens`, or transient upstream 5xx — fall back to 64000 output tokens, the same `max_tokens` the official CommandCode CLI sends, and are listed at the end of the probe output so you know what's exact versus fallback.

## Development

```sh
bun install
bun test          # unit tests
bun run typecheck
bun run sync      # regenerate src/catalog.json from command-code + live API
bun run bundle    # rebuild the dist/oc-commandcode.js bundle (commit this)
```

The committed bundle in `dist/` is what loads at runtime — run `bun run bundle` after changing `src/` or syncing the catalog. CI fails if the bundle is stale. (`.opencode/plugins/oc-commandcode.js` in the repo is only a dev-time loader stub for dogfooding; installs load `dist/` via `package.json` `main`, because git-dependency packing strips dot-directories. The bundle script is named `bundle`, not `build`: OpenCode's installer runs `npm install` inside git deps whose package.json declares a `build` script, which fails and breaks the install.)

## License

MIT
