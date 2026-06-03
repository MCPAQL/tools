// Generic parity runner: dual-call an MCP-AQL adapter and its upstream MCP server,
// classify response equivalence per operation, write a structured report.
//
// Adapter-agnostic. Consumers provide a Suite that describes:
//   - how to connect to upstream
//   - how to build and tear down test fixtures
//   - per-operation argument builders (typed against the suite's fixtures shape)
//
// The runner reads the operations list from the adapter's bundled schema.json,
// so any operation the adapter exposes that the suite doesn't cover surfaces
// as SKIPPED: "no suite arg builder" — the harness cannot silently hide gaps.

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ─── Public types ───────────────────────────────────────────────────────────

export type Endpoint = "read" | "create" | "update" | "delete" | "execute";

export type Category =
  | "PURE_READ"
  | "PUBLIC_READ"
  | "TEST_REPO_READ"   // historical name; semantically "scoped read against a setup-managed resource"
  | "PAIRED_WRITE"
  | "ONESHOT_WRITE"
  | "ORG_READ"
  | "COPILOT"          // historical name; semantically "third-party-entitlement-dependent"
  | "SKIP";

export type ParityClass =
  | "IDENTICAL"
  | "STRUCTURAL_PARITY"
  | "UNVERIFIED_WRITE"
  | "DIVERGENT"
  | "OFFICIAL_ERROR"
  | "MCPAQL_ERROR"
  | "BOTH_ERROR"
  | "SKIPPED";

export type ArgBuilder<F> = (
  fixtures: F,
  variant: "official" | "mcpaql",
) => Record<string, unknown> | null;

export interface OperationSpec<F> {
  /** The operation name as it appears in the adapter's schema. */
  name: string;
  /** Category drives the dual-call strategy and response comparison. */
  category: Category;
  /** Build arguments for the given variant; return null to skip this variant. */
  args: ArgBuilder<F>;
  /** For ONESHOT_WRITE: an op to call afterward to verify the mutation took effect. */
  verify?: { name: string; args: ArgBuilder<F> };
  /** Human-readable note explaining a SKIP or unusual semantic. */
  note?: string;
}

export interface Suite<F> {
  /** A human-readable identifier for this suite (e.g., "github-mcp"). */
  name: string;
  /** Upstream MCP server URL. */
  upstreamUrl: string;
  /** Optional extra headers to send on every upstream request (e.g., toolset selectors). */
  upstreamHeaders?: Record<string, string>;
  /** Env var name holding the bearer token. */
  tokenEnv: string;
  /** Operations declared by the suite. */
  operations: Array<OperationSpec<F>>;
  /** Create fixtures (test repos, paired records, etc.) before the run. */
  setupFixtures(): Promise<F>;
  /** Clean up after the run. */
  teardownFixtures(fixtures: F): Promise<void>;
}

export interface RunOptions<F = Record<string, unknown>> {
  adapterServerJs: string;
  /** Optional override for the adapter's bundled schema.json path. Defaults to the server file's directory. */
  schemaPath?: string;
  /** Optional override for provenance.json. Defaults to the server file's directory. */
  provenancePath?: string;
  /** Optional override for adapter process cwd. Defaults to adapter root when server is under dist/. */
  adapterCwd?: string;
  reportPath: string;
  /** If set, label written into the report; useful when running the same suite twice. */
  label?: string;
  /** Per-operation call timeout. Defaults to 30 seconds. Set <= 0 to disable. */
  timeoutMs?: number;
  /** If set, skip teardown — useful for debugging. Caller is responsible for cleanup. */
  skipTeardown?: boolean;
  /** If set, reuse these fixtures instead of calling setupFixtures (object or path to JSON file). */
  reuseFixtures?: F | string;
}

export interface OpResult {
  name: string;
  endpoint: string;
  category: Category | string;
  cls: ParityClass;
  detail?: string;
  ms: number;
  officialOk?: boolean;
  mcpaqlOk?: boolean;
  note?: string;
}

export interface RunReport {
  suite: string;
  startedAt: string;
  finishedAt: string;
  adapterPath: string;
  label?: string;
  upstreamUrl: string;
  totals: Record<string, number>;
  ops: OpResult[];
}

// ─── Internal helpers ───────────────────────────────────────────────────────

interface AdapterSchema {
  operations: Record<string, Array<{ name: string }>>;
  headers?: Record<string, string>;
}

interface AdapterProvenance {
  operations: Array<{ operation_name: string; param_mappings?: Record<string, string> }>;
}

export interface ResolvedAdapterPaths {
  schemaPath: string;
  provenancePath: string;
  adapterCwd: string;
}

const ENDPOINTS: readonly Endpoint[] = ["read", "create", "update", "delete", "execute"];
const DEFAULT_TIMEOUT_MS = 30_000;

function isEndpoint(value: string): value is Endpoint {
  return (ENDPOINTS as readonly string[]).includes(value);
}

function endpointFromSchemaKey(value: string): Endpoint {
  const endpoint = value.toLowerCase();
  if (!isEndpoint(endpoint)) {
    throw new Error(`Adapter schema contains unsupported endpoint "${value}". Expected one of: ${ENDPOINTS.join(", ")}.`);
  }
  return endpoint;
}

export function resolveAdapterPaths(options: Pick<RunOptions<unknown>, "adapterServerJs" | "schemaPath" | "provenancePath" | "adapterCwd">): ResolvedAdapterPaths {
  const serverDir = dirname(options.adapterServerJs);
  return {
    schemaPath: options.schemaPath ?? join(serverDir, "schema.json"),
    provenancePath: options.provenancePath ?? join(serverDir, "provenance.json"),
    adapterCwd: options.adapterCwd ?? (basename(serverDir) === "dist" ? dirname(serverDir) : serverDir),
  };
}

const VOLATILE_KEY_PATTERNS = [
  /(^|_)id$/i, /^node_id$/i, /(^|_)url$/i, /^etag$/i, /^sha$/i,
  /^htmlUrl$/i, /^html_url$/i,
  /^created_at$/i, /^updated_at$/i, /^pushed_at$/i, /^merged_at$/i, /^closed_at$/i, /^last_modified$/i,
  /^date$/i, /^number$/i, /^size$/i,
  /^x-github-/i, /^request_id$/i,
];

function isVolatileKey(key: string): boolean {
  return VOLATILE_KEY_PATTERNS.some((rx) => rx.test(key));
}

export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isVolatileKey(k) ? "<VOL>" : normalize(v);
    }
    return out;
  }
  return value;
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

export function maskVariantTokens(value: unknown): unknown {
  const maskStr = (s: string) => s.replace(/\b(official|mcpaql)\b/g, "<VARIANT>");
  if (typeof value === "string") return maskStr(value);
  if (Array.isArray(value)) return value.map(maskVariantTokens);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[maskStr(k)] = maskVariantTokens(v);
    return out;
  }
  return value;
}

export function applyParamMappings(
  obj: Record<string, unknown>,
  mappings: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!mappings || Object.keys(mappings).length === 0) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[mappings[k] ?? k] = v;
  return out;
}

export function extractOfficialPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
  if (r.structuredContent) return r.structuredContent;
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (text) { try { return JSON.parse(text); } catch { return text; } }
  return raw;
}

export function extractMcpaqlPayload(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== "object") return envelope;
  const e = envelope as { success?: boolean; data?: unknown; error?: unknown };
  if (!e.success) return { error: e.error };
  const data = e.data as { content?: Array<{ type: string; text?: string }>; structured_content?: unknown; is_error?: boolean } | undefined;
  if (data?.is_error) {
    const msg = data.content?.find((c) => c.type === "text")?.text ?? "<upstream error>";
    return { error: { code: "UPSTREAM", message: msg } };
  }
  if (data?.structured_content) return data.structured_content;
  const text = data?.content?.find((c) => c.type === "text")?.text;
  if (text) { try { return JSON.parse(text); } catch { return text; } }
  return e.data;
}

export function classify(
  officialOk: boolean, mcpaqlOk: boolean,
  officialPayload: unknown, mcpaqlPayload: unknown,
): { cls: ParityClass; detail?: string } {
  const safe = (x: unknown) => (JSON.stringify(canonicalize(x)) ?? "<undefined>").slice(0, 200);
  if (!officialOk && !mcpaqlOk) return { cls: "BOTH_ERROR", detail: `official: ${safe(officialPayload)} | mcpaql: ${safe(mcpaqlPayload)}` };
  if (!officialOk && mcpaqlOk) return { cls: "OFFICIAL_ERROR", detail: safe(officialPayload) };
  if (officialOk && !mcpaqlOk) return { cls: "MCPAQL_ERROR", detail: safe(mcpaqlPayload) };
  const offRaw = JSON.stringify(canonicalize(officialPayload)) ?? "<undefined>";
  const mcpRaw = JSON.stringify(canonicalize(mcpaqlPayload)) ?? "<undefined>";
  if (offRaw === mcpRaw) return { cls: "IDENTICAL" };
  const offNorm = JSON.stringify(canonicalize(normalize(officialPayload)));
  const mcpNorm = JSON.stringify(canonicalize(normalize(mcpaqlPayload)));
  if (offNorm === mcpNorm) return { cls: "STRUCTURAL_PARITY" };
  return { cls: "DIVERGENT", detail: firstDiff(normalize(officialPayload), normalize(mcpaqlPayload), "") };
}

export function firstDiff(a: unknown, b: unknown, path = ""): string {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path || "root"}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return "";
  }
  if (a && typeof a === "object" && b && typeof b === "object") {
    const ak = Object.keys(a as object).sort(), bk = Object.keys(b as object).sort();
    if (ak.join(",") !== bk.join(",")) {
      const onlyA = ak.filter((k) => !bk.includes(k)), onlyB = bk.filter((k) => !ak.includes(k));
      return `${path || "root"}: keys differ (only-official: ${onlyA.join(",")} | only-mcpaql: ${onlyB.join(",")})`;
    }
    for (const k of ak) {
      const childPath = path ? `${path}.${k}` : k;
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], childPath);
      if (d) return d;
    }
    return "";
  }
  if (a !== b) return `${path || "root"}: ${(JSON.stringify(a) ?? "").slice(0, 60)} vs ${(JSON.stringify(b) ?? "").slice(0, 60)}`;
  return "";
}

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

async function callOfficial(client: Client, opName: string, params: Record<string, unknown>, timeoutMs: number) {
  try {
    const res = await withTimeout(client.callTool({ name: opName, arguments: params }), timeoutMs, `official ${opName}`);
    return { ok: !res.isError, raw: res, error: undefined as string | undefined };
  } catch (e) {
    return { ok: false, raw: null as unknown, error: (e as Error).message };
  }
}

async function callMcpaql(
  client: Client, endpoint: Endpoint, opName: string, params: Record<string, unknown>, timeoutMs: number,
) {
  const toolName = `mcp_aql_${endpoint}`;
  try {
    const res = await withTimeout(client.callTool({ name: toolName, arguments: { operation: opName, params } }), timeoutMs, `mcpaql ${opName}`);
    let envelope: unknown = null;
    const content = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = content.find((c) => c.type === "text")?.text;
    if (text) { try { envelope = JSON.parse(text); } catch { envelope = { success: false, error: { code: "PARSE", message: "non-JSON text" } }; } }
    const success = (envelope as { success?: boolean } | null)?.success === true;
    return { ok: success && !res.isError, envelope, error: undefined as string | undefined };
  } catch (e) {
    return { ok: false, envelope: null as unknown, error: (e as Error).message };
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function runParitySuite<F>(
  suite: Suite<F>,
  options: RunOptions<F>,
): Promise<RunReport> {
  const token = process.env[suite.tokenEnv];
  if (!token) throw new Error(`Token env var "${suite.tokenEnv}" not set.`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const adapterPaths = resolveAdapterPaths(options);

  // Load adapter schema (operations list) and provenance (param mappings).
  const schema = JSON.parse(await readFile(adapterPaths.schemaPath, "utf8")) as AdapterSchema;
  const paramMappings: Record<string, Record<string, string>> = {};
  try {
    const prov = JSON.parse(await readFile(adapterPaths.provenancePath, "utf8")) as AdapterProvenance;
    for (const op of prov.operations) if (op.param_mappings) paramMappings[op.operation_name] = op.param_mappings;
  } catch { /* provenance optional */ }

  // The adapter's bundled schema may carry headers captured at discovery time
  // (e.g., X-MCP-Toolsets). Merge with any suite-supplied headers — schema
  // headers take precedence (captured-at-discovery is authoritative), but
  // suite-supplied headers are not silently dropped when both exist.
  const officialExtraHeaders: Record<string, string> = {
    ...(suite.upstreamHeaders ?? {}),
    ...(schema.headers ?? {}),
  };
  warnOnHeaderOverrides(suite.name, suite.tokenEnv, suite.upstreamHeaders ?? {}, schema.headers ?? {}, officialExtraHeaders);

  // Build the full op list from the adapter schema.
  const adapterOps: Array<{ name: string; endpoint: Endpoint }> = [];
  for (const [endpoint, ops] of Object.entries(schema.operations)) {
    const parsedEndpoint = endpointFromSchemaKey(endpoint);
    for (const op of ops) adapterOps.push({ name: op.name, endpoint: parsedEndpoint });
  }
  const opSpecs = new Map(suite.operations.map((o) => [o.name, o]));

  console.log(`[${suite.name}] adapter exposes ${adapterOps.length} ops; suite has builders for ${opSpecs.size}`);
  if (Object.keys(officialExtraHeaders).length > 0) console.log(`[${suite.name}] forwarding extra headers to official:`, Object.keys(officialExtraHeaders).join(", "));

  // Fixtures: setup or reuse
  let fixtures: F;
  if (options.reuseFixtures && typeof options.reuseFixtures === "string") {
    fixtures = JSON.parse(await readFile(options.reuseFixtures, "utf8")) as F;
    console.log(`[${suite.name}] reusing fixtures from ${options.reuseFixtures}`);
  } else if (options.reuseFixtures) {
    fixtures = options.reuseFixtures as F;
  } else {
    fixtures = await suite.setupFixtures();
  }

  // Build transports + Client instances. Connect happens inside the try block
  // below so that cleanup (close clients + teardown fixtures) runs even when a
  // connect call throws after fixtures were already set up.
  const officialTransport = new StreamableHTTPClientTransport(new URL(suite.upstreamUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...officialExtraHeaders } },
  });
  const official = new Client({ name: "parity-official", version: "0.1.0" });

  const mcpaqlTransport = new StdioClientTransport({
    command: "node",
    args: [options.adapterServerJs],
    cwd: adapterPaths.adapterCwd,
    env: { ...process.env, [suite.tokenEnv]: token } as Record<string, string>,
    stderr: "inherit",
  });
  const mcpaql = new Client({ name: "parity-mcpaql", version: "0.1.0" });

  const ops: OpResult[] = [];
  const totals: Record<string, number> = { TOTAL: 0 };
  const startedAt = new Date().toISOString();
  let officialConnected = false;
  let mcpaqlConnected = false;

  try {
    await official.connect(officialTransport);
    officialConnected = true;
    await mcpaql.connect(mcpaqlTransport);
    mcpaqlConnected = true;

    for (const adapterOp of adapterOps) {
      const t0 = Date.now();
      const spec = opSpecs.get(adapterOp.name);
      let result: OpResult;
      if (!spec) {
        result = { name: adapterOp.name, endpoint: adapterOp.endpoint, category: "SKIP", cls: "SKIPPED", detail: "no suite arg builder", ms: 0 };
      } else {
        try {
          result = await runOperation(spec, adapterOp.endpoint, fixtures, official, mcpaql, paramMappings[spec.name], paramMappings, timeoutMs);
        } catch (e) {
          result = { name: spec.name, endpoint: adapterOp.endpoint, category: spec.category, cls: "MCPAQL_ERROR", detail: `harness exception: ${(e as Error).message}`, ms: 0 };
        }
        if (spec.note) result.note = spec.note;
      }
      result.ms = Date.now() - t0;
      ops.push(result);
      totals[result.cls] = (totals[result.cls] ?? 0) + 1; totals.TOTAL++;
      console.log(`  ${pad(adapterOp.name, 44)} ${pad(result.category, 18)} -> ${result.cls}${result.detail ? " :: " + result.detail.slice(0, 80) : ""}`);
    }
  } finally {
    // Only close clients that actually connected — calling close() on an
    // unconnected Client throws on some transports.
    await Promise.allSettled([
      officialConnected ? official.close() : Promise.resolve(),
      mcpaqlConnected ? mcpaql.close() : Promise.resolve(),
    ]);
    if (!options.skipTeardown && !options.reuseFixtures) {
      try { await suite.teardownFixtures(fixtures); } catch (e) { console.error(`[${suite.name}] teardown failed:`, (e as Error).message); }
    }
  }

  const report: RunReport = {
    suite: suite.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    adapterPath: options.adapterServerJs,
    label: options.label,
    upstreamUrl: suite.upstreamUrl,
    totals,
    ops,
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(options.reportPath, JSON.stringify(report, null, 2));
  console.log(`[${suite.name}] report:`, options.reportPath);
  console.log(`[${suite.name}] totals:`, totals);
  return report;
}

function warnOnHeaderOverrides(
  suiteName: string,
  tokenEnv: string,
  suiteHeaders: Record<string, string>,
  schemaHeaders: Record<string, string>,
  mergedHeaders: Record<string, string>,
): void {
  const suiteHeaderKeys = new Map(Object.keys(suiteHeaders).map((key) => [key.toLowerCase(), key]));
  for (const schemaKey of Object.keys(schemaHeaders)) {
    const suiteKey = suiteHeaderKeys.get(schemaKey.toLowerCase());
    if (suiteKey) {
      console.warn(`[${suiteName}] schema header overrides suite header: ${suiteKey}`);
    }
  }
  const authOverride = Object.keys(mergedHeaders).find((key) => key.toLowerCase() === "authorization");
  if (authOverride) {
    console.warn(`[${suiteName}] extra header "${authOverride}" overrides the Authorization header derived from ${tokenEnv}`);
  }
}

async function runOperation<F>(
  spec: OperationSpec<F>,
  endpoint: Endpoint,
  fixtures: F,
  official: Client,
  mcpaql: Client,
  mapping: Record<string, string> | undefined,
  allMappings: Record<string, Record<string, string>>,
  timeoutMs: number,
): Promise<OpResult> {
  const cat = spec.category;
  if (cat === "SKIP") return { name: spec.name, endpoint, category: cat, cls: "SKIPPED", ms: 0 };

  const argsOff = spec.args(fixtures, "official");
  const argsMcp = spec.args(fixtures, "mcpaql");

  if (cat === "PURE_READ" || cat === "PUBLIC_READ" || cat === "TEST_REPO_READ" || cat === "ORG_READ") {
    if (!argsOff || !argsMcp) return { name: spec.name, endpoint, category: cat, cls: "SKIPPED", detail: "missing fixture", ms: 0 };
    const [off, mcp] = await Promise.all([
      callOfficial(official, spec.name, applyParamMappings(argsOff, mapping), timeoutMs),
      callMcpaql(mcpaql, endpoint, spec.name, argsMcp, timeoutMs),
    ]);
    const offP = extractOfficialPayload(off.raw);
    const mcpP = extractMcpaqlPayload(mcp.envelope);
    const { cls, detail } = classify(off.ok, mcp.ok, offP, mcpP);
    return { name: spec.name, endpoint, category: cat, cls, detail, ms: 0, officialOk: off.ok, mcpaqlOk: mcp.ok };
  }

  if (cat === "PAIRED_WRITE" || cat === "COPILOT") {
    if (!argsOff || !argsMcp) return { name: spec.name, endpoint, category: cat, cls: "SKIPPED", detail: "missing fixture", ms: 0 };
    const off = await callOfficial(official, spec.name, applyParamMappings(argsOff, mapping), timeoutMs);
    const mcp = await callMcpaql(mcpaql, endpoint, spec.name, argsMcp, timeoutMs);
    const offP = extractOfficialPayload(off.raw);
    const mcpP = extractMcpaqlPayload(mcp.envelope);
    const offM = maskVariantTokens(offP), mcpM = maskVariantTokens(mcpP);
    const { cls, detail } = classify(off.ok, mcp.ok, offM, mcpM);
    return { name: spec.name, endpoint, category: cat, cls, detail, ms: 0, officialOk: off.ok, mcpaqlOk: mcp.ok };
  }

  if (cat === "ONESHOT_WRITE") {
    if (!argsMcp) return { name: spec.name, endpoint, category: cat, cls: "SKIPPED", detail: "missing fixture", ms: 0 };
    const mcp = await callMcpaql(mcpaql, endpoint, spec.name, argsMcp, timeoutMs);
    const mcpP = extractMcpaqlPayload(mcp.envelope);
    if (!mcp.ok) return { name: spec.name, endpoint, category: cat, cls: "MCPAQL_ERROR", detail: (JSON.stringify(mcpP) ?? "<undefined>").slice(0, 200), ms: 0, mcpaqlOk: false };
    if (spec.verify) {
      const vArgs = spec.verify.args(fixtures, "official");
      if (vArgs) {
        const v = await callOfficial(official, spec.verify.name, applyParamMappings(vArgs, allMappings[spec.verify.name]), timeoutMs);
        return { name: spec.name, endpoint, category: cat, cls: v.ok ? "STRUCTURAL_PARITY" : "MCPAQL_ERROR", detail: v.ok ? `verified via ${spec.verify.name}` : "verify call failed", ms: 0, mcpaqlOk: true };
      }
    }
    return { name: spec.name, endpoint, category: cat, cls: "UNVERIFIED_WRITE", detail: "no verify configured", ms: 0, mcpaqlOk: true };
  }

  return { name: spec.name, endpoint, category: cat, cls: "SKIPPED", detail: "unhandled category", ms: 0 };
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }
