import { expect, test } from "bun:test"
import { isGatewayAuthFlake, retryAuthFlake } from "../src/retry"

const FLAKE = '{"type":"error","error":{"type":"permission_error","message":"Authentication failed. Please check your credentials."}}'
const NOT_IN_PLAN = '{"error":{"message":"MODEL_NOT_IN_PLAN: Claude Opus 5 available in Pro and above plans","type":"permission_error","code":"FORBIDDEN"}}'
const UPGRADE = '{"error":{"message":"upgrade_required","type":"permission_error"}}'
const URL = "https://api.commandcode.ai/provider/v1/messages"

const flake = () => new Response(FLAKE, { status: 403 })
const ok = () => new Response("ok", { status: 200 })
const replayReq = () => new Request(URL, { method: "POST", body: "{}", headers: { "x-api-key": "k" } })

/** Fake fetch that returns `responses` in order (repeating the last one). */
function tracker(responses: Response[]) {
  const state = { calls: 0 }
  const fetchImpl: (input: ReturnType<typeof replayReq>) => Promise<Response> = async () =>
    responses[Math.min(state.calls++, responses.length - 1)]!
  return { state, fetch: fetchImpl }
}

test("isGatewayAuthFlake: only the gateway's 403 auth body", () => {
  expect(isGatewayAuthFlake(403, FLAKE)).toBe(true)
  expect(isGatewayAuthFlake(403, NOT_IN_PLAN)).toBe(false)
  expect(isGatewayAuthFlake(403, UPGRADE)).toBe(false)
  expect(isGatewayAuthFlake(401, FLAKE)).toBe(false)
  expect(isGatewayAuthFlake(500, FLAKE)).toBe(false)
})

test("non-flake response returns untouched, no extra fetch", async () => {
  const t = tracker([ok()])
  const res = await retryAuthFlake(ok(), replayReq(), { fetch: t.fetch, delays: [0, 0] })
  expect(res.status).toBe(200)
  expect(await res.text()).toBe("ok")
  expect(t.state.calls).toBe(0)
})

test("non-flake 403 (plan gate) is not retried", async () => {
  const t = tracker([ok()])
  const res = await retryAuthFlake(new Response(NOT_IN_PLAN, { status: 403 }), replayReq(), {
    fetch: t.fetch,
    delays: [0, 0],
  })
  expect(res.status).toBe(403)
  expect(t.state.calls).toBe(0)
})

test("flake then success: one retry returns the good response", async () => {
  const t = tracker([ok()])
  const res = await retryAuthFlake(flake(), replayReq(), { fetch: t.fetch, delays: [0, 0] })
  expect(res.status).toBe(200)
  expect(await res.text()).toBe("ok")
  expect(t.state.calls).toBe(1)
})

test("two flakes then success: retries up to the bound", async () => {
  const t = tracker([flake(), ok()])
  const res = await retryAuthFlake(flake(), replayReq(), { fetch: t.fetch, delays: [0, 0] })
  expect(res.status).toBe(200)
  expect(t.state.calls).toBe(2)
})

test("persistent flake: bounded, returns the last 403", async () => {
  const t = tracker([flake()])
  const res = await retryAuthFlake(flake(), replayReq(), { fetch: t.fetch, delays: [0, 0] })
  expect(res.status).toBe(403)
  expect(await res.text()).toBe(FLAKE)
  expect(t.state.calls).toBe(2)
})

test("no stored replay request: response untouched", async () => {
  const t = tracker([ok()])
  const res = await retryAuthFlake(flake(), undefined, { fetch: t.fetch, delays: [0, 0] })
  expect(res.status).toBe(403)
  expect(t.state.calls).toBe(0)
})
