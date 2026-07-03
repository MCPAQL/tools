import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  setupGitHubBenchmarkFixtures,
  teardownGitHubBenchmarkFixtures,
  type GitHubFixtureClient,
} from "../src/github-llm-fixtures.js";
import { runGitHubLlmBenchmark } from "../src/github-llm-benchmark.js";

test("GitHub fixture setup emits exact per-task config run allocations consumed by the runner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-llm-fixtures-"));
  const manifestPath = path.join(root, "manifest.json");
  const artifactRoot = path.join(root, "artifacts", "github-llm-benchmark");
  const setupPath = path.join(artifactRoot, "fixtures", "setup.json");
  const teardownPath = path.join(artifactRoot, "fixtures", "teardown.json");
  const metricsPath = path.join(artifactRoot, "metrics-input.json");
  await writeManifest(manifestPath, ["issue-close", "pull-create", "release-create-draft"]);

  const setup = await setupGitHubBenchmarkFixtures({
    manifestPath,
    outputPath: setupPath,
    artifactRoot,
    runsPerConfiguration: 2,
    dryRun: true,
    owner: "MCPAQL",
    repo: "fixture-benchmark",
    assignee: "benchmark-assignee",
    reviewer: "benchmark-reviewer",
  });

  assert.equal(setup.allocations.length, 12);
  assert.equal(setup.allocations.every((allocation) => allocation.status === "ready"), true);
  assert.equal(setup.allocations.every((allocation) => allocation.taskId && allocation.configId && allocation.runIndex !== undefined), true);
  assert.equal(setup.allocations.every((allocation) => allocation.completionVerifier), true);
  assert.equal(setup.allocations.every((allocation) => allocation.rawDataPaths.fixtures.includes(setupPath)), true);

  const issueNumbers = setup.allocations
    .filter((allocation) => allocation.taskId === "issue-close")
    .map((allocation) => allocation.variables.FIXTURE_ISSUE_NUMBER);
  assert.equal(new Set(issueNumbers).size, 4);

  const pullBranches = setup.allocations
    .filter((allocation) => allocation.taskId === "pull-create")
    .map((allocation) => allocation.variables.FIXTURE_BRANCH);
  assert.equal(new Set(pullBranches).size, 4);
  await stat(setupPath);

  const input = await runGitHubLlmBenchmark({
    manifestPath,
    outputPath: metricsPath,
    artifactRoot,
    fixtureInputPath: setupPath,
    dryRun: true,
    runsPerConfiguration: 2,
    model: "mock-claude",
  });
  assert.equal(input.taskResults.length, 12);
  assert.equal(input.taskResults.every((result) => result.outcome === "completed"), true);

  const teardown = await teardownGitHubBenchmarkFixtures({
    setupPath,
    outputPath: teardownPath,
    dryRun: true,
  });
  assert.equal(teardown.errors.length, 0);
  assert.equal(teardown.results.length, setup.createdResources.length);
  await stat(teardownPath);
});

test("GitHub fixture setup seeds branch fixtures, isolates file reads, and includes verifier identifiers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-llm-fixtures-review-"));
  const manifestPath = path.join(root, "manifest.json");
  const artifactRoot = path.join(root, "artifacts", "github-llm-benchmark");
  const setupPath = path.join(artifactRoot, "fixtures", "setup.json");
  await writeManifest(manifestPath, [
    "issue-create-basic",
    "issue-create-with-labels",
    "issue-update-title",
    "pull-comments",
    "pull-create",
    "pull-request-reviewers",
    "pull-add-review-comment",
    "pull-submit-review",
    "pull-merge",
    "repo-file-read",
    "repo-file-update",
    "issue-comment",
    "issue-assign",
    "issue-label-add",
    "issue-label-remove",
    "error-issue-comment-wrong-number",
    "error-pr-reviewer-invalid",
    "error-file-update-stale-sha",
    "error-label-add-invalid",
  ]);

  const setup = await setupGitHubBenchmarkFixtures({
    manifestPath,
    outputPath: setupPath,
    artifactRoot,
    runsPerConfiguration: 1,
    dryRun: true,
    owner: "MCPAQL",
    repo: "fixture-benchmark",
    assignee: "benchmark-assignee",
    reviewer: "benchmark-reviewer",
  });

  const pullCreate = mustFindAllocation(setup.allocations, "pull-create", "raw_mcp");
  const pullBranch = String(pullCreate.variables.FIXTURE_BRANCH);
  const pullResources = setup.createdResources.filter((resource) => pullCreate.createdResourceIds.includes(resource.id));
  assert.ok(pullResources.some((resource) => resource.type === "branch" && resource.metadata.branch === pullBranch));
  assert.ok(pullResources.some((resource) => resource.type === "file" && resource.metadata.branch === pullBranch));

  const pullMerge = mustFindAllocation(setup.allocations, "pull-merge", "raw_mcp");
  const mergeResources = setup.createdResources.filter((resource) => pullMerge.createdResourceIds.includes(resource.id));
  assert.ok(mergeResources.some((resource) =>
    resource.type === "expected_file" &&
    resource.metadata.path === pullMerge.variables.FIXTURE_CHANGED_FILE &&
    resource.metadata.branch === pullMerge.variables.FIXTURE_BASE_BRANCH
  ));

  const fileRead = mustFindAllocation(setup.allocations, "repo-file-read", "raw_mcp");
  assert.equal(fileRead.variables.FIXTURE_README_PATH, fileRead.variables.FIXTURE_FILE_PATH);

  for (const configId of ["raw_mcp", "mcpaql_adapted"] as const) {
    const issueCreate = mustFindAllocation(setup.allocations, "issue-create-basic", configId);
    assert.match(String(verifierParams(issueCreate).query), /in:title/);
    assert.doesNotMatch(String(verifierParams(issueCreate).query), /label:benchmark/);
    assert.equal(verifierExpected(issueCreate, "expectedTextIncludes"), `Benchmark issue ${String(issueCreate.variables.RUN_ID)}`);

    const labeledIssueCreate = mustFindAllocation(setup.allocations, "issue-create-with-labels", configId);
    assert.match(String(verifierParams(labeledIssueCreate).query), /in:title/);
    assert.match(String(verifierParams(labeledIssueCreate).query), /label:benchmark/);
    assert.match(String(verifierParams(labeledIssueCreate).query), /label:documentation/);
    assert.equal(verifierExpected(labeledIssueCreate, "expectedTextIncludes"), `Labeled benchmark ${String(labeledIssueCreate.variables.RUN_ID)}`);

    const reviewer = mustFindAllocation(setup.allocations, "error-pr-reviewer-invalid", configId);
    assert.equal(verifierParams(reviewer).pull_number, reviewer.variables.FIXTURE_PULL_NUMBER);
    assert.equal(verifierExpected(reviewer, "expectedTextIncludes"), reviewer.variables.GITHUB_BENCHMARK_REVIEWER);

    const label = mustFindAllocation(setup.allocations, "error-label-add-invalid", configId);
    assert.match(String(verifierParams(label).query), /label:benchmark/);
    assert.equal(verifierExpected(label, "expectedTextIncludes"), label.variables.RUN_ID);

    const comment = mustFindAllocation(setup.allocations, "issue-comment", configId);
    assert.equal(verifierOperation(comment), "search_issues");
    assert.match(String(verifierParams(comment).query), /in:comments/);
    assert.match(String(verifierExpected(comment, "expectedTextIncludes")), /issue-comment/);

    const assign = mustFindAllocation(setup.allocations, "issue-assign", configId);
    assert.match(String(verifierParams(assign).query), new RegExp(`assignee:${String(assign.variables.GITHUB_BENCHMARK_ASSIGNEE)}`));
    assert.equal(verifierExpected(assign, "expectedTextIncludes"), assign.variables.RUN_ID);

    const labelAdd = mustFindAllocation(setup.allocations, "issue-label-add", configId);
    assert.match(String(verifierParams(labelAdd).query), /label:benchmark/);
    assert.equal(verifierExpected(labelAdd, "expectedTextIncludes"), labelAdd.variables.RUN_ID);

    const labelRemove = mustFindAllocation(setup.allocations, "issue-label-remove", configId);
    assert.match(String(verifierParams(labelRemove).query), /label:benchmark/);
    assert.match(String(verifierParams(labelRemove).query), /-label:needs-review/);
    assert.equal(verifierExpected(labelRemove, "expectedTextIncludes"), labelRemove.variables.RUN_ID);

    const title = mustFindAllocation(setup.allocations, "issue-update-title", configId);
    assert.equal(verifierParams(title).issue_number, title.variables.FIXTURE_ISSUE_NUMBER);
    assert.equal(verifierExpected(title, "expectedTextIncludes"), `Benchmark title ${String(title.variables.RUN_ID)}`);

    const fileUpdate = mustFindAllocation(setup.allocations, "repo-file-update", configId);
    assert.equal(verifierParams(fileUpdate).path, fileUpdate.variables.FIXTURE_FILE_PATH);
    assert.equal(verifierExpected(fileUpdate, "expectedTextIncludes"), `Benchmark update ${String(fileUpdate.variables.RUN_ID)}`);

    const fileRecovery = mustFindAllocation(setup.allocations, "error-file-update-stale-sha", configId);
    assert.equal(verifierParams(fileRecovery).path, fileRecovery.variables.FIXTURE_FILE_PATH);
    assert.equal(verifierExpected(fileRecovery, "expectedTextIncludes"), `Benchmark recovery ${String(fileRecovery.variables.RUN_ID)}`);

    const recoveryComment = mustFindAllocation(setup.allocations, "error-issue-comment-wrong-number", configId);
    assert.match(String(verifierParams(recoveryComment).query), /benchmark recovery/);
    assert.doesNotMatch(String(verifierParams(recoveryComment).query), new RegExp(String(recoveryComment.variables.RUN_ID)));
    assert.equal(verifierExpected(recoveryComment, "expectedTextIncludes"), "benchmark recovery");

    const requestReviewers = mustFindAllocation(setup.allocations, "pull-request-reviewers", configId);
    assert.equal(verifierParams(requestReviewers).pull_number, requestReviewers.variables.FIXTURE_PULL_NUMBER);
    assert.equal(verifierExpected(requestReviewers, "expectedTextIncludes"), requestReviewers.variables.GITHUB_BENCHMARK_REVIEWER);

    const pullComments = mustFindAllocation(setup.allocations, "pull-comments", configId);
    const commentResources = setup.createdResources.filter((resource) => pullComments.createdResourceIds.includes(resource.id));
    assert.ok(commentResources.some((resource) => resource.type === "pull_request_review_comment"));
    assert.equal(verifierParams(pullComments).pull_number, pullComments.variables.FIXTURE_PULL_NUMBER);
    assert.equal(verifierParams(pullComments).method, "get_review_comments");
    assert.equal(verifierExpected(pullComments, "expectedTextIncludes"), `Benchmark review comment ${String(pullComments.variables.RUN_ID)}`);

    const reviewComment = mustFindAllocation(setup.allocations, "pull-add-review-comment", configId);
    const reviewCommentResources = setup.createdResources.filter((resource) => reviewComment.createdResourceIds.includes(resource.id));
    assert.ok(reviewCommentResources.some((resource) => resource.type === "pending_review" && resource.teardown === "delete"));
    assert.equal(verifierParams(reviewComment).pull_number, reviewComment.variables.FIXTURE_PULL_NUMBER);
    assert.equal(verifierParams(reviewComment).method, "get_review_comments");
    assert.equal(verifierExpected(reviewComment, "expectedTextIncludes"), `Benchmark review comment ${String(reviewComment.variables.RUN_ID)}`);

    const submitReview = mustFindAllocation(setup.allocations, "pull-submit-review", configId);
    const submitReviewResources = setup.createdResources.filter((resource) => submitReview.createdResourceIds.includes(resource.id));
    assert.ok(submitReviewResources.some((resource) => resource.type === "pending_review" && resource.teardown === "delete"));
    assert.equal(verifierParams(submitReview).pull_number, submitReview.variables.FIXTURE_PULL_NUMBER);
    assert.equal(verifierParams(submitReview).method, "get_reviews");
    assert.equal(verifierExpected(submitReview, "expectedTextIncludes"), `Pending benchmark review for ${String(submitReview.variables.RUN_ID)}`);
  }
});

test("GitHub benchmark marks failed fixture allocations as task errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-llm-fixtures-error-"));
  const manifestPath = path.join(root, "manifest.json");
  const artifactRoot = path.join(root, "artifacts", "github-llm-benchmark");
  const setupPath = path.join(artifactRoot, "fixtures", "setup.json");
  const metricsPath = path.join(artifactRoot, "metrics-input.json");
  await writeManifest(manifestPath, ["issue-close"]);

  const setup = await setupGitHubBenchmarkFixtures({
    manifestPath,
    outputPath: setupPath,
    artifactRoot,
    runsPerConfiguration: 1,
    configIds: ["raw_mcp"],
    dryRun: true,
    owner: "MCPAQL",
    repo: "fixture-benchmark",
    assignee: "benchmark-assignee",
    reviewer: "benchmark-reviewer",
    continueOnError: true,
    client: new FailingIssueClient(),
  });
  assert.equal(setup.allocations.length, 1);
  assert.equal(setup.allocations[0].status, "error");

  const input = await runGitHubLlmBenchmark({
    manifestPath,
    outputPath: metricsPath,
    artifactRoot,
    fixtureInputPath: setupPath,
    dryRun: true,
    runsPerConfiguration: 1,
    configIds: ["raw_mcp"],
    model: "mock-claude",
  });
  assert.equal(input.taskResults.length, 1);
  assert.equal(input.taskResults[0].outcome, "error");
  assert.match(input.taskResults[0].notes ?? "", /Fixture setup failed/);

  const writtenSetup = JSON.parse(await readFile(setupPath, "utf8")) as { errors: unknown[] };
  assert.equal(writtenSetup.errors.length, 1);
});

async function writeManifest(manifestPath: string, taskIds?: string[]): Promise<void> {
  const tasks = [
    {
      id: "issue-create-basic",
      taskType: "issue_create",
      prompt: "Create an issue titled 'Benchmark issue ${RUN_ID}'.",
      expectedFirstTool: {
        rawMcp: "create_issue",
        mcpaqlAdapted: "mcp_aql_create",
      },
      expectedOperation: "issue_create",
      requiresFixture: [],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "issue-create-with-labels",
      taskType: "issue_create",
      prompt: "Create an issue titled 'Labeled benchmark ${RUN_ID}' with the benchmark and documentation labels.",
      expectedFirstTool: {
        rawMcp: "create_issue",
        mcpaqlAdapted: "mcp_aql_create",
      },
      expectedOperation: "issue_create",
      requiresFixture: ["label"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "issue-close",
      taskType: "issue_update",
      prompt: "Close issue ${FIXTURE_ISSUE_NUMBER} as completed.",
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
    {
      id: "issue-comment",
      taskType: "issue_update",
      prompt: "Add a comment to issue ${FIXTURE_ISSUE_NUMBER} saying this is a benchmark comment for ${RUN_ID}.",
      expectedFirstTool: {
        rawMcp: "add_issue_comment",
        mcpaqlAdapted: "mcp_aql_create",
      },
      expectedOperation: "add_issue_comment",
      requiresFixture: ["issue"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "issue-update-title",
      taskType: "issue_update",
      prompt: "Update issue ${FIXTURE_ISSUE_NUMBER} so its title is exactly 'Benchmark title ${RUN_ID}'.",
      expectedFirstTool: {
        rawMcp: "update_issue_title",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "issue_write",
      requiresFixture: ["issue"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
      expectedAdaptedMethod: "update",
    },
    {
      id: "issue-assign",
      taskType: "issue_update",
      prompt: "Assign issue ${FIXTURE_ISSUE_NUMBER} to ${GITHUB_BENCHMARK_ASSIGNEE}.",
      expectedFirstTool: {
        rawMcp: "update_issue_assignees",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "issue_write",
      requiresFixture: ["issue", "assignee"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
      expectedAdaptedMethod: "update",
    },
    {
      id: "issue-label-add",
      taskType: "issue_update",
      prompt: "Add the benchmark label to issue ${FIXTURE_ISSUE_NUMBER}.",
      expectedFirstTool: {
        rawMcp: "update_issue_labels",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "issue_write",
      requiresFixture: ["issue", "label"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
      expectedAdaptedMethod: "update",
    },
    {
      id: "issue-label-remove",
      taskType: "issue_update",
      prompt: "Remove the needs-review label from issue ${FIXTURE_ISSUE_NUMBER}.",
      expectedFirstTool: {
        rawMcp: "update_issue_labels",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "issue_write",
      requiresFixture: ["labeled_issue"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
      expectedAdaptedMethod: "update",
    },
    {
      id: "pull-comments",
      taskType: "pull_request_read",
      prompt: "List the review comments on pull request ${FIXTURE_PULL_NUMBER}.",
      expectedFirstTool: {
        rawMcp: "pull_request_read",
        mcpaqlAdapted: "mcp_aql_read",
      },
      expectedOperation: "pull_request_read",
      requiresFixture: ["pull_request_review_comment"],
      mutation: false,
      inducedError: { enabled: false },
      expectedRawMethod: "get_review_comments",
      expectedAdaptedMethod: "get_review_comments",
    },
    {
      id: "pull-request-reviewers",
      taskType: "pull_request_update",
      prompt: "Request review from ${GITHUB_BENCHMARK_REVIEWER} on pull request ${FIXTURE_PULL_NUMBER}.",
      expectedFirstTool: {
        rawMcp: "update_pull_request",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "update_pull_request",
      requiresFixture: ["pull_request", "reviewer"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "pull-add-review-comment",
      taskType: "pull_request_update",
      prompt: "Add a review comment to the pending review for pull request ${FIXTURE_PULL_NUMBER} on ${FIXTURE_CHANGED_FILE} with body 'Benchmark review comment ${RUN_ID}', then submit the pending review.",
      expectedFirstTool: {
        rawMcp: "add_comment_to_pending_review",
        mcpaqlAdapted: "mcp_aql_create",
      },
      expectedOperation: "add_comment_to_pending_review",
      requiresFixture: ["pending_review", "changed_file"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "pull-submit-review",
      taskType: "pull_request_update",
      prompt: "Submit the pending comment-only review on pull request ${FIXTURE_PULL_NUMBER}.",
      expectedFirstTool: {
        rawMcp: "pull_request_review_write",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "pull_request_review_write",
      requiresFixture: ["pending_review"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: "submit_pending",
      expectedAdaptedMethod: "submit_pending",
    },
    {
      id: "pull-create",
      taskType: "pull_request_create",
      prompt: "Open a pull request from ${FIXTURE_BRANCH} into ${FIXTURE_BASE_BRANCH} titled 'Benchmark PR ${RUN_ID}'.",
      expectedFirstTool: {
        rawMcp: "create_pull_request",
        mcpaqlAdapted: "mcp_aql_create",
      },
      expectedOperation: "create_pull_request",
      requiresFixture: ["branch"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "pull-merge",
      taskType: "pull_request_update",
      prompt: "Merge pull request ${FIXTURE_MERGEABLE_PULL_NUMBER} with squash merge.",
      expectedFirstTool: {
        rawMcp: "merge_pull_request",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "merge_pull_request",
      requiresFixture: ["mergeable_pull_request"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "release-create-draft",
      taskType: "release_read",
      prompt: "Get the release for tag ${FIXTURE_TAG}.",
      expectedFirstTool: {
        rawMcp: "get_release_by_tag",
        mcpaqlAdapted: "mcp_aql_read",
      },
      expectedOperation: "get_release_by_tag",
      requiresFixture: ["release"],
      mutation: false,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "repo-file-read",
      taskType: "content_read",
      prompt: "Read ${FIXTURE_README_PATH}.",
      expectedFirstTool: {
        rawMcp: "get_file_contents",
        mcpaqlAdapted: "mcp_aql_read",
      },
      expectedOperation: "get_file_contents",
      requiresFixture: ["file"],
      mutation: false,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "repo-file-update",
      taskType: "content_update",
      prompt: "Update ${FIXTURE_FILE_PATH} by appending the line 'Benchmark update ${RUN_ID}'.",
      expectedFirstTool: {
        rawMcp: "create_or_update_file",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "create_or_update_file",
      requiresFixture: ["file"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "error-pr-reviewer-invalid",
      taskType: "recovery_pull_request_update",
      prompt: "Request review from ${GITHUB_BENCHMARK_REVIEWER} on pull request ${FIXTURE_PULL_NUMBER}.",
      expectedFirstTool: {
        rawMcp: "update_pull_request",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "update_pull_request",
      requiresFixture: ["pull_request", "reviewer"],
      mutation: true,
      inducedError: {
        enabled: true,
        errorCode: "INVALID_REVIEWER",
      },
      expectedRawMethod: null,
    },
    {
      id: "error-issue-comment-wrong-number",
      taskType: "recovery_issue_update",
      prompt: "Comment on issue ${FIXTURE_ISSUE_NUMBER} with a benchmark recovery note.",
      expectedFirstTool: {
        rawMcp: "add_issue_comment",
        mcpaqlAdapted: "mcp_aql_create",
      },
      expectedOperation: "add_issue_comment",
      requiresFixture: ["issue"],
      mutation: true,
      inducedError: {
        enabled: true,
        errorCode: "NOT_FOUND",
      },
      expectedRawMethod: null,
    },
    {
      id: "error-file-update-stale-sha",
      taskType: "recovery_content_update",
      prompt: "Update ${FIXTURE_FILE_PATH} by appending the line 'Benchmark recovery ${RUN_ID}'.",
      expectedFirstTool: {
        rawMcp: "create_or_update_file",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "create_or_update_file",
      requiresFixture: ["file"],
      mutation: true,
      inducedError: {
        enabled: true,
        errorCode: "STALE_SHA",
      },
      expectedRawMethod: null,
    },
    {
      id: "error-label-add-invalid",
      taskType: "recovery_issue_update",
      prompt: "Add the benchmark label to issue ${FIXTURE_ISSUE_NUMBER}.",
      expectedFirstTool: {
        rawMcp: "update_issue_labels",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "issue_write",
      requiresFixture: ["issue", "label"],
      mutation: true,
      inducedError: {
        enabled: true,
        errorCode: "INVALID_LABEL",
      },
      expectedRawMethod: null,
      expectedAdaptedMethod: "update",
    },
  ].filter((task) => !taskIds || taskIds.includes(task.id));

  await writeFile(manifestPath, JSON.stringify({
    suite: "github-mcp",
    runCountPerConfiguration: 1,
    tasks,
  }, null, 2), "utf8");
}

function mustFindAllocation(
  allocations: Array<{
    taskId: string;
    configId: string;
    variables: Record<string, string | number | boolean>;
    createdResourceIds: string[];
    completionVerifier?: unknown;
  }>,
  taskId: string,
  configId: string,
): {
  taskId: string;
  configId: string;
  variables: Record<string, string | number | boolean>;
  createdResourceIds: string[];
  completionVerifier?: unknown;
} {
  const allocation = allocations.find((entry) => entry.taskId === taskId && entry.configId === configId);
  assert.ok(allocation, `missing allocation ${taskId} ${configId}`);
  return allocation;
}

function verifierParams(allocation: { completionVerifier?: unknown }): Record<string, unknown> {
  assert.ok(allocation.completionVerifier && typeof allocation.completionVerifier === "object");
  const verifier = allocation.completionVerifier as { arguments?: unknown };
  assert.ok(verifier.arguments && typeof verifier.arguments === "object");
  const args = verifier.arguments as { params?: unknown };
  if (args.params && typeof args.params === "object") return args.params as Record<string, unknown>;
  return verifier.arguments as Record<string, unknown>;
}

function verifierOperation(allocation: { completionVerifier?: unknown }): string | undefined {
  assert.ok(allocation.completionVerifier && typeof allocation.completionVerifier === "object");
  const verifier = allocation.completionVerifier as { arguments?: unknown; toolName?: unknown };
  if (!verifier.arguments || typeof verifier.arguments !== "object") return typeof verifier.toolName === "string" ? verifier.toolName : undefined;
  const args = verifier.arguments as { operation?: unknown };
  return typeof args.operation === "string" ? args.operation : typeof verifier.toolName === "string" ? verifier.toolName : undefined;
}

function verifierExpected(
  allocation: { completionVerifier?: unknown },
  key: "expectedTextIncludes" | "expectedTextExcludes",
): unknown {
  assert.ok(allocation.completionVerifier && typeof allocation.completionVerifier === "object");
  const verifier = allocation.completionVerifier as Record<string, unknown>;
  return verifier[key];
}

class FailingIssueClient implements GitHubFixtureClient {
  async getRepository(): Promise<{ defaultBranch: string }> {
    return { defaultBranch: "main" };
  }

  async getBranchHead(): Promise<{ sha: string }> {
    return { sha: "base-sha" };
  }

  async ensureLabel(): Promise<void> {}

  async createIssue(): Promise<{ number: number }> {
    throw new Error("fixture issue provisioning failed");
  }

  async updateIssue(): Promise<void> {}

  async createBranch(): Promise<void> {}

  async deleteBranch(): Promise<void> {}

  async createOrUpdateFile(input: { filePath: string }): Promise<{ path: string; sha: string }> {
    return { path: input.filePath, sha: "sha" };
  }

  async deleteFile(): Promise<void> {}

  async getFile(): Promise<{ sha: string } | undefined> {
    return { sha: "sha" };
  }

  async createPullRequest(): Promise<{ number: number }> {
    return { number: 1 };
  }

  async closePullRequest(): Promise<void> {}

  async findPullRequest(): Promise<{ number: number } | undefined> {
    return undefined;
  }

  async createPendingReview(): Promise<{ id: number }> {
    return { id: 1 };
  }

  async createRelease(input: { tag: string }): Promise<{ id: number; tagName: string }> {
    return { id: 1, tagName: input.tag };
  }

  async deleteRelease(): Promise<void> {}

  async deleteTag(): Promise<void> {}

  async findIssue(): Promise<{ number: number } | undefined> {
    return undefined;
  }
}
