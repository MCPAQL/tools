import { createHash } from "node:crypto";

import { assembleBundle, type RawTool } from "./interrogate.js";
import type { DiscoveryBundle, InterrogationConfig } from "./types.js";

export type CatalogFormat = "tools_list" | "tool_array" | "catalog";

/** Exact serialized sizes of the advertised tool definitions (compact JSON, as sent in tools/list). */
export interface CatalogFootprint {
  tool_count: number;
  total_chars: number;
  description_chars: number;
  input_schema_chars: number;
  output_schema_chars: number;
}

const WIRE_FIELDS = ["name", "title", "description", "inputSchema", "outputSchema", "annotations"] as const;

function compactLength(value: unknown): number {
  return value === undefined ? 0 : JSON.stringify(value).length;
}

/**
 * Accepts a tools/list result (`{ tools }`), a bare array of tools, or a vendor catalog
 * (`{ catalog }`) whose entries carry tool definitions plus vendor fields. Entries are kept
 * as given, so vendor metadata such as effect flags stays available in the raw capture.
 */
export function parseToolCatalog(value: unknown): { format: CatalogFormat; tools: RawTool[] } {
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
  return { format, tools: tools as RawTool[] };
}

export function measureCatalogFootprint(tools: RawTool[]): CatalogFootprint {
  const footprint: CatalogFootprint = {
    tool_count: tools.length,
    total_chars: 0,
    description_chars: 0,
    input_schema_chars: 0,
    output_schema_chars: 0,
  };
  for (const tool of tools) {
    const record = tool as unknown as Record<string, unknown>;
    const wire = Object.fromEntries(
      WIRE_FIELDS.filter((field) => record[field] !== undefined && record[field] !== null).map((field) => [field, record[field]]),
    );
    footprint.total_chars += compactLength(wire);
    footprint.description_chars += typeof record.description === "string" ? record.description.length : 0;
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
  catalogText: string;
  catalogPath?: string;
  server?: DiscoveryBundle["source"]["server"];
  capturedAt?: string;
}): DiscoveryBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.catalogText);
  } catch (error) {
    throw new Error(`Catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { format, tools } = parseToolCatalog(parsed);
  return assembleBundle({
    config: options.config,
    tools,
    server: options.server,
    capturedAt: options.capturedAt,
    rawCaptureExtras: {
      catalog_source: {
        format,
        path: options.catalogPath,
        sha256: createHash("sha256").update(options.catalogText).digest("hex"),
      },
      footprint: measureCatalogFootprint(tools),
    },
  });
}
