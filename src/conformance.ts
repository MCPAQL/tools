import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

import type { ConformanceReport } from "./types.js";
import { connectStdioAdapter } from "./adapter-client.js";
import { firstTextContent, parseJsonText, READ_ENDPOINT_TOOL_NAME, withTimeout } from "./shared.js";

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

async function loadJson(filePath: string): Promise<unknown> {
  return parseJsonText(await readFile(filePath, "utf8"), `schema file '${filePath}'`);
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
  const checks: ConformanceReport["checks"] = [];

  try {
    const tools = await withTimeout(client.listTools(), undefined, "conformance tools/list");
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    checks.push({
      name: "tool-registration",
      passed: toolNames.has(READ_ENDPOINT_TOOL_NAME),
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

    // TODO: add live CRUD proxy operation exercises in addition to introspection-only validation.
    const toolCall = await withTimeout(
      client.callTool({
        name: READ_ENDPOINT_TOOL_NAME,
        arguments: introspectRequest,
      }),
      undefined,
      "conformance introspect call",
    );

    let payload: unknown;
    try {
      payload = parseJsonText(firstTextContent(toolCall), "conformance introspection response");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      checks.push({
        name: "operation-result-schema",
        passed: false,
        detail,
      });
      checks.push({
        name: "introspection-response-schema",
        passed: false,
        detail: "Skipped because the introspection response was not valid JSON.",
      });

      return {
        passed: false,
        checks,
      };
    }

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

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  } finally {
    await transport.close();
  }
}
