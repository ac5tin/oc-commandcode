/**
 * CommandCode's gateway intermittently 403s otherwise-valid requests with
 * `permission_error: "Authentication failed. Please check your credentials."`
 * when they land on its Hong Kong edge — same key, headers and body pass on
 * other edges moments later (CommandCodeAI/command-code#945, #946). A bounded
 * resend usually lands on a healthy edge; it cannot fix a sustained edge
 * outage or a region block, which returns the same body (#930).
 */
const AUTH_FLAKE_MESSAGE = "Authentication failed. Please check your credentials."

/** Minimal slice of a replayable request; the host and Bun declare separate `Request` globals for the same runtime object. */
export interface Replayable {
  clone(): Replayable
}

export interface RetryOptions<Req extends Replayable> {
  /** Resends after the first response. Default 2 (3 attempts total). */
  attempts?: number
  /** Delay before each resend, ms. Default [400, 1200]. */
  delays?: readonly number[]
  fetch?: (input: Req) => Promise<Response>
}

export function isGatewayAuthFlake(status: number, body: string): boolean {
  return status === 403 && body.includes("permission_error") && body.includes(AUTH_FLAKE_MESSAGE)
}

/**
 * Resend `replay` when `response` is the gateway's intermittent auth 403.
 * `replay` must be a clone taken before the original request body was consumed.
 * Returns the first non-flake response, or the last 403 once the bound is hit.
 */
export async function retryAuthFlake<Req extends Replayable>(
  response: Response,
  replay: Req | undefined,
  options: RetryOptions<Req> = {},
): Promise<Response> {
  if (!replay) return response
  const attempts = options.attempts ?? 2
  const delays = options.delays ?? [400, 1200]
  const doFetch =
    options.fetch ?? ((input: Req): Promise<Response> => fetch(input as unknown as Parameters<typeof fetch>[0]))
  let current = response
  for (let retry = 0; retry < attempts; retry++) {
    if (!isGatewayAuthFlake(current.status, await current.clone().text())) return current
    const delay = delays[Math.min(retry, delays.length - 1)] ?? 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    current = await doFetch(replay.clone() as Req)
  }
  return current
}
