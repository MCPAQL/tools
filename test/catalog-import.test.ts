import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { importToolCatalog, measureCatalogFootprint, parseToolCatalog } from "../src/catalog-import.js";
import { assembleBundle, type RawTool } from "../src/interrogate.js";
import type { InterrogationConfig } from "../src/types.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Shaped like a zod-generated catalog: properties are $refs into $defs, and entries carry vendor fields.
const tools = [
  {
    name: "inspect_binary",
    title: "Inspect binary",
    description: "Inspect one binary",
    inputSchema: {
      type: "object",
      $defs: { path: { type: "string", description: "Absolute path", minLength: 1 } },
      properties: { path: { $ref: "#/$defs/path", description: "Absolute path to the binary" } },
      required: ["path"],
    },
    outputSchema: { type: "object", properties: { evidence_id: { type: "string" } } },
    annotations: { readOnlyHint: true },
    kind: "artifact-provider",
    effects: { executesForeignCode: false, accessesNetwork: false },
  },
  {
    name: "run_scenario",
    description: "Run the target",
    inputSchema: { type: "object", properties: { args: { type: "array", items: { type: "string" } } } },
    annotations: { destructiveHint: true },
    effects: { executesForeignCode: true },
  },
];

const stdioConfig: InterrogationConfig = {
  name: "example-local",
  server_url: "stdio://example-local",
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "example-mcp@1.2.3", "mcp"],
    env_passthrough: ["EXAMPLE_HOME"],
    env: { EXAMPLE_SECRET: "${env:EXAMPLE_SECRET_SOURCE}", EXAMPLE_PASSWORD: "literal-value" },
  },
};

test("parseToolCatalog accepts tools/list results, bare arrays and vendor catalogs", () => {
  assert.equal(parseToolCatalog({ tools }).format, "tools_list");
  assert.equal(parseToolCatalog(tools).format, "tool_array");
  assert.equal(parseToolCatalog({ catalog: tools }).format, "catalog");
  assert.throws(() => parseToolCatalog({ nope: [] }), /Catalog must be/);
  assert.throws(() => parseToolCatalog([{ description: "no name" }]), /entry 0 has no tool name/);
  assert.throws(() => parseToolCatalog([tools[0], tools[0]]), /more than once/);
});

test("measureCatalogFootprint reports exact compact-JSON sizes", () => {
  const footprint = measureCatalogFootprint(tools as RawTool[]);
  const wire = (tool: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(["name", "title", "description", "inputSchema", "outputSchema", "annotations"]
      .filter((key) => tool[key] !== undefined).map((key) => [key, tool[key]])));
  assert.deepEqual(footprint, {
    tool_count: 2,
    total_chars: wire(tools[0]).length + wire(tools[1]).length,
    description_chars: "Inspect one binary".length + "Run the target".length,
    input_schema_chars: JSON.stringify(tools[0].inputSchema).length + JSON.stringify(tools[1].inputSchema).length,
    output_schema_chars: JSON.stringify(tools[0].outputSchema).length,
  });
});

test("importToolCatalog builds a bundle offline with resolved refs and preserved vendor fields", () => {
  const catalogText = JSON.stringify({ catalog: tools });
  const bundle = importToolCatalog({ config: stdioConfig, catalogText, catalogPath: "catalog.json", capturedAt: "2026-10-17T00:00:00.000Z" });

  assert.equal(bundle.source.transport, "stdio");
  assert.equal(bundle.normalized_bundle.operations.length, 2);
  const [param] = bundle.normalized_bundle.operations[0].params;
  assert.equal(param.type, "string");
  assert.equal(param.description, "Absolute path to the binary");
  assert.equal(param.required, true);

  assert.deepEqual((bundle.raw_capture.tools[1] as { effects: unknown }).effects, { executesForeignCode: true });
  const source = bundle.raw_capture.catalog_source as { format: string; sha256: string };
  assert.equal(source.format, "catalog");
  assert.match(source.sha256, /^[0-9a-f]{64}$/);
  assert.equal((bundle.raw_capture.footprint as { tool_count: number }).tool_count, 2);
});

test("stdio launch config survives redaction except literal secret values", () => {
  const bundle = importToolCatalog({ config: stdioConfig, catalogText: JSON.stringify(tools) });
  const transport = bundle.source.capture_config_redacted.transport as Record<string, unknown>;
  assert.equal(transport.command, "npx");
  assert.deepEqual(transport.args, ["-y", "example-mcp@1.2.3", "mcp"]);
  assert.deepEqual(transport.env, { EXAMPLE_SECRET: "${env:EXAMPLE_SECRET_SOURCE}", EXAMPLE_PASSWORD: "<redacted>" });
});

test("offline import normalizes exactly like live interrogation for the same tools", () => {
  const imported = importToolCatalog({ config: stdioConfig, catalogText: JSON.stringify({ tools }) });
  const live = assembleBundle({ config: stdioConfig, tools: tools as RawTool[] });
  assert.deepEqual(imported.normalized_bundle, live.normalized_bundle);
});

test("mcpaql-import-catalog CLI writes the bundle and reports the footprint", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpaql-import-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "config.json"), JSON.stringify(stdioConfig));
  await writeFile(path.join(dir, "catalog.json"), JSON.stringify({ catalog: tools }));

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "src/catalog-cli.ts", "--config", path.join(dir, "config.json"), "--catalog", path.join(dir, "catalog.json"),
      "--out", path.join(dir, "out"), "--server-name", "example", "--server-version", "1.2.3"],
    { cwd: repoRoot },
  );
  const summary = JSON.parse(stdout);
  assert.equal(summary.tool_count, 2);
  assert.equal(summary.footprint.tool_count, 2);

  const bundle = JSON.parse(await readFile(path.join(dir, "out/discovery-bundle.json"), "utf8"));
  assert.deepEqual(bundle.source.server, { name: "example", version: "1.2.3" });
  const raw = JSON.parse(await readFile(path.join(dir, "out/raw-tools-list.json"), "utf8"));
  assert.equal(raw.length, 2);
});

test("live interrogation refuses stdio configs with a pointer to the importer", async () => {
  const { interrogateServer } = await import("../src/interrogate.js");
  await assert.rejects(interrogateServer(stdioConfig), /mcpaql-import-catalog/);
});
