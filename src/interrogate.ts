import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type {
  DangerLevel,
  DiscoveryBundle,
  DiscoveryParam,
  DiscoveryWarning,
  EndpointCategory,
  InferenceSource,
  InterrogationConfig,
  NormalizedOperation,
} from "./types.js";
import { annotationConflicts, classifyFromEffects, readEffectFlags } from "./effects-classification.js";
import { deepRedact, redactStdioTransport, normalizeSnakeCase, parseJsonText, resolveHeaderEnv, withTimeout, writeJsonFile } from "./shared.js";

const execFileAsync = promisify(execFile);

export interface RawTool {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema?: {
    type?: string;
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
    $defs?: Record<string, Record<string, unknown>>;
    definitions?: Record<string, Record<string, unknown>>;
  };
}

function validateConfig(config: InterrogationConfig): void {
  if (!config.name.trim()) {
    throw new Error("Interrogation config requires a non-empty 'name'.");
  }

  if (!config.server_url.trim()) {
    throw new Error("Interrogation config requires a non-empty 'server_url'.");
  }

  const transport = config.transport as { type?: unknown; command?: unknown };
  if (transport.type === "stdio") {
    if (typeof transport.command !== "string" || !transport.command.trim()) {
      throw new Error("stdio transport requires a non-empty 'command'.");
    }
  } else if (transport.type !== "streamable_http") {
    throw new Error(`Unsupported transport type '${String(transport.type)}'.`);
  }

  if (config.auth?.type === "bearer" && !config.auth.token_env && !config.auth.token_command) {
    throw new Error("Bearer auth requires either 'token_env' or 'token_command'.");
  }
}

export function classifyEndpoint(tool: RawTool): {
  endpoint: EndpointCategory;
  confidence: "high" | "medium" | "low";
  reviewReasons: string[];
} {
  const name = tool.name;
  const description = `${tool.description ?? ""} ${String(tool.annotations?.title ?? "")}`.toLowerCase();
  const reviewReasons: string[] = [];

  const strongPrefix = (prefixes: string[]): boolean => prefixes.some((prefix) => name.startsWith(prefix));
  const contains = (needles: string[]): boolean => needles.some((needle) => description.includes(needle));

  if (strongPrefix(["get_", "list_", "search_"]) || name.endsWith("_read")) {
    return { endpoint: "READ", confidence: "high", reviewReasons };
  }

  if (strongPrefix(["delete_", "remove_"])) {
    return { endpoint: "DELETE", confidence: "high", reviewReasons };
  }

  if (contains(["delete", "remove", "destroy"])) {
    reviewReasons.push("Description implies destructive behavior.");
    return { endpoint: "DELETE", confidence: "medium", reviewReasons };
  }

  if (strongPrefix(["update_"]) || name.endsWith("_write")) {
    if (name.endsWith("_write")) {
      reviewReasons.push("Write suffix is semantically broad and may hide create/update behavior.");
      return { endpoint: "UPDATE", confidence: "medium", reviewReasons };
    }
    return { endpoint: "UPDATE", confidence: "high", reviewReasons };
  }

  if (strongPrefix(["assign_"])) {
    reviewReasons.push("Assignment semantics treated as UPDATE on an existing resource.");
    return { endpoint: "UPDATE", confidence: "medium", reviewReasons };
  }

  if (strongPrefix(["create_", "add_", "fork_"])) {
    if (name.startsWith("create_or_update_")) {
      reviewReasons.push("Tool name spans both create and update semantics.");
      return { endpoint: "UPDATE", confidence: "low", reviewReasons };
    }
    return { endpoint: "CREATE", confidence: "high", reviewReasons };
  }

  if (strongPrefix(["merge_", "request_", "push_"])) {
    reviewReasons.push("Action-oriented tool classified as EXECUTE conservatively.");
    return { endpoint: "EXECUTE", confidence: "medium", reviewReasons };
  }

  if (contains(["merge", "request review", "run", "execute"])) {
    reviewReasons.push("Description implies workflow execution.");
    return { endpoint: "EXECUTE", confidence: "medium", reviewReasons };
  }

  reviewReasons.push("No strong semantic signal found in tool name or description; defaulting conservatively to EXECUTE.");
  return { endpoint: "EXECUTE", confidence: "low", reviewReasons };
}

function classifyDanger(endpoint: EndpointCategory): DangerLevel {
  switch (endpoint) {
    case "READ":
      return "safe";
    case "CREATE":
    case "UPDATE":
      return "reversible";
    case "DELETE":
      return "destructive";
    case "EXECUTE":
      return "dangerous";
  }
}

const LOCAL_REF = /^#\/(\$defs|definitions)\/([^/]+)$/;

// Schema generators (zod, pydantic) often emit properties as local $refs into $defs.
// Resolve those so a property's type, description and constraints are not lost.
function resolveLocalRef(entry: Record<string, unknown>, inputSchema: RawTool["inputSchema"]): Record<string, unknown> {
  let current = entry;
  for (let depth = 0; depth < 16 && typeof current.$ref === "string"; depth += 1) {
    const match = LOCAL_REF.exec(current.$ref);
    const definitions = match ? (match[1] === "$defs" ? inputSchema?.$defs : inputSchema?.definitions) : undefined;
    const target = definitions && Object.hasOwn(definitions, match![2]) ? definitions[match![2]] : undefined;
    if (!target || typeof target !== "object") break;
    const { $ref: _ref, ...siblings } = current;
    current = { ...target, ...siblings };
  }
  return current;
}

function normalizeParams(tool: RawTool): DiscoveryParam[] {
  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);

  return Object.entries(properties).map(([name, schema]) => {
    if (!schema || typeof schema !== "object") {
      throw new Error(`Tool '${tool.name}' has a non-object schema for input property '${name}'.`);
    }
    const entry = resolveLocalRef(schema as Record<string, unknown>, tool.inputSchema);
    const enumValues = Array.isArray(entry.enum)
      ? entry.enum.filter((value): value is string => typeof value === "string")
      : undefined;

    return {
      name: normalizeSnakeCase(name),
      original_name: name,
      type: typeof entry.type === "string" ? entry.type : "object",
      required: required.has(name),
      description: typeof entry.description === "string" ? entry.description : undefined,
      default: entry.default,
      enum: enumValues,
      minimum: typeof entry.minimum === "number" ? entry.minimum : undefined,
      maximum: typeof entry.maximum === "number" ? entry.maximum : undefined,
      pattern: typeof entry.pattern === "string" ? entry.pattern : undefined,
      format: typeof entry.format === "string" ? entry.format : undefined,
      source_path: `inputSchema.properties.${name}`,
    };
  });
}

export interface NormalizeOptions {
  /** Field holding per-tool effect flags. Defaults to "effects". */
  effectsField?: string;
}

// Effect flags, when the upstream publishes them, decide the endpoint and danger level.
// Otherwise the name and description heuristic applies. Either way, MCP annotations
// that disagree with the result are surfaced for review.
function classifyTool(tool: RawTool, options: NormalizeOptions) {
  const effects = readEffectFlags(tool as unknown as Record<string, unknown>, options.effectsField);
  if (effects) {
    const { endpoint, danger, reviewReasons } = classifyFromEffects(effects);
    return {
      endpoint,
      danger,
      confidence: "high" as const,
      reviewReasons,
      conflicts: annotationConflicts(tool.annotations, endpoint),
      source: "direct_source_metadata" as InferenceSource,
    };
  }
  const { endpoint, confidence, reviewReasons } = classifyEndpoint(tool);
  return {
    endpoint,
    danger: classifyDanger(endpoint),
    confidence,
    reviewReasons,
    conflicts: annotationConflicts(tool.annotations, endpoint),
    source: "heuristic_classification" as InferenceSource,
  };
}

function normalizeTool(tool: RawTool, warnings: DiscoveryWarning[], options: NormalizeOptions = {}): NormalizedOperation {
  const classification = classifyTool(tool, options);
  const { endpoint, confidence } = classification;
  const reviewReasons = [...classification.reviewReasons, ...classification.conflicts];
  const params = normalizeParams(tool);
  const normalizedOperationName = normalizeSnakeCase(tool.name);
  const operationNameSource: InferenceSource =
    tool.name === normalizedOperationName ? "direct_source_metadata" : "deterministic_normalization";
  const descriptionSource: InferenceSource = tool.description ? "direct_source_metadata" : "heuristic_classification";

  if (tool.name !== normalizedOperationName) {
    warnings.push({
      code: "NAME_NORMALIZED",
      severity: "info",
      message: `Tool '${tool.name}' was normalized to snake_case operation name '${normalizedOperationName}'.`,
      tool: tool.name,
      heuristic: "snake_case_normalization",
    });
  }

  for (const reason of classification.reviewReasons) {
    warnings.push({
      code: "REVIEW_REQUIRED",
      severity: confidence === "low" ? "warning" : "info",
      message: reason,
      tool: tool.name,
      heuristic: classification.source === "direct_source_metadata" ? "effect_classification" : "endpoint_classification",
    });
  }

  for (const conflict of classification.conflicts) {
    warnings.push({
      code: "ANNOTATION_CONFLICT",
      severity: "warning",
      message: conflict,
      tool: tool.name,
      heuristic: "annotation_comparison",
    });
  }

  for (const param of params) {
    if (param.name !== param.original_name) {
      warnings.push({
        code: "PARAM_NAME_NORMALIZED",
        severity: "info",
        message: `Parameter '${param.original_name}' was normalized to '${param.name}'.`,
        tool: tool.name,
        field: param.original_name,
        heuristic: "snake_case_normalization",
      });
    }
  }

  return {
    source_tool_name: tool.name,
    operation_name: normalizedOperationName,
    title: typeof tool.annotations?.title === "string" ? tool.annotations.title : undefined,
    description: tool.description ?? `Proxy for upstream MCP tool '${tool.name}'.`,
    endpoint,
    endpoint_confidence: confidence,
    danger_level: classification.danger,
    needs_review: reviewReasons.length > 0,
    review_reasons: reviewReasons,
    params,
    maps_to: `tool:${tool.name}`,
    returns: {
      type: "object",
      name: "WrappedToolResult",
      description: "Wrapped upstream MCP tool result preserving content and structured payloads.",
    },
    provenance: {
      name: "name",
      description: tool.description ? "description" : undefined,
      annotations: tool.annotations ? Object.keys(tool.annotations) : undefined,
      input_schema_present: Boolean(tool.inputSchema),
      inference_sources: {
        operation_name: operationNameSource,
        description: descriptionSource,
        endpoint: classification.source,
        danger_level: classification.source,
        maps_to: "deterministic_normalization",
      },
    },
  };
}

export function normalizeTools(
  tools: RawTool[],
  options: NormalizeOptions = {},
): { operations: NormalizedOperation[]; warnings: DiscoveryWarning[] } {
  const warnings: DiscoveryWarning[] = [];
  const operations = tools.map((tool) => normalizeTool(tool, warnings, options));
  return { operations, warnings };
}

function redactCaptureConfig(config: InterrogationConfig): Record<string, unknown> {
  const redacted = deepRedact(config) as unknown as Record<string, unknown>;
  if (config.transport.type === "stdio") {
    // Redact from the original so env values are judged before key-name redaction rewrites them.
    redacted.transport = redactStdioTransport(config.transport as unknown as Record<string, unknown>);
  }
  return redacted;
}

/** Shared by live interrogation and offline catalog import, so both produce the same bundle for the same tools. */
export function assembleBundle(options: {
  config: InterrogationConfig;
  tools: RawTool[];
  server?: DiscoveryBundle["source"]["server"];
  capturedAt?: string;
  rawCaptureExtras?: Record<string, unknown>;
}): DiscoveryBundle {
  const { config, tools } = options;
  return {
    schema_version: "1.0.0-draft",
    source: {
      name: config.name,
      server_url: config.server_url,
      transport: config.transport.type,
      captured_at: options.capturedAt ?? new Date().toISOString(),
      server: options.server ?? {},
      auth: {
        type: config.auth?.type ?? "none",
        header: config.auth?.header ?? "Authorization",
        prefix: config.auth?.prefix ?? "Bearer ",
        token_env: config.auth?.token_env,
        // Preserve the operator-provided command here for reproducibility; capture_config_redacted is the secrecy boundary.
        token_command: config.auth?.token_command,
      },
      capture_config_redacted: redactCaptureConfig(config),
    },
    raw_capture: {
      tools,
      ...options.rawCaptureExtras,
    },
    normalized_bundle: normalizeTools(tools, { effectsField: config.classification?.effects_field }),
  };
}

async function resolveAuthHeaders(config: InterrogationConfig): Promise<Record<string, string>> {
  const headers: Record<string, string> = resolveHeaderEnv(config.headers ?? {});

  if (!config.auth || config.auth.type !== "bearer") {
    return headers;
  }

  const header = config.auth.header ?? "Authorization";
  const prefix = config.auth.prefix ?? "Bearer ";
  let token: string | undefined;

  if (config.auth.token_env) {
    token = process.env[config.auth.token_env];
  }

  if (!token && config.auth.token_command) {
    // token_command is shell-interpreted and must come from trusted operator-controlled config.
    const { stdout } = await execFileAsync("/bin/sh", ["-lc", config.auth.token_command], {
      env: process.env,
    });
    token = stdout.trim();
  }

  if (!token) {
    throw new Error("No bearer token resolved from token_env or token_command.");
  }

  headers[header] = `${prefix}${token}`;
  return headers;
}

export async function loadConfig(configPath: string): Promise<InterrogationConfig> {
  const content = await readFile(configPath, "utf8");
  const config = parseJsonText<InterrogationConfig>(content, `config file '${configPath}'`);
  validateConfig(config);
  return config;
}

async function listAllTools(client: Client): Promise<{
  tools: RawTool[];
  page_count: number;
  pages: Array<{ cursor: string | null; next_cursor: string | null; tool_count: number }>;
}> {
  const tools: RawTool[] = [];
  const pages: Array<{ cursor: string | null; next_cursor: string | null; tool_count: number }> = [];
  let cursor: string | undefined;

  for (;;) {
    const response = await withTimeout(
      client.listTools(cursor ? { cursor } : undefined),
      undefined,
      "tools/list",
    );
    const pageTools = (response.tools ?? []) as unknown as RawTool[];
    tools.push(...pageTools);
    pages.push({
      cursor: cursor ?? null,
      next_cursor: response.nextCursor ?? null,
      tool_count: pageTools.length,
    });

    if (!response.nextCursor) {
      break;
    }

    cursor = response.nextCursor;
  }

  return {
    tools,
    page_count: pages.length,
    pages,
  };
}

export async function interrogateServer(config: InterrogationConfig): Promise<DiscoveryBundle> {
  if (config.transport.type !== "streamable_http") {
    throw new Error("Live interrogation supports streamable_http only; for stdio servers, import a tools/list catalog with mcpaql-import-catalog.");
  }
  const requestHeaders = await resolveAuthHeaders(config);
  const client = new Client({ name: "mcpaql-interrogate", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(config.server_url), {
    requestInit: {
      headers: requestHeaders,
    },
  });

  try {
    await client.connect(transport);
    const toolsCapture = await listAllTools(client);
    return assembleBundle({
      config,
      tools: toolsCapture.tools,
      server: {
        name: client.getServerVersion()?.name,
        version: client.getServerVersion()?.version,
        title: client.getServerVersion()?.title,
      },
      rawCaptureExtras: {
        list_tools_page_count: toolsCapture.page_count,
        list_tools_pages: toolsCapture.pages,
      },
    });
  } finally {
    await transport.close();
  }
}

export async function persistBundle(bundle: DiscoveryBundle, outDir: string): Promise<void> {
  await writeJsonFile(`${outDir}/raw-tools-list.json`, bundle.raw_capture.tools);
  await writeJsonFile(`${outDir}/discovery-bundle.json`, bundle);
  await writeJsonFile(`${outDir}/warnings.json`, bundle.normalized_bundle.warnings);
  await writeJsonFile(`${outDir}/capture-metadata.json`, {
    schema_version: bundle.schema_version,
    source: bundle.source,
    tool_count: bundle.normalized_bundle.operations.length,
    warning_count: bundle.normalized_bundle.warnings.length,
  });
}
