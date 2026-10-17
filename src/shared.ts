import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const READ_ENDPOINT_TOOL_NAME = "mcp_aql_read";
export const SYNTHETIC_INTROSPECT_OPERATION = "introspect";
export const DEFAULT_TIMEOUT_MS = 30_000;

export function normalizeSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

const ENV_REFERENCE = /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;

export function deepRedact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepRedact(entry)) as T;
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      const redactKey =
        /(authorization|secret|password)/i.test(lowerKey) ||
        (lowerKey.includes("token") && !lowerKey.endsWith("_env"));

      // An exact "${env:VAR}" value names where a secret comes from; it is not the secret itself.
      if (redactKey && !(typeof entry === "string" && ENV_REFERENCE.test(entry))) {
        output[key] = "<redacted>";
        continue;
      }

      output[key] = deepRedact(entry);
    }

    return output as T;
  }

  if (typeof value === "string" && SECRET_VALUE_PREFIX.test(value)) {
    return "<redacted>" as T;
  }

  return value;
}

// Well-known credential prefixes: GitHub tokens and fine-grained PATs, OpenAI/Anthropic-style
// keys, Slack tokens, AWS access key ids.
const SECRET_VALUE_PREFIX = /^(gh[opus]_|github_pat_|sk-|xox[abprs]-|AKIA[0-9A-Z]{12})/i;
// Token boundaries exclude "-" and "_" so "postgres-sk-..." is not mistaken for an "sk-" key.
const SECRET_EMBEDDED = /(?<![A-Za-z0-9_-])(?:(?:gh[opus]_|github_pat_|sk-|xox[abprs]-)[A-Za-z0-9_-]+|AKIA[0-9A-Z]{16}(?![A-Za-z0-9]))/g;
const SECRET_FLAG = /^--?(token|access[-_]?token|api[-_]?key|key|password|passwd|secret|auth|authorization|bearer)$/i;
const SECRET_FLAG_ASSIGNMENT = /^(--?(?:token|access[-_]?token|api[-_]?key|key|password|passwd|secret|auth|authorization|bearer))=.+$/i;

function redactEmbedded(value: string): string {
  return value.replace(SECRET_EMBEDDED, "<redacted>");
}

/**
 * Stdio launch configs are written into committed discovery bundles and generated adapters,
 * so they are redacted by position, not only by key name: every env value that is not an
 * exact "\${env:VAR}" reference, the value after a secret-like flag (or in --flag=value form),
 * and credential-shaped substrings of args and command.
 */
export function redactStdioTransport(transport: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = { ...transport };
  if (typeof output.command === "string") {
    output.command = redactEmbedded(output.command);
  }
  if (Array.isArray(output.args)) {
    const args = output.args as unknown[];
    output.args = args.map((arg, index) => {
      if (typeof arg !== "string") return arg;
      const previous = args[index - 1];
      if (typeof previous === "string" && SECRET_FLAG.test(previous)) return "<redacted>";
      const assignment = SECRET_FLAG_ASSIGNMENT.exec(arg);
      if (assignment) return `${assignment[1]}=<redacted>`;
      return redactEmbedded(arg);
    });
  }
  if (output.env && typeof output.env === "object" && !Array.isArray(output.env)) {
    output.env = Object.fromEntries(
      Object.entries(output.env as Record<string, unknown>).map(([name, value]) => [
        name,
        typeof value === "string" && ENV_REFERENCE.test(value) ? value : "<redacted>",
      ]),
    );
  }
  return output;
}

export function firstTextContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return "{}";
  }

  const first = content[0] as { text?: unknown };
  return typeof first.text === "string" ? first.text : "{}";
}

export function parseJsonText<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned malformed JSON: ${detail}`);
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS, label = "operation"): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    // NOTE: Promise.race does not abort the underlying request; true cancellation requires AbortSignal plumbing.
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      output[key] = "true";
      continue;
    }

    output[key] = value;
    index += 1;
  }

  return output;
}

// A header value of the exact form "${env:VAR_NAME}" is read from the environment, so
// per-tenant identifiers (project or workspace ids) stay out of committed configs. The
// placeholder, not the resolved value, is what lands in capture_config_redacted and is
// carried into the generated adapter, which resolves it the same way at connect time.
export function resolveHeaderEnv(
  headers: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const match = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (!match) {
      resolved[name] = value;
      continue;
    }
    const envValue = env[match[1]];
    if (!envValue) {
      throw new Error(`Missing env var '${match[1]}' for header '${name}'.`);
    }
    resolved[name] = envValue;
  }
  return resolved;
}
