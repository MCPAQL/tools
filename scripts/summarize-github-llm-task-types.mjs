#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  return [
    "Usage:",
    "  node scripts/summarize-github-llm-task-types.mjs <manifest.json> <llm-metrics.json> <output.json> <output.md>",
  ].join("\n");
}

const [manifestPath, reportPath, jsonOutputPath, markdownOutputPath] = process.argv.slice(2);

if (!manifestPath || !reportPath || !jsonOutputPath || !markdownOutputPath) {
  console.error(usage());
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const report = JSON.parse(await readFile(reportPath, "utf8"));

if (!Array.isArray(manifest.tasks)) {
  throw new Error(`Manifest ${manifestPath} must include a tasks array.`);
}

if (!Array.isArray(report.taskResults)) {
  throw new Error(`Metrics report ${reportPath} must include a taskResults array.`);
}

const taskTypeById = new Map();
for (const task of manifest.tasks) {
  if (!task || typeof task.id !== "string" || typeof task.taskType !== "string") {
    throw new Error(`Manifest ${manifestPath} contains a task without string id/taskType.`);
  }
  taskTypeById.set(task.id, task.taskType);
}

const groups = new Map();
for (const task of report.taskResults) {
  if (!task || typeof task.taskId !== "string" || typeof task.configId !== "string") {
    throw new Error(`Metrics report ${reportPath} contains a task result without taskId/configId.`);
  }
  const taskType = taskTypeById.get(task.taskId);
  if (!taskType) {
    throw new Error(`Metrics report task "${task.taskId}" is not present in ${manifestPath}.`);
  }
  const key = `${task.configId}\t${taskType}`;
  const group = groups.get(key) ?? {
    configId: task.configId,
    taskType,
    taskCount: 0,
    completedTaskCount: 0,
    firstCallSuccessCount: 0,
    firstCallMeasuredCount: 0,
  };

  group.taskCount += 1;
  if (task.outcome === "completed") group.completedTaskCount += 1;
  if (typeof task.firstCallSuccess === "boolean") {
    group.firstCallMeasuredCount += 1;
    if (task.firstCallSuccess) group.firstCallSuccessCount += 1;
  }
  groups.set(key, group);
}

const aggregates = [...groups.values()]
  .sort((left, right) => left.configId.localeCompare(right.configId) || left.taskType.localeCompare(right.taskType))
  .map((group) => ({
    configId: group.configId,
    taskType: group.taskType,
    taskCount: group.taskCount,
    completedTaskCount: group.completedTaskCount,
    firstCallSuccess: {
      successCount: group.firstCallSuccessCount,
      measuredCount: group.firstCallMeasuredCount,
      rate: rate(group.firstCallSuccessCount, group.firstCallMeasuredCount),
    },
  }));

const summary = {
  schemaVersion: "mcpaql.github-llm-task-type-aggregates.v1",
  generatedAt: new Date().toISOString(),
  manifestPath,
  metricsReportPath: reportPath,
  aggregates,
};

await mkdir(path.dirname(jsonOutputPath), { recursive: true });
await mkdir(path.dirname(markdownOutputPath), { recursive: true });
await writeFile(jsonOutputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await writeFile(markdownOutputPath, renderMarkdown(summary), "utf8");

function rate(successCount, measuredCount) {
  return measuredCount === 0 ? null : Number((successCount / measuredCount).toFixed(6));
}

function renderMarkdown(summaryReport) {
  const lines = [
    "# GitHub LLM Task-Type Aggregates",
    "",
    `Generated: ${summaryReport.generatedAt}`,
    `Manifest: \`${summaryReport.manifestPath}\``,
    `Metrics report: \`${summaryReport.metricsReportPath}\``,
    "",
    "| Configuration | Task type | Tasks | Completed | First-call success |",
    "| --- | --- | ---: | ---: | ---: |",
  ];

  if (summaryReport.aggregates.length === 0) {
    lines.push("| n/a | n/a | 0 | 0 | n/a |");
  } else {
    for (const aggregate of summaryReport.aggregates) {
      lines.push(markdownTableRow([
        aggregate.configId,
        aggregate.taskType,
        String(aggregate.taskCount),
        String(aggregate.completedTaskCount),
        formatRate(aggregate.firstCallSuccess),
      ]));
    }
  }

  lines.push("");
  return lines.join("\n");
}

function formatRate(metric) {
  if (metric.rate === null) return "n/a";
  return `${(metric.rate * 100).toFixed(1)}% (${metric.successCount}/${metric.measuredCount})`;
}

function markdownTableRow(cells) {
  return `| ${cells.map(escapeMarkdownTableCell).join(" | ")} |`;
}

function escapeMarkdownTableCell(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}
