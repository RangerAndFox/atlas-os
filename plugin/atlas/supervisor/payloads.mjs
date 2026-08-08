// @ts-nocheck
/**
 * Builds the exact input each role receives. Role input isolation (AC-5) lives here as
 * a property of the code, not a prompt instruction: the acceptance-engineer's payload
 * is constructed WITHOUT the director's plan, so it cannot see the implementation it is
 * meant to test independently. The test asserts the plan text appears nowhere in the
 * serialized payload — leakage via shared state is a build error, not a discipline lapse.
 */

export function buildRolePayload(role, state) {
  const base = { role, intent: state.intent, missionId: state.missionId ?? null };
  switch (role) {
    case "auditor":
      return { ...base };
    case "mission-control":
      return { ...base, audit: state.audit };
    case "mission-author":
      return { ...base, audit: state.audit, direction: state.direction };
    case "criterion-critic":
      return { ...base, contract: state.contract };
    case "director":
      return { ...base, contract: state.contract, audit: state.audit };
    case "acceptance-engineer":
      // AC-5: deliberately NO plan. The acceptance engineer derives tests from the
      // contract's criteria only, blind to how the director proposed to build it.
      return { ...base, contract: state.contract };
    case "implementer":
      return { ...base, contract: state.contract, plan: state.plan };
    case "reviewer":
      return { ...base, prNumber: state.prNumber };
    default:
      throw new Error(`ATLAS SUPERVISOR: unknown role "${role}"`);
  }
}

/** Roles that must never receive the implementation plan, for assertion in tests. */
export const PLAN_BLIND_ROLES = Object.freeze(["auditor", "mission-control", "mission-author", "criterion-critic", "acceptance-engineer"]);
