import { readFile } from "node:fs/promises";

import type { DifferentialReport, DiscoveryBundle, EndpointCategory } from "./types.js";
import { connectStdioAdapter } from "./adapter-client.js";

function firstTextContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return "{}";
  }

  const first = content[0] as { text?: unknown };
  return typeof first.text === "string" ? first.text : "{}";
}

function endpointToolName(endpoint: EndpointCategory): string {
  return `mcp_aql_${endpoint.toLowerCase()}`;
}

export async function loadBundle(bundlePath: string): Promise<DiscoveryBundle> {
  const content = await readFile(bundlePath, "utf8");
  return JSON.parse(content) as DiscoveryBundle;
}

async function loadExpectedOperations(options: {
  bundlePath: string;
  expectedSchemaPath?: string;
}): Promise<
  Array<{
    operation_name: string;
    endpoint: EndpointCategory;
    params: Array<{ name: string }>;
  }>
> {
  if (!options.expectedSchemaPath) {
    const bundle = await loadBundle(options.bundlePath);
    return bundle.normalized_bundle.operations.map((operation) => ({
      operation_name: operation.operation_name,
      endpoint: operation.endpoint,
      params: operation.params.map((param) => ({ name: param.name })),
    }));
  }

  const schema = JSON.parse(await readFile(options.expectedSchemaPath, "utf8")) as {
    operations?: Record<string, Array<{ name: string; params?: Record<string, unknown> }>>;
  };

  return Object.entries(schema.operations ?? {}).flatMap(([endpoint, operations]) =>
    (operations ?? []).map((operation) => ({
      operation_name: operation.name,
      endpoint: endpoint.toUpperCase() as EndpointCategory,
      params: Object.keys(operation.params ?? {}).map((name) => ({ name })),
    })),
  );
}

export async function runDifferentialValidation(options: {
  bundlePath: string;
  expectedSchemaPath?: string;
  server: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
}): Promise<DifferentialReport> {
  const sourceOperations = await loadExpectedOperations({
    bundlePath: options.bundlePath,
    expectedSchemaPath: options.expectedSchemaPath,
  });
  const { client, transport } = await connectStdioAdapter(options.server);

  const operationsResult = await client.callTool({
    name: "mcp_aql_read",
    arguments: {
      operation: "introspect",
      params: { query: "operations" },
    },
  });

  const payload = JSON.parse(firstTextContent(operationsResult)) as {
    success?: boolean;
    data?: { operations?: Array<{ name: string; endpoint: EndpointCategory }> };
  };
  const adapterOperations = payload.data?.operations ?? [];

  const sourceByName = new Map(sourceOperations.map((operation) => [operation.operation_name, operation]));
  const adapterByName = new Map(adapterOperations.map((operation) => [operation.name, operation]));

  const missingOperations = sourceOperations
    .filter((operation) => !adapterByName.has(operation.operation_name))
    .map((operation) => operation.operation_name);

  const extraOperations = adapterOperations
    .filter((operation) => operation.name !== "introspect" && !sourceByName.has(operation.name))
    .map((operation) => operation.name);

  const operations = await Promise.all(
    sourceOperations
      .filter((operation) => adapterByName.has(operation.operation_name))
      .map(async (operation) => {
        const detailResult = await client.callTool({
          name: "mcp_aql_read",
          arguments: {
            operation: "introspect",
            params: { query: "operations", name: operation.operation_name },
          },
        });

        const detailPayload = JSON.parse(firstTextContent(detailResult)) as {
          data?: {
            operation?: {
              endpoint: EndpointCategory;
              parameters?: Array<{ name: string }>;
              mcpTool?: string;
            };
          };
        };
        const detail = detailPayload.data?.operation;
        const adapterParams = new Set((detail?.parameters ?? []).map((parameter) => parameter.name));
        const sourceParams = new Set(operation.params.map((parameter) => parameter.name));

        return {
          operation: operation.operation_name,
          endpoint_match: detail?.endpoint === operation.endpoint && detail?.mcpTool === endpointToolName(operation.endpoint),
          parameter_names_match:
            [...sourceParams].every((name) => adapterParams.has(name)) &&
            [...adapterParams].every((name) => sourceParams.has(name)),
          missing_parameters: [...sourceParams].filter((name) => !adapterParams.has(name)),
          extra_parameters: [...adapterParams].filter((name) => !sourceParams.has(name)),
        };
      }),
  );

  await transport.close();

  return {
    summary: {
      source_operation_count: sourceOperations.length,
      adapter_operation_count: adapterOperations.length,
      missing_operations: missingOperations,
      extra_operations: extraOperations,
    },
    operations,
  };
}
