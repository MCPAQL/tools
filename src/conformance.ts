import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

import type { ConformanceReport } from "./types.js";
import { connectStdioAdapter } from "./adapter-client.js";

const require = createRequire(import.meta.url);
const AjvCtor = require("ajv/dist/2020").default as new (options?: Record<string, unknown>) => {
  compile(schema: unknown): {
    (value: unknown): boolean;
    errors?: unknown[];
  };
  errorsText(errors?: unknown[] | null | undefined): string;
};
const addFormatsFn = require("ajv-formats").default as (ajv: {
  compile(schema: unknown): {
    (value: unknown): boolean;
    errors?: unknown[];
  };
}) => void;

const ajv = new AjvCtor({ allErrors: true, strict: false });
addFormatsFn(ajv);

function firstTextContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return "{}";
  }

  const first = content[0] as { text?: unknown };
  return typeof first.text === "string" ? first.text : "{}";
}

async function loadJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export async function runConformanceValidation(options: {
  server: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  schemaRoot: string;
}): Promise<ConformanceReport> {
  const inputSchema = await loadJson(`${options.schemaRoot}/operation-input.schema.json`);
  const resultSchema = await loadJson(`${options.schemaRoot}/operation-result.schema.json`);
  const introspectionSchema = await loadJson(`${options.schemaRoot}/introspection-response.schema.json`);

  const validateInput = ajv.compile(inputSchema);
  const validateResult = ajv.compile(resultSchema);
  const validateIntrospection = ajv.compile(introspectionSchema);

  const { client, transport } = await connectStdioAdapter(options.server);
  const tools = await client.listTools();
  const checks: ConformanceReport["checks"] = [];

  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  checks.push({
    name: "tool-registration",
    passed: toolNames.has("mcp_aql_read"),
    detail: `Registered tools: ${[...toolNames].join(", ")}`,
  });

  const introspectRequest = {
    operation: "introspect",
    params: { query: "operations" },
  };
  checks.push({
    name: "operation-input-schema",
    passed: Boolean(validateInput(introspectRequest)),
    detail: validateInput.errors ? ajv.errorsText(validateInput.errors) : "Request matches schema.",
  });

  const toolCall = await client.callTool({
    name: "mcp_aql_read",
    arguments: introspectRequest,
  });
  const payload = JSON.parse(firstTextContent(toolCall)) as unknown;

  checks.push({
    name: "operation-result-schema",
    passed: Boolean(validateResult(payload)),
    detail: validateResult.errors ? ajv.errorsText(validateResult.errors) : "Response envelope matches schema.",
  });

  checks.push({
    name: "introspection-response-schema",
    passed: Boolean(validateIntrospection(payload)),
    detail: validateIntrospection.errors
      ? ajv.errorsText(validateIntrospection.errors)
      : "Introspection response matches schema.",
  });

  await transport.close();

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}
