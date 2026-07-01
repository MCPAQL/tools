import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
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

test("GitHub LLM benchmark closes connected live clients when later setup fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-llm-benchmark-live-cleanup-"));
  const manifestPath = path.join(root, "manifest.json");
  const artifactRoot = path.join(root, "artifacts", "github-llm-benchmark");
  const outputPath = path.join(artifactRoot, "metrics-input.json");
  const rawServerPath = path.join(root, "raw-server.cjs");
  const adaptedServerPath = path.join(root, "adapted-server.cjs");
  const rawClosedPath = path.join(root, "raw-closed.txt");
  const rawPidPath = path.join(root, "raw-pid.txt");

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
  await writeFile(rawServerPath, `
const fs = require("node:fs");
const closedPath = process.argv[2];
const pidPath = process.argv[3];
fs.writeFileSync(pidPath, String(process.pid));
let buffer = "";
let closed = false;
function markClosed() {
  if (closed) return;
  closed = true;
  fs.writeFileSync(closedPath, "closed");
  process.exit(0);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      const requestedProtocolVersion = message.params && message.params.protocolVersion;
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: requestedProtocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-github-mcp", version: "0.1.0" }
        }
      }) + "\\n");
    }
  }
});
process.stdin.on("end", markClosed);
process.stdin.on("close", markClosed);
setInterval(() => {}, 1000);
`, "utf8");
  await writeFile(adaptedServerPath, "process.exit(1);\n", "utf8");

  await withEnv({
    ANTHROPIC_API_KEY: "test-anthropic-key",
    GITHUB_BENCHMARK_OWNER: "MCPAQL",
    GITHUB_BENCHMARK_REPO: "tools-benchmark",
    GITHUB_BENCHMARK_ASSIGNEE: "benchmark-assignee",
    GITHUB_BENCHMARK_REVIEWER: "benchmark-reviewer",
    GITHUB_PERSONAL_ACCESS_TOKEN: "test-github-token",
    GITHUB_TOOLSETS: "default,actions,labels,git",
    RAW_GITHUB_MCP_COMMAND: `${JSON.stringify(process.execPath)} ${JSON.stringify(rawServerPath)} ${JSON.stringify(rawClosedPath)} ${JSON.stringify(rawPidPath)}`,
    MCPAQL_GITHUB_ADAPTER_SERVER: adaptedServerPath,
    MCPAQL_GITHUB_ADAPTER_SCHEMA: path.join(root, "adapter.schema.json"),
    MCPAQL_GITHUB_ADAPTER_PROVENANCE: path.join(root, "adapter.provenance.json"),
  }, async () => {
    let rawClosed = false;
    try {
      await assert.rejects(
        runGitHubLlmBenchmark({
          manifestPath,
          artifactRoot,
          outputPath,
          dryRun: false,
          runsPerConfiguration: 1,
          model: "claude-test",
        }),
      );
      await waitForFile(rawClosedPath);
      rawClosed = true;
    } finally {
      if (!rawClosed) await killProcessIfAlive(rawPidPath);
    }
  });
});

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(filePath);
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      await sleep(50);
    }
  }
  await stat(filePath);
}

async function killProcessIfAlive(pidPath: string): Promise<void> {
  try {
    const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    if (Number.isInteger(pid)) process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ESRCH")) throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
