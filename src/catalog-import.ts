import { createHash } from "node:crypto";
import path from "node:path";

import { assembleBundle, type RawTool } from "./interrogate.js";
import type { DiscoveryBundle, InterrogationConfig } from "./types.js";

export type CatalogFormat = "tools_list" | "tool_array" | "catalog";

/**
 * Serialized sizes of the advertised tool definitions, as compact JSON.stringify output
 * (UTF-16 code units). Servers that escape more characters (e.g. Go's encoding/json for
 * <, > and &) send slightly more. Every field is measured serialized, quotes included.
 */
export interface CatalogFootprint {
  tool_count: number;
  total_chars: number;
  description_chars: number;
  input_schema_chars: number;
  output_schema_chars: number;
}

// Vendor catalogs mix tool definitions with vendor fields; only these reach the wire.
const WIRE_FIELDS = ["name", "title", "description", "inputSchema", "outputSchema", "annotations", "icons", "execution", "_meta"] as const;

function compactLength(value: unknown): number {
  return value === undefined ? 0 : JSON.stringify(value).length;
}

/**
 * Accepts a tools/list result (`{ tools }`), a bare array of tools, or a vendor catalog
 * (`{ catalog }`) whose entries carry tool definitions plus vendor fields. Entries are kept
 * as given, so vendor metadata such as effect flags stays available in the raw capture.
 */
export function parseToolCatalog(value: unknown): { format: CatalogFormat; tools: RawTool[]; nextCursor?: string } {
  let format: CatalogFormat;
  let entries: unknown;
  if (Array.isArray(value)) {
    format = "tool_array";
    entries = value;
  } else if (value && typeof value === "object" && Array.isArray((value as { tools?: unknown }).tools)) {
    format = "tools_list";
    entries = (value as { tools: unknown[] }).tools;
  } else if (value && typeof value === "object" && Array.isArray((value as { catalog?: unknown }).catalog)) {
    format = "catalog";
    entries = (value as { catalog: unknown[] }).catalog;
  } else {
    throw new Error("Catalog must be a tools/list result ({ tools }), an array of tools, or a catalog ({ catalog }).");
  }

  const tools = entries as unknown[];
  const seen = new Set<string>();
  tools.forEach((tool, index) => {
    const name = (tool as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !name) {
      throw new Error(`Catalog entry ${index} has no tool name.`);
    }
    if (seen.has(name)) {
      throw new Error(`Catalog lists tool '${name}' more than once.`);
    }
    seen.add(name);
  });
  const nextCursor = (value as { nextCursor?: unknown } | null)?.nextCursor;
  return { format, tools: tools as RawTool[], ...(typeof nextCursor === "string" && nextCursor ? { nextCursor } : {}) };
}

export function measureCatalogFootprint(tools: RawTool[], format: CatalogFormat = "tools_list"): CatalogFootprint {
  const footprint: CatalogFootprint = {
    tool_count: tools.length,
    total_chars: 0,
    description_chars: 0,
    input_schema_chars: 0,
    output_schema_chars: 0,
  };
  for (const tool of tools) {
    const record = tool as unknown as Record<string, unknown>;
    // A tools/list entry is sent whole; a vendor catalog entry only through its wire fields.
    const wire = format === "catalog"
      ? Object.fromEntries(
          WIRE_FIELDS.filter((field) => record[field] !== undefined && record[field] !== null).map((field) => [field, record[field]]),
        )
      : record;
    footprint.total_chars += compactLength(wire);
    footprint.description_chars += compactLength(typeof record.description === "string" ? record.description : undefined);
    footprint.input_schema_chars += compactLength(record.inputSchema ?? undefined);
    footprint.output_schema_chars += compactLength(record.outputSchema ?? undefined);
  }
  return footprint;
}

/**
 * Build a discovery bundle from a static tool catalog without contacting or executing
 * the upstream. Normalization is shared with live interrogation.
 */
export function importToolCatalog(options: {
  config: InterrogationConfig;
  /** Raw catalog file contents; hashed as given, then decoded as UTF-8. */
  catalogText: string | Uint8Array;
  catalogPath?: string;
  server?: DiscoveryBundle["source"]["server"];
  capturedAt?: string;
}): DiscoveryBundle {
  const text = typeof options.catalogText === "string"
    ? options.catalogText
    : new TextDecoder("utf-8").decode(options.catalogText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { format, tools, nextCursor } = parseToolCatalog(parsed);
  const bundle = assembleBundle({
    config: options.config,
    tools,
    server: options.server,
    capturedAt: options.capturedAt,
    rawCaptureExtras: {
      catalog_source: {
        format,
        // Basename only: committed bundles must not carry machine-specific paths.
        file: options.catalogPath ? path.basename(options.catalogPath) : undefined,
        sha256: createHash("sha256").update(options.catalogText).digest("hex"),
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      },
      footprint: measureCatalogFootprint(tools, format),
    },
  });
  if (nextCursor) {
    bundle.normalized_bundle.warnings.push({
      code: "CATALOG_PARTIAL",
      severity: "warning",
      message: `Catalog is one page of a paginated tools/list (nextCursor '${nextCursor}'); later pages are missing.`,
    });
  }
  return bundle;
}
