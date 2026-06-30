# GitHub MCP LLM Correctness Benchmark Runbook

This runbook prepares MCPAQL/tools#22. It does not contain benchmark results.

## Scope

Measure GitHub MCP raw-tool exposure against an MCPAQL-adapted GitHub MCP configuration using the same model, prompt prefix, task list, retries, and scoring policy.

Required issue metrics:

- Tool-list token count for raw MCP versus MCPAQL-adapted MCP
- First-call success rate by task type
- Turns to completion for completed tasks
- Tokens to completion for completed tasks
- Recovery rate after induced bad-argument errors

Issue MCPAQL/tools#26 adds induced-danger gating. Keep it as a follow-up for the first #22 run because it changes the task category and acceptance criteria. It can reuse the raw-data layout below once #22 is complete.

## Required Credentials And Local Inputs

Set these before running a live benchmark:

- `ANTHROPIC_API_KEY`: required for the Claude benchmark model.
- `ANTHROPIC_MODEL`: exact Claude model string to use for every task/configuration run.
- `ANTHROPIC_MODEL_VERSION`: optional model-version metadata. If omitted, the live runner records the model string as the version.
- `GITHUB_PERSONAL_ACCESS_TOKEN`: required by both raw GitHub MCP and the MCPAQL adapter. The token must target a disposable benchmark org or repository, not a production repo.
- `GITHUB_BENCHMARK_OWNER`: owner for the disposable benchmark repository.
- `GITHUB_BENCHMARK_REPO`: disposable benchmark repository name.
- `GITHUB_BENCHMARK_ASSIGNEE`: account to use for issue-assignment tasks.
- `GITHUB_BENCHMARK_REVIEWER`: account to use for pull-request review tasks.
- `MCPAQL_GITHUB_ADAPTER_SERVER`: path to the built MCPAQL GitHub adapter server from MCPAQL/examples#41.
- `MCPAQL_GITHUB_ADAPTER_SCHEMA`: path to the adapter `schema.json`.
- `MCPAQL_GITHUB_ADAPTER_PROVENANCE`: path to the adapter `provenance.json`.
- `RAW_GITHUB_MCP_COMMAND`: command used to launch the raw GitHub MCP server.
- `GITHUB_TOOLSETS`: toolsets used for both the raw GitHub MCP command and adapter generation. Use `default,actions,labels,git` or `all`; the manifest requires Actions, label, and git tools that are not all in the stock default set.

The coordinator should confirm the exact Claude model string before the run. Record it in `artifacts/github-llm-benchmark/metrics-input.json` under `model.model` and `model.version`.

## Disposable Repository Setup

Use a private or throwaway repository. The live run should create fixtures only inside that repository:

- Labels: `benchmark`, `bug`, `documentation`, `needs-review`
- At least one repository collaborator visible to the benchmark token
- Issues for read/update/comment/close/reopen flows
- A branch and pull request for PR-review flows
- A pending pull request review for the review-comment and review-submit flows
- A GitHub Release for the tag used by release lookup flows; a bare Git tag is not sufficient for `get_release_by_tag`
- At least one discussion or project task only if those operations are confirmed available in the adapter schema

Do not run against MCPAQL production repositories.

## Task Manifest

Use `fixtures/github-llm-benchmark-tasks.json` as the canonical task list for the first run. It contains 50 representative tasks grouped by workflow area. Each task has:

- `id`
- `taskType`
- `prompt`
- `expectedFirstTool.rawMcp`
- `expectedRawMethod` (null for standalone raw tools)
- `expectedFirstTool.mcpaqlAdapted`
- `expectedAdaptedMethod` when a grouped MCPAQL-adapted operation needs a method/action pin
- `requiresFixture`
- `mutation`
- `inducedError`

Run each task at least 10 times for each configuration.

The manifest also declares `fixtureIsolation.policy: fresh_per_task_config_run`. Treat that as mandatory: every task/configuration/run tuple must receive a fresh fixture allocation or a reset to its pre-run state before the model starts.

For mutation tasks, never reuse a target that may have been closed, deleted, merged, relabeled, assigned, submitted as a pending review, or otherwise changed by an earlier repeat. Create per-run fixture IDs such as `${TASK_ID}-${CONFIG_ID}-${RUN_INDEX}`, record them in `artifacts/github-llm-benchmark/fixtures/setup.json`, and tear them down after report generation. If fixture reset fails, mark that run `error` and do not continue collecting results against dirty state.

## Raw Data Layout

Write all live benchmark artifacts under:

```text
artifacts/github-llm-benchmark/
  raw-mcp/
    transcripts/
    logs/
    prompts/
    tool-definitions.json
  mcpaql-adapted/
    transcripts/
    logs/
    prompts/
    tool-definitions.json
  fixtures/
    setup.json
    teardown.json
  metrics-input.json
  llm-metrics.json
  llm-metrics.md
  task-type-aggregates.json
  task-type-aggregates.md
  methodology.md
```

Transcript files should be JSONL, one event per line, and include at minimum:

- task id
- configuration id
- run index
- model name/version
- prompt text or prompt path
- tool definitions path
- every model response
- every tool call and tool result
- token usage for prompt, completion, and tool definitions
- whether the induced error was injected and recovered within two turns

Do not commit raw transcripts or generated reports until the coordinator confirms they are safe to publish.

## Raw Tool Mapping Pinning

The task manifest pins first-call scoring to the current GitHub MCP raw tool surface. Standalone raw tools such as `list_issues`, `search_issues`, `get_file_contents`, and `get_me` have `expectedRawMethod: null`; grouped raw tools such as `issue_read` keep a method/action argument. For raw MCP, score the first call by matching:

- `expectedFirstTool.rawMcp`: the raw tool name, such as `issue_read` or `get_me`
- `expectedRawMethod`: the method/action argument inside grouped raw tool calls, such as `get`, or null for standalone raw tools

Before running the benchmark, capture `artifacts/github-llm-benchmark/raw-mcp/tool-definitions.json` from the live raw GitHub MCP server and verify every manifest entry has an exact raw tool match and, when `expectedRawMethod` is non-null, an exact method match. If any entry does not match, stop and update the manifest or add an explicit mapping file before collecting results. The canonical manifest intentionally pins issue creation to the current standalone raw `create_issue` tool. Do not score live transcripts against stale flattened names such as `get_issue`; if a future raw server exposes issue creation only through grouped `issue_write`, stop and update the manifest before collecting results.

For grouped raw tools that fan out by method, keep the raw method and adapted operation preflights separate. For example, the workflow tasks currently pin raw `actions_list` with `expectedRawMethod` values `list_workflows` and `list_workflow_runs`, while the adapted side remains pinned to the generated execute operation `actions_list` with matching `expectedAdaptedMethod` values. If the generated adapter schema exposes split workflow operations instead, stop and update `expectedOperation`/`expectedAdaptedMethod` or add an explicit mapping before collecting results.

## Scoring Policy

Use `src/parity/llm-metrics.ts` as the report schema.

Per task/config/run:

- `firstCallSuccess`: true when the model's first tool call matches `expectedFirstTool` for that configuration. For raw MCP, also require the call's method/action argument to match `expectedRawMethod` when it is non-null. For MCPAQL-adapted MCP, require the endpoint tool to match `expectedFirstTool.mcpaqlAdapted`, the requested operation to match `expectedOperation`, and the adapted call's method/action argument to match `expectedAdaptedMethod` when it is present.
- `outcome`: `completed` only when the task reached the specified end state in the disposable repository. Use `failed`, `gave_up`, or `error` otherwise.
- `turnsToCompletion`: count model/tool cycles until completion. Leave null for non-completed runs unless a failure turn count is needed for debugging.
- `tokensToCompletion`: cumulative prompt + completion + tool-definition tokens for completed runs.
- `inducedError.injected`: true for tasks whose manifest entry has `inducedError.enabled`.
- `inducedError.recoveredWithinTwoTurns`: true only if the model corrects the injected bad-argument response within two additional tool-call turns.

The aggregate report intentionally computes turn/token averages over completed tasks only.

Before publishing final results, join the normalized `llm-metrics.json` task results against `fixtures/github-llm-benchmark-tasks.json` and generate task-type aggregate artifacts. `llm-metrics.json` remains the canonical per-configuration metrics schema, while `task-type-aggregates.json` and `task-type-aggregates.md` provide the required first-call success rate by task type.

## Commands

Install and build:

```bash
npm ci
npm run build
npm test
```

Check required live-run inputs without printing secrets:

```bash
bash scripts/check-github-llm-benchmark-env.sh
```

Validate the live-runner artifact shape without credentials or live MCP/API calls:

```bash
npm run github-llm-benchmark -- \
  --dry-run \
  --runs 1 \
  --task-limit 1 \
  --artifact-root /tmp/github-llm-benchmark-dry-run \
  --output /tmp/github-llm-benchmark-dry-run/metrics-input.json \
  --model mock-claude
```

Dry-run output is synthetic shape-validation data only. Do not cite it as benchmark evidence.

Create an empty normalized report from the template:

```bash
npm run parity -- \
  --llm-metrics-input fixtures/github-llm-metrics-input.template.json \
  --llm-metrics-report artifacts/github-llm-benchmark/llm-metrics.json \
  --llm-summary artifacts/github-llm-benchmark/llm-metrics.md
```

The command above validates the report generator only. It is not a benchmark run.

After tools#30 or a manual coordinator setup creates fresh disposable fixtures for every task/configuration/run tuple, capture live task results with:

```bash
npm run github-llm-benchmark -- \
  --manifest fixtures/github-llm-benchmark-tasks.json \
  --fixtures artifacts/github-llm-benchmark/fixtures/setup.json \
  --artifact-root artifacts/github-llm-benchmark \
  --output artifacts/github-llm-benchmark/metrics-input.json \
  --runs 10 \
  --model "$ANTHROPIC_MODEL" \
  --model-version "$ANTHROPIC_MODEL_VERSION"
```

The `--fixtures` file is the fixture-allocation handoff for tools#30. The live runner consumes fixture variables and raw fixture paths from that file, but it does not create, reset, or tear down disposable GitHub state.

Once the live runner captures real task results into `artifacts/github-llm-benchmark/metrics-input.json`, normalize the final reports with:

```bash
npm run parity -- \
  --llm-metrics-input artifacts/github-llm-benchmark/metrics-input.json \
  --llm-metrics-report artifacts/github-llm-benchmark/llm-metrics.json \
  --llm-summary artifacts/github-llm-benchmark/llm-metrics.md
```

Then generate the required task-type aggregate report:

```bash
node scripts/summarize-github-llm-task-types.mjs \
  fixtures/github-llm-benchmark-tasks.json \
  artifacts/github-llm-benchmark/llm-metrics.json \
  artifacts/github-llm-benchmark/task-type-aggregates.json \
  artifacts/github-llm-benchmark/task-type-aggregates.md
```

## Current Blocker

As of this live-runner implementation pass, the local environment did not expose the required Anthropic model/API inputs, disposable GitHub token/repository inputs, raw MCP command, adapter paths, or `GITHUB_TOOLSETS`. GitHub CLI auth was present, but the benchmark runner needs explicit live benchmark environment variables and a fixture allocation file.

Next command for the coordinator after credentials, adapter paths, model metadata, and disposable fixture allocation are available:

```bash
ANTHROPIC_API_KEY=... \
ANTHROPIC_MODEL=... \
ANTHROPIC_MODEL_VERSION=... \
GITHUB_PERSONAL_ACCESS_TOKEN=... \
GITHUB_BENCHMARK_OWNER=... \
GITHUB_BENCHMARK_REPO=... \
GITHUB_BENCHMARK_ASSIGNEE=... \
GITHUB_BENCHMARK_REVIEWER=... \
MCPAQL_GITHUB_ADAPTER_SERVER=... \
MCPAQL_GITHUB_ADAPTER_SCHEMA=... \
MCPAQL_GITHUB_ADAPTER_PROVENANCE=... \
RAW_GITHUB_MCP_COMMAND=... \
GITHUB_TOOLSETS=default,actions,labels,git \
npm run github-llm-benchmark -- \
  --manifest fixtures/github-llm-benchmark-tasks.json \
  --fixtures artifacts/github-llm-benchmark/fixtures/setup.json \
  --artifact-root artifacts/github-llm-benchmark \
  --output artifacts/github-llm-benchmark/metrics-input.json \
  --runs 10 \
  --model "$ANTHROPIC_MODEL" \
  --model-version "$ANTHROPIC_MODEL_VERSION"
```

Keep the normalization and task-type aggregate commands as the final report-generation steps after the live runner finishes.
