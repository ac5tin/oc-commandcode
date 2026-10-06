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
- **Protocol routing** — Claude models are served on the Anthropic `/v1/messages` endpoint; everything else uses OpenAI chat completions. The plugin routes each model automatically.
- **Token caching** — per-model cache-read and cache-write rates are bundled so cost tracking bills cached tokens at their real price, and prompt caching itself is applied by OpenCode's provider runtime (Anthropic `cache_control` breakpoints on `/messages`; automatic server-side caching on OpenAI routes).

## Keeping the catalog current

- On startup (and hourly) the plugin fetches the live model list from `https://api.commandcode.ai/provider/v1/models`: new models appear immediately, context windows update, retired models disappear.
- Reasoning efforts and pricing ship in a bundled catalog generated from the published `command-code` npm package; a weekly GitHub Action opens a PR to refresh it. New models show up live right away and gain their effort variants/pricing at the next plugin update.

## Development

```sh
bun install
bun test          # unit tests
bun run typecheck
bun run sync      # regenerate src/catalog.json from command-code + live API
bun run build     # rebuild the .opencode/plugins/oc-commandcode.js bundle (commit this)
```

The committed bundle in `.opencode/plugins/` is what loads at runtime — run `bun run build` after changing `src/` or syncing the catalog. CI fails if the bundle is stale.

## License

MIT
