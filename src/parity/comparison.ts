import type { ParityClass } from "./types.js";

export interface NormalizeOptions {
  extraVolatileKeyPatterns?: readonly RegExp[];
}

const VOLATILE_KEY_PATTERNS = [
  /(^|_)id$/i, /^node_id$/i, /(^|_)url$/i, /^etag$/i, /^sha$/i,
  /^htmlUrl$/i, /^html_url$/i,
  /^created_at$/i, /^updated_at$/i, /^pushed_at$/i, /^merged_at$/i, /^closed_at$/i, /^last_modified$/i,
  /^date$/i,
  /^x-github-/i, /^request_id$/i,
];

export const WRITE_VARIANT_NORMALIZE_OPTIONS: NormalizeOptions = {
  extraVolatileKeyPatterns: [/^number$/i, /^size$/i],
};

function isVolatileKey(key: string, options: NormalizeOptions = {}): boolean {
  return [...VOLATILE_KEY_PATTERNS, ...(options.extraVolatileKeyPatterns ?? [])].some((rx) => rx.test(key));
}

export function normalize(value: unknown, options: NormalizeOptions = {}): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item, options));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isVolatileKey(k, options) ? "<VOL>" : normalize(v, options);
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

export function extractOfficialPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
  if (r.structuredContent) return r.structuredContent;
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (text) {
    try { return JSON.parse(text); } catch { return text; }
  }
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
  if (text) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return e.data;
}

export function classify(
  officialOk: boolean, mcpaqlOk: boolean,
  officialPayload: unknown, mcpaqlPayload: unknown,
  options: NormalizeOptions = {},
): { cls: ParityClass; detail?: string } {
  const safe = (x: unknown) => (JSON.stringify(canonicalize(x)) ?? "<undefined>").slice(0, 200);
  if (!officialOk && !mcpaqlOk) return { cls: "BOTH_ERROR", detail: `official: ${safe(officialPayload)} | mcpaql: ${safe(mcpaqlPayload)}` };
  if (!officialOk && mcpaqlOk) return { cls: "OFFICIAL_ERROR", detail: safe(officialPayload) };
  if (officialOk && !mcpaqlOk) return { cls: "MCPAQL_ERROR", detail: safe(mcpaqlPayload) };
  const offRaw = JSON.stringify(canonicalize(officialPayload)) ?? "<undefined>";
  const mcpRaw = JSON.stringify(canonicalize(mcpaqlPayload)) ?? "<undefined>";
  if (offRaw === mcpRaw) return { cls: "IDENTICAL" };
  const normalizedOfficial = normalize(officialPayload, options);
  const normalizedMcpaql = normalize(mcpaqlPayload, options);
  const offNorm = JSON.stringify(canonicalize(normalizedOfficial));
  const mcpNorm = JSON.stringify(canonicalize(normalizedMcpaql));
  if (offNorm === mcpNorm) return { cls: "STRUCTURAL_PARITY" };
  return { cls: "DIVERGENT", detail: firstDiff(normalizedOfficial, normalizedMcpaql, "") };
}

export function firstDiff(a: unknown, b: unknown, path = ""): string {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path || "root"}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
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
