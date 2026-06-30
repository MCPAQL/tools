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
  assert.equal(
    input.taskResults
      .filter((result) => result.taskId === "error-issue-retry")
      .every((result) => result.inducedError?.turnsToRecovery === 1),
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

test("GitHub LLM benchmark prompt substitution does not expose secret env vars", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-llm-benchmark-secret-"));
  const manifestPath = path.join(root, "manifest.json");
  const artifactRoot = path.join(root, "artifacts", "github-llm-benchmark");
  const outputPath = path.join(artifactRoot, "metrics-input.json");
  const originalSecret = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "super-secret-value";
  await writeFile(manifestPath, JSON.stringify({
    suite: "github-mcp",
    runCountPerConfiguration: 1,
    tasks: [
      {
        id: "secret-placeholder",
        taskType: "issue_read",
        prompt: "Open ${GITHUB_BENCHMARK_OWNER}/${GITHUB_BENCHMARK_REPO}; never inline ${ANTHROPIC_API_KEY}.",
        expectedFirstTool: {
          rawMcp: "list_issues",
          mcpaqlAdapted: "mcp_aql_read",
        },
        expectedOperation: "list_issues",
        requiresFixture: ["repository"],
        mutation: false,
        inducedError: { enabled: false },
        expectedRawMethod: null,
      },
    ],
  }, null, 2), "utf8");

  try {
    const input = await runGitHubLlmBenchmark({
      manifestPath,
      artifactRoot,
      outputPath,
      dryRun: true,
      runsPerConfiguration: 1,
      model: "mock-claude",
    });

    const promptPath = input.taskResults[0].rawDataPaths?.prompts?.[0];
    assert.ok(promptPath);
    const prompt = await readFile(promptPath, "utf8");
    assert.doesNotMatch(prompt, /super-secret-value/);
    assert.match(prompt, /DRY_RUN_ANTHROPIC_API_KEY/);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalSecret;
    }
  }
});

test("GitHub LLM benchmark dry-run honors single configuration selection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-llm-benchmark-config-"));
  const manifestPath = path.join(root, "manifest.json");
  const artifactRoot = path.join(root, "artifacts", "github-llm-benchmark");
  const outputPath = path.join(artifactRoot, "metrics-input.json");
  await writeFile(manifestPath, JSON.stringify({
    suite: "github-mcp",
    runCountPerConfiguration: 1,
    tasks: [
      {
        id: "issue-list-open",
        taskType: "issue_read",
        prompt: "List issues in ${GITHUB_BENCHMARK_OWNER}/${GITHUB_BENCHMARK_REPO}.",
        expectedFirstTool: {
          rawMcp: "list_issues",
          mcpaqlAdapted: "mcp_aql_read",
        },
        expectedOperation: "list_issues",
        requiresFixture: ["repository"],
        mutation: false,
        inducedError: { enabled: false },
        expectedRawMethod: null,
      },
    ],
  }, null, 2), "utf8");

  const input = await runGitHubLlmBenchmark({
    manifestPath,
    artifactRoot,
    outputPath,
    dryRun: true,
    runsPerConfiguration: 1,
    configIds: ["raw_mcp"],
    model: "mock-claude",
  });

  assert.deepEqual(input.configurations.map((configuration) => configuration.id), ["raw_mcp"]);
  assert.equal(input.taskResults.length, 1);
  assert.equal(input.taskResults[0].configId, "raw_mcp");
  await stat(path.join(artifactRoot, "raw-mcp", "tool-definitions.json"));
  await assert.rejects(
    stat(path.join(artifactRoot, "mcpaql-adapted", "tool-definitions.json")),
    /ENOENT/,
  );
});

test("GitHub LLM benchmark rejects wildcard fixture allocations for mutable tasks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-llm-benchmark-mutable-"));
  const manifestPath = path.join(root, "manifest.json");
  const fixturePath = path.join(root, "fixtures.json");
  const artifactRoot = path.join(root, "artifacts", "github-llm-benchmark");
  const outputPath = path.join(artifactRoot, "metrics-input.json");
  await writeFile(manifestPath, JSON.stringify({
    suite: "github-mcp",
    runCountPerConfiguration: 1,
    tasks: [
      {
        id: "issue-close",
        taskType: "issue_update",
        prompt: "Close issue ${FIXTURE_ISSUE_NUMBER}.",
        expectedFirstTool: {
          rawMcp: "update_issue_state",
          mcpaqlAdapted: "mcp_aql_update",
        },
        expectedOperation: "issue_write",
        requiresFixture: ["open_issue"],
        mutation: true,
        inducedError: { enabled: false },
        expectedRawMethod: null,
        expectedAdaptedMethod: "update",
      },
    ],
  }, null, 2), "utf8");
  await writeFile(fixturePath, JSON.stringify({
    allocations: [
      {
        taskId: "issue-close",
        variables: {
          FIXTURE_ISSUE_NUMBER: 123,
        },
      },
    ],
  }, null, 2), "utf8");

  await assert.rejects(
    runGitHubLlmBenchmark({
      manifestPath,
      artifactRoot,
      outputPath,
      fixtureInputPath: fixturePath,
      dryRun: true,
      runsPerConfiguration: 1,
      configIds: ["raw_mcp"],
      model: "mock-claude",
    }),
    /requires an exact fixture allocation/,
  );
});
