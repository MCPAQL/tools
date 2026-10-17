import type { DangerLevel, EndpointCategory } from "./types.js";

/**
 * Canonical effect vocabulary. Some upstreams publish per-tool effect flags that are
 * richer than MCP annotations; when complete they decide the CRUDE endpoint, because a
 * tool's effect on state, not the verb in its name, is what the endpoint must gate.
 */
export const EFFECT_FLAGS = [
  "executesForeignCode",
  "mutatesDevice",
  "mayDiscardData",
  "mutatesTarget",
  "changesUiState",
  "writesFilesystem",
  "accessesNetwork",
  "launchesProcess",
  "mutatesSession",
  "idempotent",
] as const;

/**
 * Flags that can raise a tool above READ. Effects decide the endpoint only when every one of
 * these is a published boolean: a missing or malformed gating flag is unknown, not false, and
 * reading it as false would fail open.
 */
export const GATING_FLAGS = [
  "executesForeignCode",
  "mutatesDevice",
  "mayDiscardData",
  "mutatesTarget",
  "changesUiState",
  "writesFilesystem",
] as const;

export type EffectFlag = (typeof EFFECT_FLAGS)[number];
export type EffectFlags = Partial<Record<EffectFlag, boolean>>;

export interface EffectReading {
  flags: EffectFlags;
  /** Every gating flag is a boolean, so the flags can decide the endpoint. */
  complete: boolean;
  /** Gating flags that are absent or not booleans. */
  unknown: string[];
}

export interface EffectClassification {
  endpoint: EndpointCategory;
  danger: DangerLevel;
  reviewReasons: string[];
}

function fieldValue(tool: Record<string, unknown>, field: string): unknown {
  // A dotted path reaches vendor metadata, e.g. "_meta.example/effects".
  let current: unknown = tool;
  for (const segment of field.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = Object.hasOwn(current, segment) ? (current as Record<string, unknown>)[segment] : undefined;
  }
  return current;
}

/** Read canonical boolean flags from `tool[field]`; undefined when the tool publishes none. */
export function readEffectFlags(tool: Record<string, unknown>, field = "effects"): EffectReading | undefined {
  const raw = fieldValue(tool, field);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const flags: EffectFlags = {};
  for (const flag of EFFECT_FLAGS) {
    if (typeof record[flag] === "boolean") flags[flag] = record[flag] as boolean;
  }
  if (Object.keys(flags).length === 0 && !GATING_FLAGS.some((flag) => flag in record)) return undefined;
  const unknown = GATING_FLAGS.filter((flag) => typeof record[flag] !== "boolean");
  return { flags, complete: unknown.length === 0, unknown };
}

export function classifyFromEffects(effects: EffectFlags): EffectClassification {
  if (effects.executesForeignCode || effects.mutatesDevice) {
    return {
      endpoint: "EXECUTE",
      danger: "dangerous",
      reviewReasons: [
        effects.executesForeignCode
          ? "Runs or drives code the upstream does not own (effects.executesForeignCode)."
          : "Changes an attached device (effects.mutatesDevice).",
      ],
    };
  }
  if (effects.mayDiscardData) {
    // Overwriting existing values discards the old ones but is an update, not a removal.
    if (effects.mutatesTarget) {
      return {
        endpoint: "UPDATE",
        danger: "destructive",
        reviewReasons: ["Overwrites existing target data (effects.mayDiscardData with mutatesTarget); confirm UPDATE vs DELETE."],
      };
    }
    // Writing a file can replace an existing one; that creates output rather than removing a resource.
    if (effects.writesFilesystem) {
      return {
        endpoint: "CREATE",
        danger: "destructive",
        reviewReasons: ["Writes host files and may replace existing ones (effects.mayDiscardData with writesFilesystem)."],
      };
    }
    return { endpoint: "DELETE", danger: "destructive", reviewReasons: [] };
  }
  if (effects.mutatesTarget || effects.changesUiState) {
    return { endpoint: "UPDATE", danger: "reversible", reviewReasons: [] };
  }
  if (effects.writesFilesystem) {
    return {
      endpoint: "CREATE",
      danger: "reversible",
      reviewReasons: ["Writes files on the host (effects.writesFilesystem); if these are only internal caches, override to READ."],
    };
  }
  const reviewReasons: string[] = [];
  if (effects.launchesProcess) {
    reviewReasons.push("Read that launches a process (effects.launchesProcess); check whether the process persists or runs target code.");
  }
  if (effects.accessesNetwork) {
    reviewReasons.push("Read that reaches a network or attached device (effects.accessesNetwork); consider requiring confirmation.");
  }
  // mutatesSession (recording analysis state) and idempotent do not change the endpoint.
  return { endpoint: "READ", danger: "safe", reviewReasons };
}

/**
 * Disagreements between MCP tool annotations and the classification. Annotations are hints,
 * so a disagreement never changes the result; it is surfaced for review. readOnlyHint=false
 * on a READ is not flagged: servers commonly mark tools that record session state (but leave
 * the target untouched) as non-read-only.
 */
export function annotationConflicts(
  annotations: Record<string, unknown> | undefined,
  endpoint: EndpointCategory,
  danger: DangerLevel,
): string[] {
  if (!annotations) return [];
  const conflicts: string[] = [];
  if (annotations.readOnlyHint === true && endpoint !== "READ") {
    conflicts.push(`Upstream annotation readOnlyHint=true disagrees with endpoint ${endpoint}.`);
  }
  if (annotations.destructiveHint === true && (danger === "safe" || danger === "reversible")) {
    conflicts.push(`Upstream annotation destructiveHint=true disagrees with ${endpoint} danger level ${danger}.`);
  }
  return conflicts;
}
