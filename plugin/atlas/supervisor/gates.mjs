// @ts-nocheck
/**
 * The two authority gates. Neither ACTS — each returns a "halt" the driver obeys by
 * returning to its caller. The supervisor has no code path that promotes a mission or
 * merges a PR; those live in the human CLI (`atlas.mjs promote`) and CI + owner approval.
 */

/**
 * Gate 1 — promotion. Called after the proposed contract is written. The mission is
 * "live" only if a human promoted it, which we detect by reading owner-written live
 * mission state (never a supervisor-written flag — that would be the standing-
 * authorization defect). Returns a halt when not yet promoted.
 */
export function promotionGate(liveMission) {
  if (liveMission && liveMission.status === "active") return { proceed: true };
  return { halt: "promote", reason: "awaiting human promotion via atlas.mjs promote" };
}

/**
 * Gate 2 — merge. The supervisor NEVER merges; it opens the PR and stops. This gate
 * only decides whether the supervisor is done (PR opened, hand to CI + owner) or
 * blocked (it must not re-enter to flip a verdict). It cannot merge in any branch.
 */
export function mergeGate() {
  // There is intentionally no "GO -> merge" branch. GO or not, the supervisor stops;
  // the CI reviewer + the owner decide the merge. This function exists to make that
  // explicit and to give the driver a single, act-free stopping point.
  return { halt: "merge", reason: "PR opened; merge is the CI reviewer + owner's decision, not the supervisor's" };
}
