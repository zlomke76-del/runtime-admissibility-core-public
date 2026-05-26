// TypeScript mirror for reference. The deployable test runner is scripts/test-vectors.js.
// Keep packet semantics aligned with Runtime Admissibility Core: state + authority + constraints + consequence boundary.

type RuntimeAdmissibilityOutcome = "admissible" | "conditional" | "inadmissible";

interface RuntimeAdmissibilityResult {
  outcome: RuntimeAdmissibilityOutcome;
  admissible: boolean;
  artifact_hash: string;
}

export interface RuntimeAdmissibilityPacket {
  packet_id: string;
  system_context?: Record<string, unknown>;
  runtime_state?: Record<string, unknown>;
  authority_context?: Record<string, unknown>;
  constraint_context?: Record<string, unknown>;
  consequence_boundary?: Record<string, unknown>;
  runtime_signals?: Array<Record<string, unknown>>;
  freshness_policy?: Record<string, unknown>;
}

declare function evaluateRuntimeAdmissibility(packet: RuntimeAdmissibilityPacket): RuntimeAdmissibilityResult;

const admissiblePacket: RuntimeAdmissibilityPacket = {
  packet_id: "demo-admissible",
  system_context: { domain: "healthcare", workflow: "discharge-readiness" },
  runtime_state: { state_valid: true, validated_conditions: ["patient stable"], last_validated_at: new Date().toISOString() },
  authority_context: { status: "valid", issuer: "attending-physician", scope: ["discharge-review"] },
  constraint_context: { action_constrained: true, allowed_actions: ["prepare-review"] },
  consequence_boundary: { level: "high", scope: "clinical-discharge" },
  runtime_signals: [{ source: "monitor", statement: "patient stable", seen_at: new Date().toISOString() }],
};
