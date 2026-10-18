import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallTimeouts, Endpoint } from "./types.js";

// Timers fire at once for delays above 2^31 - 1 ms, so "no timeout" is the largest safe delay.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Runs one callTool with the SDK's own deadline: progress notifications reset it, so a long
 * upstream operation that keeps reporting progress is not cut off, and on expiry the SDK
 * cancels the request upstream. maxTotalTimeoutMs aborts the request regardless of progress.
 */
async function withCallOptions<T>(timeouts: CallTimeouts | number, label: string, run: (options: RequestOptions) => Promise<T>): Promise<T> {
  const { timeoutMs, maxTotalTimeoutMs } = typeof timeouts === "number" ? { timeoutMs: timeouts, maxTotalTimeoutMs: undefined } : timeouts;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (maxTotalTimeoutMs !== undefined && maxTotalTimeoutMs > 0) {
    timer = setTimeout(
      () => controller.abort(new Error(`${label} exceeded the max total timeout of ${maxTotalTimeoutMs}ms`)),
      Math.min(maxTotalTimeoutMs, MAX_TIMER_MS),
    );
  }
  try {
    return await run({
      timeout: timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMER_MS) : MAX_TIMER_MS,
      resetTimeoutOnProgress: true,
      // Supplying onprogress makes the SDK send a progress token, so the server reports progress.
      onprogress: () => undefined,
      signal: controller.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function callOfficial(client: Client, opName: string, params: Record<string, unknown>, timeouts: CallTimeouts | number) {
  try {
    const res = await withCallOptions(timeouts, `official ${opName}`, (options) => client.callTool({ name: opName, arguments: params }, undefined, options));
    return { ok: !res.isError, raw: res, error: undefined as string | undefined };
  } catch (e) {
    return { ok: false, raw: null as unknown, error: (e as Error).message };
  }
}

export async function callMcpaql(
  client: Client, endpoint: Endpoint, opName: string, params: Record<string, unknown>, timeouts: CallTimeouts | number,
) {
  const toolName = `mcp_aql_${endpoint}`;
  try {
    const res = await withCallOptions(timeouts, `mcpaql ${opName}`, (options) => client.callTool({ name: toolName, arguments: { operation: opName, params } }, undefined, options));
    let envelope: unknown = null;
    const content = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = content.find((c) => c.type === "text")?.text;
    if (text) {
      try { envelope = JSON.parse(text); } catch { envelope = { success: false, error: { code: "PARSE", message: "non-JSON text" } }; }
    }
    const parsed = envelope as { success?: boolean; data?: { is_error?: boolean } } | null;
    const success = parsed?.success === true;
    const upstreamError = parsed?.data?.is_error === true;
    return { ok: success && !upstreamError && !res.isError, envelope, error: undefined as string | undefined };
  } catch (e) {
    return { ok: false, envelope: null as unknown, error: (e as Error).message };
  }
}
