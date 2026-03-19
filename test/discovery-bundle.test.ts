import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { DiscoveryBundle } from "../src/types.js";
import { deepRedact, normalizeSnakeCase } from "../src/shared.js";
import { classifyEndpoint } from "../src/interrogate.js";

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../..");
const bundlePath = path.join(workspaceRoot, "examples/generated/github-mcp/capture/discovery-bundle.json");
const schemaPath = path.join(workspaceRoot, "spec/schemas/discovery-bundle.schema.json");

test("deepRedact removes token-shaped secrets recursively", () => {
  const input = {
    token_env: "GITHUB_PERSONAL_ACCESS_TOKEN",
    token_command: "gh auth token",
    server_url: "https://example.com/mcp",
    auth: {
      Authorization: "Bearer ghp_super_secret",
      nested: ["ghu_example_secret"],
    },
  };

  const redacted = deepRedact(input);

  assert.deepEqual(redacted, {
    token_env: "GITHUB_PERSONAL_ACCESS_TOKEN",
    token_command: "<redacted>",
    server_url: "https://example.com/mcp",
    auth: {
      Authorization: "<redacted>",
      nested: ["<redacted>"],
    },
  });
});

test("classifyEndpoint uses safer heuristics for ambiguous and descriptive tools", () => {
  assert.equal(classifyEndpoint({ name: "assign_issue", description: "Assign an issue to a user" }).endpoint, "UPDATE");
  assert.equal(classifyEndpoint({ name: "mystery_action", description: "Deletes the selected branch" }).endpoint, "DELETE");
  assert.deepEqual(classifyEndpoint({ name: "mystery_action", description: "" }), {
    endpoint: "EXECUTE",
    confidence: "low",
    reviewReasons: ["No strong semantic signal found in tool name or description; defaulting conservatively to EXECUTE."],
  });
  assert.equal(normalizeSnakeCase("pullNumber"), "pull_number");
});

test("github discovery bundle validates and preserves provenance-bearing normalization", async (t) => {
  try {
    await access(bundlePath);
    await access(schemaPath);
  } catch {
    t.skip("GitHub golden-path fixture is not present in this checkout.");
    return;
  }

  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as DiscoveryBundle;
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as unknown;

  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormatsFn(ajv);
  const validate = ajv.compile(schema);

  assert.equal(validate(bundle), true, validate.errors ? ajv.errorsText(validate.errors) : "bundle should validate");
  assert.equal(bundle.schema_version, "1.0.0-draft");
  assert.equal(bundle.raw_capture.tools.length, bundle.normalized_bundle.operations.length);
  assert.ok(bundle.raw_capture.tools.length > 0);
  assert.ok(bundle.normalized_bundle.warnings.length > 0);

  const ambiguousWarning = bundle.normalized_bundle.warnings.find(
    (warning) => warning.tool === "create_or_update_file" && warning.code === "REVIEW_REQUIRED",
  );
  assert.ok(ambiguousWarning, "expected ambiguous create_or_update_file classification warning");

  const operation = bundle.normalized_bundle.operations.find(
    (entry) => entry.operation_name === "create_or_update_file",
  );
  assert.ok(operation, "expected normalized operation for create_or_update_file");
  assert.equal(operation?.needs_review, true);
  assert.equal(operation?.endpoint, "UPDATE");
  assert.equal(operation?.provenance.input_schema_present, true);
  assert.equal(operation?.provenance.inference_sources?.endpoint, "heuristic_classification");
});
