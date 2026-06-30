import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runGitHubLlmBenchmark } from "../src/github-llm-benchmark.js";
import { buildLlmMetricsReport, loadLlmMetricsInput } from "../src/parity/llm-metrics.js";

test("GitHub LLM benchmark dry-run emits normalizable metrics input and artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-llm-benchmark-"));
  const manifestPath = path.join(root, "manifest.json");
  const artifactRoot = path.join(root, "artifacts", "github-llm-benchmark");
  const outputPath = path.join(artifactRoot, "metrics-input.json");
  await writeFile(manifestPath, JSON.stringify({
    suite: "github-mcp",
    runCountPerConfiguration: 1,
    tasks: [
      {
        id: "issue-get-by-number",
        taskType: "issue_read",
        prompt: "Open benchmark issue ${FIXTURE_ISSUE_NUMBER} in ${GITHUB_BENCHMARK_OWNER}/${GITHUB_BENCHMARK_REPO}.",
        expectedFirstTool: {
          rawMcp: "issue_read",
          mcpaqlAdapted: "mcp_aql_read",
        },
        expectedOperation: "issue_read",
        requiresFixture: ["issue"],
        mutation: false,
        inducedError: { enabled: false },
        expectedRawMethod: "get",
        expectedAdaptedMethod: "get",
      },
      {
        id: "error-issue-retry",
        taskType: "recovery_issue_read",
        prompt: "Retry issue ${FIXTURE_ISSUE_NUMBER} after an injected bad argument.",
        expectedFirstTool: {
          rawMcp: "issue_read",
          mcpaqlAdapted: "mcp_aql_read",
        },
        expectedOperation: "issue_read",
        requiresFixture: ["issue"],
        mutation: false,
        inducedError: {
          enabled: true,
          errorCode: "BAD_ISSUE_NUMBER",
        },
        expectedRawMethod: "get",
        expectedAdaptedMethod: "get",
      },
    ],
  }, null, 2), "utf8");

  const input = await runGitHubLlmBenchmark({
    manifestPath,
    artifactRoot,
    outputPath,
    dryRun: true,
    runsPerConfiguration: 1,
    model: "mock-claude",
  });

  assert.equal(input.taskResults.length, 4);
  assert.equal(input.model.provider, "mock");
  assert.match(input.notes ?? "", /Dry run only/);
  assert.equal(input.taskResults.every((result) => result.outcome === "completed"), true);
  assert.equal(input.taskResults.every((result) => result.firstCallSuccess === true), true);
  assert.equal(
    input.taskResults
      .filter((result) => result.taskId === "error-issue-retry")
      .every((result) => result.inducedError?.recoveredWithinTwoTurns === true),
    true,
  );

  const loaded = await loadLlmMetricsInput(outputPath);
  const report = buildLlmMetricsReport(loaded);
  assert.equal(report.aggregates.length, 2);
  assert.equal(report.aggregates.every((aggregate) => aggregate.completedTaskCount === 2), true);

  const firstResult = loaded.taskResults[0];
  assert.ok(firstResult.rawDataPaths?.transcripts?.[0]);
  assert.ok(firstResult.rawDataPaths.prompts?.[0]);
  assert.ok(firstResult.rawDataPaths.logs?.[0]);
  await stat(firstResult.rawDataPaths.transcripts[0]);
  const transcript = await readFile(firstResult.rawDataPaths.transcripts[0], "utf8");
  assert.match(transcript, /"type":"model_response"/);
  assert.match(transcript, /"type":"tool_result"/);
});

