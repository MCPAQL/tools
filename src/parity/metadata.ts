import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AdapterMetadata,
  AdapterOperation,
  AdapterProvenance,
  AdapterSchema,
  Endpoint,
  ResolvedAdapterPaths,
  RunOptions,
} from "./types.js";

export const ENDPOINTS: readonly Endpoint[] = ["read", "create", "update", "delete", "execute"];
export const DEFAULT_TIMEOUT_MS = 30_000;

function isEndpoint(value: string): value is Endpoint {
  return (ENDPOINTS as readonly string[]).includes(value);
}

export function endpointFromSchemaKey(value: string): Endpoint {
  const endpoint = value.toLowerCase();
  if (!isEndpoint(endpoint)) {
    throw new Error(`Adapter schema contains unsupported endpoint "${value}". Expected one of: ${ENDPOINTS.join(", ")}.`);
  }
  return endpoint;
}

export function resolveAdapterPaths(
  options: Pick<RunOptions<unknown>, "adapterServerJs" | "schemaPath" | "provenancePath" | "adapterCwd">,
): ResolvedAdapterPaths {
  const adapterServerJs = resolve(options.adapterServerJs);
  const serverDir = dirname(adapterServerJs);
  return {
    adapterServerJs,
    schemaPath: options.schemaPath ?? join(serverDir, "schema.json"),
    provenancePath: options.provenancePath ?? join(serverDir, "provenance.json"),
    adapterCwd: options.adapterCwd ?? (basename(serverDir) === "dist" ? dirname(serverDir) : serverDir),
  };
}

export async function loadAdapterMetadata(paths: Pick<ResolvedAdapterPaths, "schemaPath" | "provenancePath">): Promise<AdapterMetadata> {
  const schema = JSON.parse(await readFile(paths.schemaPath, "utf8")) as AdapterSchema;
  const paramMappings: Record<string, Record<string, string>> = {};
  const upstreamToolNames: Record<string, string> = {};

  try {
    const prov = JSON.parse(await readFile(paths.provenancePath, "utf8")) as AdapterProvenance;
    for (const op of prov.operations) {
      if (op.param_mappings) paramMappings[op.operation_name] = op.param_mappings;
      if (op.source_tool_name) upstreamToolNames[op.operation_name] = op.source_tool_name;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Failed to load adapter provenance "${paths.provenancePath}": ${(e as Error).message}`);
    }
    // Missing provenance is optional for older generated adapters.
  }

  return {
    schema,
    adapterOps: buildAdapterOperations(schema),
    paramMappings,
    upstreamToolNames,
  };
}

function buildAdapterOperations(schema: AdapterSchema): AdapterOperation[] {
  const adapterOps: AdapterOperation[] = [];
  for (const [endpoint, ops] of Object.entries(schema.operations)) {
    const parsedEndpoint = endpointFromSchemaKey(endpoint);
    for (const op of ops) adapterOps.push({ name: op.name, endpoint: parsedEndpoint });
  }
  return adapterOps;
}
