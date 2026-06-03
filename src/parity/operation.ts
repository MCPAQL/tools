import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callMcpaql, callOfficial } from "./calls.js";
import {
  classify,
  extractMcpaqlPayload,
  extractOfficialPayload,
  maskVariantTokens,
  WRITE_VARIANT_NORMALIZE_OPTIONS,
} from "./comparison.js";
import type { Endpoint, OpResult, OperationSpec, VerifyCallResult, VerifySpec } from "./types.js";

export function applyParamMappings(
  obj: Record<string, unknown>,
  mappings: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!mappings || Object.keys(mappings).length === 0) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[mappings[k] ?? k] = v;
  return out;
}

export function resolveUpstreamToolName(
  operationName: string,
  upstreamToolNames: Record<string, string> | undefined,
): string {
  return upstreamToolNames?.[operationName] ?? operationName;
}

export function isExpectedVerifyResult<F>(
  verify: Pick<VerifySpec<F>, "expect" | "isExpected">,
  result: VerifyCallResult,
  fixtures: F,
): boolean {
  if (verify.isExpected) return verify.isExpected(result, fixtures);
  return verify.expect === "error" ? !result.ok : result.ok;
}

export async function runOperation<F>(
  spec: OperationSpec<F>,
  endpoint: Endpoint,
  fixtures: F,
  official: Client,
  mcpaql: Client,
  upstreamToolNames: Record<string, string>,
  mapping: Record<string, string> | undefined,
  allMappings: Record<string, Record<string, string>>,
  timeoutMs: number,
): Promise<OpResult> {
  const cat = spec.category;
  if (cat === "SKIP") return { name: spec.name, endpoint, category: cat, cls: "SKIPPED", ms: 0 };

  const upstreamToolName = resolveUpstreamToolName(spec.name, upstreamToolNames);

  if (cat === "PURE_READ" || cat === "PUBLIC_READ" || cat === "TEST_REPO_READ" || cat === "ORG_READ") {
    const argsOff = spec.args(fixtures, "official");
    const argsMcp = spec.args(fixtures, "mcpaql");
    if (!argsOff || !argsMcp) return { name: spec.name, endpoint, category: cat, cls: "SKIPPED", detail: "missing fixture", ms: 0 };
    const [off, mcp] = await Promise.all([
      callOfficial(official, upstreamToolName, applyParamMappings(argsOff, mapping), timeoutMs),
      callMcpaql(mcpaql, endpoint, spec.name, argsMcp, timeoutMs),
    ]);
    const offP = extractOfficialPayload(off.raw);
    const mcpP = extractMcpaqlPayload(mcp.envelope);
    const { cls, detail } = classify(off.ok, mcp.ok, offP, mcpP);
    return { name: spec.name, endpoint, category: cat, cls, detail, ms: 0, officialOk: off.ok, mcpaqlOk: mcp.ok };
  }

  if (cat === "PAIRED_WRITE" || cat === "COPILOT") {
    const argsOff = spec.args(fixtures, "official");
    const argsMcp = spec.args(fixtures, "mcpaql");
    if (!argsOff || !argsMcp) return { name: spec.name, endpoint, category: cat, cls: "SKIPPED", detail: "missing fixture", ms: 0 };
    const off = await callOfficial(official, upstreamToolName, applyParamMappings(argsOff, mapping), timeoutMs);
    const mcp = await callMcpaql(mcpaql, endpoint, spec.name, argsMcp, timeoutMs);
    const offP = extractOfficialPayload(off.raw);
    const mcpP = extractMcpaqlPayload(mcp.envelope);
    const offM = maskVariantTokens(offP), mcpM = maskVariantTokens(mcpP);
    const { cls, detail } = classify(off.ok, mcp.ok, offM, mcpM, WRITE_VARIANT_NORMALIZE_OPTIONS);
    return { name: spec.name, endpoint, category: cat, cls, detail, ms: 0, officialOk: off.ok, mcpaqlOk: mcp.ok };
  }

  if (cat === "ONESHOT_WRITE") {
    const argsMcp = spec.args(fixtures, "mcpaql");
    if (!argsMcp) return { name: spec.name, endpoint, category: cat, cls: "SKIPPED", detail: "missing fixture", ms: 0 };
    const mcp = await callMcpaql(mcpaql, endpoint, spec.name, argsMcp, timeoutMs);
    const mcpP = extractMcpaqlPayload(mcp.envelope);
    if (!mcp.ok) return { name: spec.name, endpoint, category: cat, cls: "MCPAQL_ERROR", detail: (JSON.stringify(mcpP) ?? "<undefined>").slice(0, 200), ms: 0, mcpaqlOk: false };
    if (spec.verify) {
      const vArgs = spec.verify.args(fixtures, "official");
      if (vArgs) {
        const verifyUpstreamToolName = resolveUpstreamToolName(spec.verify.name, upstreamToolNames);
        const v = await callOfficial(official, verifyUpstreamToolName, applyParamMappings(vArgs, allMappings[spec.verify.name]), timeoutMs);
        const verifyResult: VerifyCallResult = {
          ok: v.ok,
          raw: v.raw,
          payload: extractOfficialPayload(v.raw),
          error: v.error,
        };
        const verified = isExpectedVerifyResult(spec.verify, verifyResult, fixtures);
        const expectation = spec.verify.isExpected ? "predicate" : (spec.verify.expect ?? "success");
        return {
          name: spec.name,
          endpoint,
          category: cat,
          cls: verified ? "STRUCTURAL_PARITY" : "MCPAQL_ERROR",
          detail: verified ? `verified via ${spec.verify.name} (${expectation})` : `verify call did not match expected ${expectation}${v.error ? `: ${v.error}` : ""}`,
          ms: 0,
          officialOk: v.ok,
          mcpaqlOk: true,
        };
      }
    }
    return { name: spec.name, endpoint, category: cat, cls: "UNVERIFIED_WRITE", detail: "no verify configured", ms: 0, mcpaqlOk: true };
  }

  return { name: spec.name, endpoint, category: cat, cls: "SKIPPED", detail: "unhandled category", ms: 0 };
}
