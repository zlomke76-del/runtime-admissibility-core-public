const { evaluateRuntimeAdmissibility } = require('../api/evaluate.js');

const admissiblePacket = {
  packet_id: 'demo-admissible',
  system_context: { domain: 'healthcare', workflow: 'discharge-readiness', consequence_level: 'high' },
  runtime_state: {
    state_valid: true,
    validated_conditions: ['patient stable', 'oxygen normal'],
    last_validated_at: new Date().toISOString(),
  },
  authority_context: { status: 'valid', issuer: 'attending-physician', scope: ['discharge-review'] },
  constraint_context: { action_constrained: true, allowed_actions: ['prepare-review'], prohibited_actions: ['final-discharge-without-human-signoff'] },
  consequence_boundary: { level: 'high', scope: 'clinical-discharge' },
  runtime_signals: [{ source: 'monitor', statement: 'oxygen normal', seen_at: new Date().toISOString() }],
  freshness_policy: { state_stale_after_minutes: 30 },
};

const inadmissiblePacket = {
  ...admissiblePacket,
  packet_id: 'demo-inadmissible',
  runtime_state: { ...admissiblePacket.runtime_state, validated_conditions: ['patient stable', 'oxygen normal'] },
  runtime_signals: [{ source: 'nurse-monitor', statement: 'oxygen unstable; physician authority revoked', seen_at: new Date().toISOString() }],
  authority_context: { status: 'revoked', issuer: 'attending-physician', scope: ['discharge-review'] },
};

const a = evaluateRuntimeAdmissibility(admissiblePacket);
const b = evaluateRuntimeAdmissibility(inadmissiblePacket);

console.log('ADMISSIBLE:', a.outcome);
console.log('INADMISSIBLE:', b.outcome);

if (a.outcome !== 'admissible') throw new Error(`Expected admissible, got ${a.outcome}`);
if (b.outcome !== 'inadmissible') throw new Error(`Expected inadmissible, got ${b.outcome}`);
