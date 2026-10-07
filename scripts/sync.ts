/**
 * Regenerate src/catalog.json from the published command-code npm package and
 * the live CommandCode models endpoint. Run: `bun run sync`
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCostMap, parseModelEntries } from "./extract"
import catalogJson from "../src/catalog.json"
import type { CatalogEntry, LiveModel } from "../src/catalog"

const REGISTRY = "https://registry.npmjs.org/command-code/latest"
const LIVE_MODELS = "https://api.commandcode.ai/provider/v1/models"
const OUT_PATH = new URL("../src/catalog.json", import.meta.url).pathname

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return (await res.json()) as T
}

async function downloadTarball(url: string, version: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`tarball -> HTTP ${res.status}`)
  const dir = join(tmpdir(), `oc-commandcode-sync-${version}`)
  mkdirSync(dir, { recursive: true })
  const tgz = join(dir, "command-code.tgz")
  writeFileSync(tgz, new Uint8Array(await res.arrayBuffer()))
  // ponytail: shell out to tar for one-file extraction; Windows contributors run sync under WSL/Git-Bash.
  const out = spawnSync("tar", ["-xzOf", tgz, "package/dist/cli.mjs"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (out.status !== 0 || !out.stdout) throw new Error(`tar extract failed: ${out.stderr}`)
  return out.stdout
}

async function main() {
  const meta = await fetchJson<{ version: string; dist: { tarball: string } }>(REGISTRY)
  console.log(`command-code@${meta.version}`)

  const bundle = await downloadTarball(meta.dist.tarball, meta.version)
  const extracted = parseModelEntries(bundle)
  const costs = parseCostMap(bundle)
  console.log(`extracted ${extracted.length} model entries, ${costs.size} cost entries`)

  const live = (await fetchJson<{ data?: LiveModel[] }>(LIVE_MODELS)).data ?? []
  const liveIds = new Set(live.map((m) => m.id))
  console.log(`live catalog: ${live.length} models`)

  // Probe-derived output caps (scripts/probe-output-limits.ts) are not
  // re-derivable here; carry them forward so sync never wipes probe data.
  const previous = new Map(
    (catalogJson.models as CatalogEntry[]).map((m) => [m.id, m.output]),
  )

  const models: CatalogEntry[] = extracted
    .filter((m) => liveIds.has(m.id))
    .map((m) => {
      const cost = costs.get(m.id) ?? costs.get(`anthropic:${m.id}`)
      const remote = live.find((l) => l.id === m.id)
      const output = m.output ?? previous.get(m.id)
      return {
        id: m.id,
        name: m.name,
        context: remote?.context_length ?? m.context,
        vision: m.vision,
        efforts: m.efforts,
        ...(output ? { output } : {}),
        ...(cost ? { cost } : {}),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const withCost = models.filter((m) => m.cost).length
  const withEfforts = models.filter((m) => m.efforts?.length).length
  console.log(
    `catalog: ${models.length} models, ${withCost} with costs, ${withEfforts} with reasoning efforts`,
  )

  if (models.length < 50) throw new Error(`suspiciously few models (${models.length}); aborting`)
  if (withCost < models.length * 0.8) {
    throw new Error(`cost coverage dropped below 80% (${withCost}/${models.length}); aborting`)
  }

  writeFileSync(
    OUT_PATH,
    // No timestamp: git log records it, and a stable file keeps sync idempotent.
    JSON.stringify({ commandCodeVersion: meta.version, models }, null, 2) + "\n",
  )
  console.log(`wrote ${OUT_PATH}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
