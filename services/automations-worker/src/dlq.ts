import { cc } from "./cc-client.js";

// P1.0: transient external failures (rate limits, 5xx, network) go to CC's
// failed_items instead of vanishing in a console.warn. Anything else (bad key,
// 404, our own bugs) stays a log line: retrying wouldn't help.
// Errors are expected to read "<source> <status>…" (job-sources, learning-sources).
export function externalErrorCode(err: unknown): string | null {
  const msg = String((err as Error)?.message ?? err);
  const http = msg.match(/^(\w[\w.-]*) (\d{3})\b/);
  if (http) {
    const status = Number(http[2]);
    return status === 408 || status === 429 || status >= 500 ? `${http[1].toUpperCase()}_${status}` : null;
  }
  const name = (err as Error)?.name;
  return name === "TimeoutError" || name === "AbortError" || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(msg) ? "NETWORK" : null;
}

/** Records the failure if it's a transient external one. Never throws: the DLQ must not break the run. */
export async function recordExternalFailure(input: {
  userId: string; automationId: string; itemType: string; sourceId: string; payload: unknown; err: unknown;
}): Promise<boolean> {
  const errorCode = externalErrorCode(input.err);
  if (!errorCode) return false;
  const { err, ...rest } = input;
  await cc.recordFailedItem({ ...rest, errorCode, errorMessage: String((err as Error)?.message ?? err).slice(0, 500) })
    .catch((e) => console.warn(`[${input.automationId}] dlq write failed`, { err: String(e) }));
  return true;
}
