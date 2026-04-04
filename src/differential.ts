import { readFile } from "node:fs/promises";

import type { DifferentialReport, DiscoveryBundle, EndpointCategory } from "./types.js";
import { connectStdioAdapter } from "./adapter-client.js";
import {
  firstTextContent,
  parseJsonText,
  READ_ENDPOINT_TOOL_NAME,
  SYNTHETIC_INTROSPECT_OPERATION,
  withTimeout,
} from "./shared.js";

function endpointToolName(endpoint: EndpointCategory): string {
  return `mcp_aql_${endpoint.toLowerCase()}`;
}

export async function loadBundle(bundlePath: string): Promise<DiscoveryBundle> {
  const content = await readFile(bundlePath, "utf8");
  return parseJsonText<DiscoveryBundle>(content, `discovery bundle '${bundlePath}'`);
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

  const schema = parseJsonText<{
    operations?: Record<string, Array<{ name: string; params?: Record<string, unknown> }>>;
  }>(await readFile(options.expectedSchemaPath, "utf8"), `adapter schema '${options.expectedSchemaPath}'`);

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

  try {
    const operationsResult = await withTimeout(
      client.callTool({
        name: READ_ENDPOINT_TOOL_NAME,
        arguments: {
          operation: SYNTHETIC_INTROSPECT_OPERATION,
          params: { query: "operations" },
        },
      }),
      undefined,
      "differential introspect operations",
    );

    const payload = parseJsonText<{
      success?: boolean;
      data?: { operations?: Array<{ name: string; endpoint: EndpointCategory }> };
    }>(firstTextContent(operationsResult), "differential operations introspection response");
    const adapterOperations = payload.data?.operations ?? [];

    const sourceByName = new Map(sourceOperations.map((operation) => [operation.operation_name, operation]));
    const adapterByName = new Map(adapterOperations.map((operation) => [operation.name, operation]));
    const syntheticOperations = adapterOperations
      .filter((operation) => operation.name === SYNTHETIC_INTROSPECT_OPERATION && !sourceByName.has(operation.name))
      .map((operation) => operation.name);

    const missingOperations = sourceOperations
      .filter((operation) => !adapterByName.has(operation.operation_name))
      .map((operation) => operation.operation_name);

    const extraOperations = adapterOperations
      .filter((operation) => operation.name !== SYNTHETIC_INTROSPECT_OPERATION && !sourceByName.has(operation.name))
      .map((operation) => operation.name);

    const operations = [];
    for (const operation of sourceOperations.filter((candidate) => adapterByName.has(candidate.operation_name))) {
      const detailResult = await withTimeout(
        client.callTool({
          name: READ_ENDPOINT_TOOL_NAME,
          arguments: {
            operation: SYNTHETIC_INTROSPECT_OPERATION,
            params: { query: "operations", name: operation.operation_name },
          },
        }),
        undefined,
        `differential introspect detail ${operation.operation_name}`,
      );

      const detailPayload = parseJsonText<{
        data?: {
          operation?: {
            endpoint: EndpointCategory;
            parameters?: Array<{ name: string }>;
            mcpTool?: string;
            mcp_tool?: string;
          };
        };
      }>(firstTextContent(detailResult), `differential detail response for '${operation.operation_name}'`);
      const detail = detailPayload.data?.operation;
      const adapterToolName = detail?.mcpTool ?? detail?.mcp_tool;
      const adapterParams = new Set((detail?.parameters ?? []).map((parameter) => parameter.name));
      const sourceParams = new Set(operation.params.map((parameter) => parameter.name));

      operations.push({
        operation: operation.operation_name,
        endpoint_match: detail?.endpoint === operation.endpoint && adapterToolName === endpointToolName(operation.endpoint),
        parameter_names_match:
          [...sourceParams].every((name) => adapterParams.has(name)) &&
          [...adapterParams].every((name) => sourceParams.has(name)),
        missing_parameters: [...sourceParams].filter((name) => !adapterParams.has(name)),
        extra_parameters: [...adapterParams].filter((name) => !sourceParams.has(name)),
      });
    }

    return {
      summary: {
        source_operation_count: sourceOperations.length,
        adapter_operation_count: adapterOperations.length,
        missing_operations: missingOperations,
        extra_operations: extraOperations,
        notes:
          syntheticOperations.length > 0
            ? [
                `adapter_operation_count includes ${syntheticOperations.length} synthetic adapter operation(s): ${syntheticOperations.join(", ")}.`,
              ]
            : undefined,
      },
      operations,
    };
  } finally {
    await transport.close();
  }
}
