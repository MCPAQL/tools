// CLI: mcpaql-parity — run a parity suite against an MCPAQL adapter.
//
// Usage:
//   mcpaql-parity --suite ./path/to/suite.js --adapter ./path/to/adapter/dist/server.js \
//                 --report parity.json [--label X] [--no-teardown] [--reuse-fixtures ./fixtures.json]

import { runParitySuite, type Suite } from "./parity-runner.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (p) return p.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

async function main(): Promise<void> {
  const suitePath = arg("suite");
  const adapter = arg("adapter");
  const report = arg("report") ?? "parity-report.json";
  const label = arg("label");
  const reuseFixtures = arg("reuse-fixtures");
  const skipTeardown = process.argv.includes("--no-teardown");

  if (!suitePath || !adapter) {
    console.error("Usage: mcpaql-parity --suite <module> --adapter <server.js> [--report <path>] [--label X] [--no-teardown] [--reuse-fixtures <json>]");
    process.exit(2);
  }

  const suiteModule = await import(pathToFileURL(resolve(suitePath)).href) as { suite?: Suite<unknown>; default?: Suite<unknown> };
  const suite = suiteModule.suite ?? suiteModule.default;
  if (!suite) {
    console.error(`Suite module ${suitePath} must export 'suite' or default.`);
    process.exit(2);
  }

  await runParitySuite(suite, {
    adapterServerJs: resolve(adapter),
    reportPath: resolve(report),
    label,
    skipTeardown,
    reuseFixtures,
  });
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
