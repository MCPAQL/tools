import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Endpoint } from "./types.js";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function callOfficial(client: Client, opName: string, params: Record<string, unknown>, timeoutMs: number) {
  try {
    const res = await withTimeout(client.callTool({ name: opName, arguments: params }), timeoutMs, `official ${opName}`);
    return { ok: !res.isError, raw: res, error: undefined as string | undefined };
  } catch (e) {
    return { ok: false, raw: null as unknown, error: (e as Error).message };
  }
}

export async function callMcpaql(
  client: Client, endpoint: Endpoint, opName: string, params: Record<string, unknown>, timeoutMs: number,
) {
  const toolName = `mcp_aql_${endpoint}`;
  try {
    const res = await withTimeout(client.callTool({ name: toolName, arguments: { operation: opName, params } }), timeoutMs, `mcpaql ${opName}`);
    let envelope: unknown = null;
    const content = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = content.find((c) => c.type === "text")?.text;
    if (text) {
      try { envelope = JSON.parse(text); } catch { envelope = { success: false, error: { code: "PARSE", message: "non-JSON text" } }; }
    }
    const success = (envelope as { success?: boolean } | null)?.success === true;
    return { ok: success && !res.isError, envelope, error: undefined as string | undefined };
  } catch (e) {
    return { ok: false, envelope: null as unknown, error: (e as Error).message };
  }
}
