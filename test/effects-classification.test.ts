import assert from "node:assert/strict";
import test from "node:test";

import { importToolCatalog } from "../src/catalog-import.js";
import { annotationConflicts, classifyFromEffects, GATING_FLAGS, readEffectFlags } from "../src/effects-classification.js";
import { normalizeTools, type RawTool } from "../src/interrogate.js";
import type { InterrogationConfig } from "../src/types.js";

// A complete flag set with every gating flag false; tests switch individual flags on.
const none = Object.fromEntries(GATING_FLAGS.map((flag) => [flag, false])) as Record<string, boolean>;

test("readEffectFlags keeps canonical booleans and reports unknown gating flags", () => {
  const complete = readEffectFlags({ effects: { ...none, accessesNetwork: true, vendorOnly: true } });
  assert.equal(complete?.complete, true);
  assert.equal(complete?.flags.accessesNetwork, true);
  assert.equal("vendorOnly" in (complete?.flags ?? {}), false);

  const partial = readEffectFlags({ effects: { idempotent: true } });
  assert.equal(partial?.complete, false);
  assert.deepEqual(partial?.unknown, [...GATING_FLAGS]);

  const malformed = readEffectFlags({ effects: { ...none, executesForeignCode: "true" } });
  assert.equal(malformed?.complete, false);
  assert.deepEqual(malformed?.unknown, ["executesForeignCode"]);

  assert.equal(readEffectFlags({ effects: { vendorOnly: true } }), undefined);
  assert.equal(readEffectFlags({ effects: [true] }), undefined);
  assert.equal(readEffectFlags({}), undefined);
  assert.equal(readEffectFlags({ _meta: { "example/effects": { ...none, mutatesDevice: true } } }, "_meta.example/effects")?.flags.mutatesDevice, true);
});

test("classifyFromEffects maps effects to endpoint and danger by precedence", () => {
  const cases: Array<[Record<string, boolean>, string, string]> = [
    [{ executesForeignCode: true, mayDiscardData: true }, "EXECUTE", "dangerous"],
    [{ mutatesDevice: true }, "EXECUTE", "dangerous"],
    [{ mayDiscardData: true }, "DELETE", "destructive"],
    [{ mayDiscardData: true, mutatesTarget: true }, "UPDATE", "destructive"],
    [{ mayDiscardData: true, writesFilesystem: true }, "CREATE", "destructive"],
    [{ mutatesTarget: true }, "UPDATE", "reversible"],
    [{ changesUiState: true }, "UPDATE", "reversible"],
    [{ writesFilesystem: true }, "CREATE", "reversible"],
    [{ accessesNetwork: true, launchesProcess: true }, "READ", "safe"],
    [{ mutatesSession: true, idempotent: true }, "READ", "safe"],
  ];
  for (const [effects, endpoint, danger] of cases) {
    const result = classifyFromEffects({ ...none, ...effects });
    assert.equal(result.endpoint, endpoint, JSON.stringify(effects));
    assert.equal(result.danger, danger, JSON.stringify(effects));
  }
  // Reads that launch processes or reach the network are flagged for review.
  assert.equal(classifyFromEffects({ ...none, launchesProcess: true }).reviewReasons.length, 1);
  assert.equal(classifyFromEffects({ ...none, accessesNetwork: true, launchesProcess: true }).reviewReasons.length, 2);
  assert.equal(classifyFromEffects({ ...none, mutatesSession: true }).reviewReasons.length, 0);
});

test("annotationConflicts flags readOnly endpoint and destructive danger disagreements", () => {
  assert.deepEqual(annotationConflicts({ readOnlyHint: true }, "READ", "safe"), []);
  assert.equal(annotationConflicts({ readOnlyHint: true }, "UPDATE", "reversible").length, 1);
  assert.deepEqual(annotationConflicts({ readOnlyHint: false }, "READ", "safe"), []);
  assert.equal(annotationConflicts({ destructiveHint: true }, "READ", "safe").length, 1);
  assert.equal(annotationConflicts({ destructiveHint: true }, "UPDATE", "reversible").length, 1);
  assert.deepEqual(annotationConflicts({ destructiveHint: true }, "UPDATE", "destructive"), []);
  assert.deepEqual(annotationConflicts({ destructiveHint: true }, "EXECUTE", "dangerous"), []);
  assert.deepEqual(annotationConflicts(undefined, "READ", "safe"), []);
});

test("complete effect flags override the name heuristic and surface annotation conflicts", () => {
  const tools = [
    // The name says "get_", but the effects say it runs foreign code.
    { name: "get_trace", description: "Trace", effects: { ...none, executesForeignCode: true }, annotations: { readOnlyHint: true } },
    // No effects: the name heuristic applies.
    { name: "list_things", description: "List things" },
  ] as unknown as RawTool[];

  const { operations, warnings } = normalizeTools(tools);
  assert.equal(operations[0].endpoint, "EXECUTE");
  assert.equal(operations[0].danger_level, "dangerous");
  assert.equal(operations[0].endpoint_confidence, "high");
  assert.equal(operations[0].provenance.inference_sources?.endpoint, "direct_source_metadata");
  assert.equal(operations[1].endpoint, "READ");
  assert.equal(operations[1].provenance.inference_sources?.endpoint, "heuristic_classification");

  const conflict = warnings.find((warning) => warning.code === "ANNOTATION_CONFLICT");
  assert.equal(conflict?.tool, "get_trace");
  assert.match(conflict?.message ?? "", /readOnlyHint=true disagrees with endpoint EXECUTE/);
  assert.ok(operations[0].needs_review);
  // Review notes on dangerous operations are warnings, not info.
  assert.ok(warnings.some((warning) => warning.tool === "get_trace" && warning.code === "REVIEW_REQUIRED" && warning.severity === "warning"));
});

test("incomplete or malformed effect flags never lower the classification", () => {
  const tools = [
    { name: "delete_repository", description: "Delete", effects: { idempotent: true } },
    { name: "delete_branch", description: "Delete", effects: { accessesNetwork: true } },
    { name: "run_shell", description: "Run", effects: { ...none, executesForeignCode: "true", launchesProcess: true } },
  ] as unknown as RawTool[];
  const { operations, warnings } = normalizeTools(tools);
  assert.deepEqual(operations.map((operation) => operation.endpoint), ["DELETE", "DELETE", "EXECUTE"]);
  for (const operation of operations) {
    assert.equal(operation.endpoint_confidence, "low");
    assert.equal(operation.provenance.inference_sources?.endpoint, "heuristic_classification");
    assert.ok(operation.review_reasons.some((reason) => /Effect flags are incomplete/.test(reason)));
  }
  assert.ok(warnings.some((warning) => warning.tool === "run_shell" && /unknown: executesForeignCode/.test(warning.message)));
});

test("tools without effects get annotation conflicts too", () => {
  const { warnings } = normalizeTools([{ name: "browser_snapshot", description: "Snapshot", annotations: { readOnlyHint: true } }] as RawTool[]);
  assert.ok(warnings.some((warning) => warning.code === "ANNOTATION_CONFLICT" && warning.tool === "browser_snapshot"));
});

test("classification.effects_field is honored end to end through catalog import", () => {
  const config: InterrogationConfig = {
    name: "custom",
    server_url: "stdio://custom",
    transport: { type: "stdio", command: "x" },
    classification: { effects_field: "_meta.example/effects" },
  };
  const tools = [{ name: "list_devices", description: "List", _meta: { "example/effects": { ...none, mutatesDevice: true } } }];
  const bundle = importToolCatalog({ config, catalogText: JSON.stringify({ tools }) });
  assert.equal(bundle.normalized_bundle.operations[0].endpoint, "EXECUTE");

  const defaultField = importToolCatalog({ config: { ...config, classification: undefined }, catalogText: JSON.stringify({ tools }) });
  assert.equal(defaultField.normalized_bundle.operations[0].endpoint, "READ");
});
