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
- `GITHUB_PERSONAL_ACCESS_TOKEN`: required by both raw GitHub MCP and the MCPAQL adapter. The token must target a disposable benchmark org or repository, not a production repo.
- `GITHUB_BENCHMARK_OWNER`: owner for the disposable benchmark repository.
- `GITHUB_BENCHMARK_REPO`: disposable benchmark repository name.
- `GITHUB_BENCHMARK_ASSIGNEE`: account to use for issue-assignment tasks.
- `GITHUB_BENCHMARK_REVIEWER`: account to use for pull-request review tasks.
- `MCPAQL_GITHUB_ADAPTER_SERVER`: path to the built MCPAQL GitHub adapter server from MCPAQL/examples#41.
- `MCPAQL_GITHUB_ADAPTER_SCHEMA`: path to the adapter `schema.json`.
- `MCPAQL_GITHUB_ADAPTER_PROVENANCE`: path to the adapter `provenance.json`.
- `RAW_GITHUB_MCP_COMMAND`: command used to launch the raw GitHub MCP server.

The coordinator should confirm the exact Claude model string before the run. Record it in `artifacts/github-llm-benchmark/metrics-input.json` under `model.model` and `model.version`.

## Disposable Repository Setup

Use a private or throwaway repository. The live run should create fixtures only inside that repository:

- Labels: `benchmark`, `bug`, `documentation`, `needs-review`
- Milestone: `benchmark-milestone`
- Issues for read/update/comment/close/reopen flows
- A branch and pull request for PR-review flows
- At least one discussion or project task only if those operations are confirmed available in the adapter schema

Do not run against MCPAQL production repositories.

## Task Manifest

Use `fixtures/github-llm-benchmark-tasks.json` as the canonical task list for the first run. It contains 50 representative tasks grouped by workflow area. Each task has:

- `id`
- `taskType`
- `prompt`
- `expectedFirstTool.rawMcp`
- `expectedRawMethod`
- `expectedFirstTool.mcpaqlAdapted`
- `requiresFixture`
- `mutation`
- `inducedError`

Run each task at least 10 times for each configuration.

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

The task manifest pins first-call scoring to the current grouped GitHub MCP raw tool surface. For raw MCP, score the first call by matching both:

- `expectedFirstTool.rawMcp`: the grouped raw tool name, such as `issue_read`
- `expectedRawMethod`: the method/action argument inside that raw tool call, such as `get`

Before running the benchmark, capture `artifacts/github-llm-benchmark/raw-mcp/tool-definitions.json` from the live raw GitHub MCP server and verify every manifest entry has an exact raw tool + method match. If any entry does not match, stop and update the manifest or add an explicit mapping file before collecting results. Do not score live transcripts against stale flattened names such as `get_issue` or `create_issue`.

## Scoring Policy

Use `src/parity/llm-metrics.ts` as the report schema.

Per task/config/run:

- `firstCallSuccess`: true when the model's first tool call matches `expectedFirstTool` for that configuration. For raw MCP, also require the call's method/action argument to match `expectedRawMethod`. For MCPAQL-adapted MCP, require the endpoint tool to match `expectedFirstTool.mcpaqlAdapted` and the requested operation to match `expectedOperation`.
- `outcome`: `completed` only when the task reached the specified end state in the disposable repository. Use `failed`, `gave_up`, or `error` otherwise.
- `turnsToCompletion`: count model/tool cycles until completion. Leave null for non-completed runs unless a failure turn count is needed for debugging.
- `tokensToCompletion`: cumulative prompt + completion + tool-definition tokens for completed runs.
- `inducedError.injected`: true for tasks whose manifest entry has `inducedError.enabled`.
- `inducedError.recoveredWithinTwoTurns`: true only if the model corrects the injected bad-argument response within two additional tool-call turns.

The aggregate report intentionally computes turn/token averages over completed tasks only.

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

Create an empty normalized report from the template:

```bash
npm run parity -- \
  --llm-metrics-input fixtures/github-llm-metrics-input.template.json \
  --llm-metrics-report artifacts/github-llm-benchmark/llm-metrics.json \
  --llm-summary artifacts/github-llm-benchmark/llm-metrics.md
```

The command above validates the report generator only. It is not a benchmark run.

After a live runner captures real task results into `artifacts/github-llm-benchmark/metrics-input.json`, normalize the final reports with:

```bash
npm run parity -- \
  --llm-metrics-input artifacts/github-llm-benchmark/metrics-input.json \
  --llm-metrics-report artifacts/github-llm-benchmark/llm-metrics.json \
  --llm-summary artifacts/github-llm-benchmark/llm-metrics.md
```

## Current Blocker

As of this preparation pass, the local environment did not expose `ANTHROPIC_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `GITHUB_TOKEN`, or `GH_TOKEN`. GitHub CLI auth was present, but the benchmark runner needs an explicit model API key and an explicit disposable-repo token environment variable.

Next command for the coordinator after credentials and adapter paths are available:

```bash
ANTHROPIC_API_KEY=... \
GITHUB_PERSONAL_ACCESS_TOKEN=... \
GITHUB_BENCHMARK_OWNER=... \
GITHUB_BENCHMARK_REPO=... \
GITHUB_BENCHMARK_ASSIGNEE=... \
GITHUB_BENCHMARK_REVIEWER=... \
MCPAQL_GITHUB_ADAPTER_SERVER=... \
MCPAQL_GITHUB_ADAPTER_SCHEMA=... \
MCPAQL_GITHUB_ADAPTER_PROVENANCE=... \
RAW_GITHUB_MCP_COMMAND=... \
npm run parity -- \
  --llm-metrics-input artifacts/github-llm-benchmark/metrics-input.json \
  --llm-metrics-report artifacts/github-llm-benchmark/llm-metrics.json \
  --llm-summary artifacts/github-llm-benchmark/llm-metrics.md
```

Replace the final `npm run parity` normalization step with the live runner command once the live runner exists. Keep this normalization command as the final report-generation step.
