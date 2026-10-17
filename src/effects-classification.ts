import type { DangerLevel, EndpointCategory } from "./types.js";

/**
 * Canonical effect vocabulary. Some upstreams publish per-tool effect flags that are
 * richer than MCP annotations; when present they decide the CRUDE endpoint, because a
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

export type EffectFlag = (typeof EFFECT_FLAGS)[number];
export type EffectFlags = Partial<Record<EffectFlag, boolean>>;

export interface EffectClassification {
  endpoint: EndpointCategory;
  danger: DangerLevel;
  reviewReasons: string[];
}

/** Read canonical boolean flags from `tool[field]`; undefined when the tool publishes none. */
export function readEffectFlags(tool: Record<string, unknown>, field = "effects"): EffectFlags | undefined {
  const raw = tool[field];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const flags: EffectFlags = {};
  for (const flag of EFFECT_FLAGS) {
    const value = (raw as Record<string, unknown>)[flag];
    if (typeof value === "boolean") flags[flag] = value;
  }
  return Object.keys(flags).length > 0 ? flags : undefined;
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
    return { endpoint: "DELETE", danger: "destructive", reviewReasons: [] };
  }
  if (effects.mutatesTarget || effects.changesUiState) {
    return { endpoint: "UPDATE", danger: "reversible", reviewReasons: [] };
  }
  if (effects.writesFilesystem) {
    return {
      endpoint: "CREATE",
      danger: "reversible",
      reviewReasons: ["Writes files on the host (effects.writesFilesystem)."],
    };
  }
  return {
    endpoint: "READ",
    danger: "safe",
    reviewReasons: effects.accessesNetwork
      ? ["Read that reaches a network or attached device (effects.accessesNetwork); consider requiring confirmation."]
      : [],
  };
}

/**
 * Disagreements between MCP tool annotations and the chosen endpoint. Annotations are
 * hints, so a disagreement never changes the classification; it is surfaced for review.
 * readOnlyHint=false on a READ is not flagged: servers commonly mark tools that record
 * session state (but leave the target untouched) as non-read-only.
 */
export function annotationConflicts(annotations: Record<string, unknown> | undefined, endpoint: EndpointCategory): string[] {
  if (!annotations) return [];
  const conflicts: string[] = [];
  if (annotations.readOnlyHint === true && endpoint !== "READ") {
    conflicts.push(`Upstream annotation readOnlyHint=true disagrees with endpoint ${endpoint}.`);
  }
  if (annotations.destructiveHint === true && (endpoint === "READ" || endpoint === "CREATE")) {
    conflicts.push(`Upstream annotation destructiveHint=true disagrees with endpoint ${endpoint}.`);
  }
  return conflicts;
}
