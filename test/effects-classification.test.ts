import assert from "node:assert/strict";
import test from "node:test";

import { annotationConflicts, classifyFromEffects, readEffectFlags } from "../src/effects-classification.js";
import { normalizeTools, type RawTool } from "../src/interrogate.js";

test("readEffectFlags keeps canonical boolean flags only", () => {
  assert.deepEqual(
    readEffectFlags({ effects: { executesForeignCode: true, accessesNetwork: false, vendorOnly: true, idempotent: "yes" } }),
    { executesForeignCode: true, accessesNetwork: false },
  );
  assert.equal(readEffectFlags({ effects: { vendorOnly: true } }), undefined);
  assert.equal(readEffectFlags({ effects: [true] }), undefined);
  assert.equal(readEffectFlags({}), undefined);
  assert.deepEqual(readEffectFlags({ sideEffects: { mutatesDevice: true } }, "sideEffects"), { mutatesDevice: true });
});

test("classifyFromEffects maps effects to endpoint and danger by precedence", () => {
  const cases: Array<[Record<string, boolean>, string, string]> = [
    [{ executesForeignCode: true, mayDiscardData: true }, "EXECUTE", "dangerous"],
    [{ mutatesDevice: true }, "EXECUTE", "dangerous"],
    [{ mayDiscardData: true }, "DELETE", "destructive"],
    [{ mayDiscardData: true, mutatesTarget: true }, "UPDATE", "destructive"],
    [{ mutatesTarget: true }, "UPDATE", "reversible"],
    [{ changesUiState: true }, "UPDATE", "reversible"],
    [{ writesFilesystem: true }, "CREATE", "reversible"],
    [{ accessesNetwork: true, launchesProcess: true }, "READ", "safe"],
    [{ mutatesSession: true, idempotent: true }, "READ", "safe"],
  ];
  for (const [effects, endpoint, danger] of cases) {
    const result = classifyFromEffects(effects);
    assert.equal(result.endpoint, endpoint, JSON.stringify(effects));
    assert.equal(result.danger, danger, JSON.stringify(effects));
  }
  assert.equal(classifyFromEffects({ accessesNetwork: true }).reviewReasons.length, 1);
  assert.equal(classifyFromEffects({ mayDiscardData: true, mutatesTarget: true }).reviewReasons.length, 1);
});

test("annotationConflicts flags readOnly and destructive disagreements only", () => {
  assert.deepEqual(annotationConflicts({ readOnlyHint: true }, "READ"), []);
  assert.equal(annotationConflicts({ readOnlyHint: true }, "UPDATE").length, 1);
  assert.deepEqual(annotationConflicts({ readOnlyHint: false }, "READ"), []);
  assert.equal(annotationConflicts({ destructiveHint: true }, "READ").length, 1);
  assert.deepEqual(annotationConflicts({ destructiveHint: true }, "EXECUTE"), []);
  assert.deepEqual(annotationConflicts(undefined, "READ"), []);
});

test("effect flags override the name heuristic and surface annotation conflicts", () => {
  const tools = [
    // The name says "get_", but the effects say it runs foreign code.
    { name: "get_trace", description: "Trace", effects: { executesForeignCode: true }, annotations: { readOnlyHint: true } },
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
});

test("a custom effects field is honored", () => {
  const tools = [{ name: "list_devices", description: "List", sideEffects: { mutatesDevice: true } }] as unknown as RawTool[];
  assert.equal(normalizeTools(tools).operations[0].endpoint, "READ");
  assert.equal(normalizeTools(tools, { effectsField: "sideEffects" }).operations[0].endpoint, "EXECUTE");
});
