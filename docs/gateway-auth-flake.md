# Intermittent 403 "Authentication failed" (gateway auth flake)

## Symptom

Sessions using Command Code models fail at random with:

```
Error: Authentication failed. Please check your credentials.
```

The same prompt, key and model then succeed on retry — sometimes after a few
attempts. Roughly 1 in 10 requests fails, in bursts.

## Root cause — Command Code's gateway, not this plugin

The Provider API intermittently rejects valid requests with `HTTP 403
permission_error` when a request is served by its **Hong Kong (HKG) edge**:

```json
{"type":"error","error":{"type":"permission_error","message":"Authentication failed. Please check your credentials."}}
```

Controlled evidence:

- 2026-10-08, this machine: 15 identical `/provider/v1/messages` requests —
  every success came from `cf-ray …-SIN`/`…-NRT`, both failures came from
  `cf-ray …-HKG`. A failing `opencode` capture showed the same HKG edge.
- [CommandCodeAI/command-code#945](https://github.com/CommandCodeAI/command-code/issues/945)
  (comment, 2026-09-29): controlled reproduction — HKG calls returned the 403
  while NRT/KIX calls succeeded with the same key; the official CLI worked
  immediately after the Provider API 403.
- [CommandCodeAI/command-code#946](https://github.com/CommandCodeAI/command-code/issues/946):
  the identical intermittent 403 reported from another client
  (**pi + pi-commandcode-provider**). 79 occurrences across 5 sessions;
  re-login did not help; the identical request succeeded on manual retry; a
  local 3-retry loop still hit consecutive failures during HKG bursts.

Related, same misleading error surface:

- [#930](https://github.com/CommandCodeAI/command-code/issues/930): region
  restrictions are collapsed into the same auth-shaped 403, while plan gates
  correctly return `MODEL_NOT_IN_PLAN`.
- [#736](https://github.com/CommandCodeAI/command-code/issues/736): the same
  403 is returned for some models the docs say are allowed, reproducible via
  the official CLI.
- [#965](https://github.com/CommandCodeAI/command-code/issues/965): on
  `/provider/v1/responses`, byte-identical bodies intermittently fail with 400
  and succeed on immediate resend — the same class of per-request gateway
  nondeterminism.

What is **not** the cause:

- Plugin wire shaping. Earlier fixes swapped Bearer for `x-api-key` on
  `/messages` and stripped `anthropic-beta` (the gateway's native Claude-5
  path rejects API keys). Failing requests on this machine were already
  correctly shaped — captured on the wire with `x-api-key` present and no
  `anthropic-beta`.
- Multiple OpenCode windows. All instances share one background service, and
  parallel request tests failed at the same rate as sequential ones; more
  windows only increase the chance of a request landing on HKG.

## Our only client-side remedy: a bounded retry

The failure is per-request routing at the gateway, so the only fix available
to a client is to resend. The plugin does this transparently:

- `src/retry.ts` — recognizes exactly this response (`403` +
  `permission_error` + `Authentication failed. Please check your credentials.`)
  and never retries other failures (`MODEL_NOT_IN_PLAN`, `upgrade_required`,
  401s, 5xx).
- `src/index.ts` — on `http.request` it keeps a shaped clone of the request; on
  `http.response`, when the gateway returns this 403, it resends the clone up
  to 2 times (400 ms / 1200 ms backoff) and hands the runtime the first good
  response. It logs `[commandcode] gateway auth flake — re-sent` when it fires.
- A real retry cannot fix every case: sustained HKG bursts can outlast the
  bound (#946) and region-blocked models return the same body, so they simply
  surface the error after the retries (#930).

The durable fix belongs to Command Code: see #945 (inspect the HKG Provider
API route) and #946. Reports with a failing `x-trace-id` and `cf-ray …-HKG`
are useful evidence.
