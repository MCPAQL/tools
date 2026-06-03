import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  applyParamMappings,
  canonicalize,
  classify,
  extractMcpaqlPayload,
  extractOfficialPayload,
  firstDiff,
  maskVariantTokens,
  normalize,
  resolveAdapterPaths,
  resolveUpstreamToolName,
} from "../src/parity-runner.js";

test("resolveAdapterPaths defaults to bundled files beside the adapter server", () => {
  const serverPath = path.join("/tmp", "adapter", "dist", "server.js");

  assert.deepEqual(resolveAdapterPaths({ adapterServerJs: serverPath }), {
    schemaPath: path.join("/tmp", "adapter", "dist", "schema.json"),
    provenancePath: path.join("/tmp", "adapter", "dist", "provenance.json"),
    adapterCwd: path.join("/tmp", "adapter"),
  });
});

test("resolveAdapterPaths supports explicit overrides and non-dist server filenames", () => {
  const serverPath = path.join("/tmp", "adapter", "build", "index.js");

  assert.deepEqual(resolveAdapterPaths({
    adapterServerJs: serverPath,
    schemaPath: path.join("/tmp", "schema.json"),
    provenancePath: path.join("/tmp", "prov.json"),
    adapterCwd: path.join("/tmp", "work"),
  }), {
    schemaPath: path.join("/tmp", "schema.json"),
    provenancePath: path.join("/tmp", "prov.json"),
    adapterCwd: path.join("/tmp", "work"),
  });
});

test("normalize masks volatile keys recursively", () => {
  const input = {
    id: 123,
    name: "repo",
    owner: {
      node_id: "abc",
      login: "mick",
    },
    items: [
      { html_url: "https://example.test", value: 42 },
      { request_id: "req-1", value: 43 },
    ],
  };

  assert.deepEqual(normalize(input), {
    id: "<VOL>",
    name: "repo",
    owner: {
      node_id: "<VOL>",
      login: "mick",
    },
    items: [
      { html_url: "<VOL>", value: 42 },
      { request_id: "<VOL>", value: 43 },
    ],
  });
});

test("normalize preserves stable numeric fields by default", () => {
  assert.deepEqual(
    normalize({ number: 1, size: 200, nested: { id: "abc" } }),
    { number: 1, size: 200, nested: { id: "<VOL>" } },
  );
});

test("canonicalize recursively sorts object keys without reordering arrays", () => {
  const canonical = canonicalize({
    z: 1,
    a: { y: 2, x: 3 },
    list: [{ b: 1, a: 2 }],
  });

  assert.equal(JSON.stringify(canonical), '{"a":{"x":3,"y":2},"list":[{"a":2,"b":1}],"z":1}');
});

test("maskVariantTokens masks variant words in string values and key names", () => {
  const masked = maskVariantTokens({
    "official-title": "created by official",
    nested: {
      "mcpaql-url": "used by mcpaql",
    },
  });

  assert.deepEqual(masked, {
    "<VARIANT>-title": "created by <VARIANT>",
    nested: {
      "<VARIANT>-url": "used by <VARIANT>",
    },
  });
});

test("applyParamMappings renames mapped params and preserves unmapped params", () => {
  assert.deepEqual(
    applyParamMappings({ owner: "MCPAQL", repo: "tools", unchanged: true }, { repo: "repository" }),
    { owner: "MCPAQL", repository: "tools", unchanged: true },
  );
});

test("resolveUpstreamToolName uses provenance source names when available", () => {
  assert.equal(
    resolveUpstreamToolName("create_issue", { create_issue: "Create Issue" }),
    "Create Issue",
  );
  assert.equal(resolveUpstreamToolName("list_issues", {}), "list_issues");
});

test("extractOfficialPayload prefers structured content and parses JSON text", () => {
  assert.deepEqual(
    extractOfficialPayload({ structuredContent: { ok: true }, content: [{ type: "text", text: "{\"ok\":false}" }] }),
    { ok: true },
  );
  assert.deepEqual(
    extractOfficialPayload({ content: [{ type: "text", text: "{\"ok\":true}" }] }),
    { ok: true },
  );
  assert.equal(
    extractOfficialPayload({ content: [{ type: "text", text: "plain text" }] }),
    "plain text",
  );
});

test("extractMcpaqlPayload unwraps success, failure, and upstream error envelopes", () => {
  assert.deepEqual(
    extractMcpaqlPayload({ success: true, data: { structured_content: { ok: true } } }),
    { ok: true },
  );
  assert.deepEqual(
    extractMcpaqlPayload({ success: false, error: { code: "NOPE" } }),
    { error: { code: "NOPE" } },
  );
  assert.deepEqual(
    extractMcpaqlPayload({ success: true, data: { is_error: true, content: [{ type: "text", text: "boom" }] } }),
    { error: { code: "UPSTREAM", message: "boom" } },
  );
});

test("classify treats key-order-only differences as identical", () => {
  assert.deepEqual(
    classify(true, true, { x: 1, y: { a: 2, b: 3 } }, { y: { b: 3, a: 2 }, x: 1 }),
    { cls: "IDENTICAL" },
  );
});

test("classify treats volatile-only differences as structural parity", () => {
  assert.deepEqual(
    classify(true, true, { id: 1, name: "repo" }, { id: 2, name: "repo" }),
    { cls: "STRUCTURAL_PARITY" },
  );
});

test("classify treats number and size differences as divergent by default", () => {
  assert.equal(
    classify(true, true, { number: 1, size: 200 }, { number: 2, size: 201 }).cls,
    "DIVERGENT",
  );
});

test("classify can mask write-variant numeric metadata explicitly", () => {
  assert.deepEqual(
    classify(
      true,
      true,
      { number: 1, size: 200, name: "created" },
      { number: 2, size: 201, name: "created" },
      { extraVolatileKeyPatterns: [/^number$/i, /^size$/i] },
    ),
    { cls: "STRUCTURAL_PARITY" },
  );
});

test("classify distinguishes both-side and one-side errors", () => {
  assert.equal(classify(false, false, { err: "official" }, { err: "mcpaql" }).cls, "BOTH_ERROR");
  assert.equal(classify(false, true, { err: "official" }, { ok: true }).cls, "OFFICIAL_ERROR");
  assert.equal(classify(true, false, { ok: true }, { err: "mcpaql" }).cls, "MCPAQL_ERROR");
});

test("classify reports a useful first diff for divergent payloads", () => {
  const result = classify(true, true, { root: { x: 1 } }, { root: { x: 2 } });

  assert.equal(result.cls, "DIVERGENT");
  assert.match(result.detail ?? "", /root\.x: 1 vs 2/);
});

test("firstDiff reports array length and key differences", () => {
  assert.equal(firstDiff([1], [1, 2]), "root: length 1 vs 2");
  assert.equal(
    firstDiff({ a: 1 }, { b: 1 }),
    "root: keys differ (only-official: a | only-mcpaql: b)",
  );
});
