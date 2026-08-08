// @ts-nocheck
/**
 * The supervisor's authority surface — deliberately tiny.
 *
 * The last orchestrator died because it HELD the gates (promote/authorize/merge as
 * callable tools it could clear itself). The supervisor holds none. This module names
 * the only things it may do, and gives a check that FAILS if a forbidden capability
 * ever appears on any interface the driver is handed. AC-6 is enforced here: not "the
 * supervisor promises not to merge" but "the supervisor has no method that could."
 */

/** The only verbs the driver is allowed to reach, by interface.method name. */
export const SUPERVISOR_TOOLS = Object.freeze([
  "roles.run",
  "git.openPR",
  "io.readLiveMission",
  "io.writeProposal",
  "io.writeReport",
  "io.appendEvidence",
]);

/**
 * Verbs that would let the supervisor cross an authority gate. If any method on a
 * handed-in interface matches one of these, the surface is unsafe and we refuse to run.
 */
export const FORBIDDEN_VERBS = Object.freeze([
  "promote",
  "activate",
  "merge",
  "approve",
  "label",
  "bypass",
  "ruleset",
  "override",
  // writing the files that decide authority is itself a forbidden capability:
  "writeproject",
  "writemission",
  "writelivemission",
  "setauthorization",
  "standingauthorization",
]);

/**
 * The EXACT method surface the supervisor accepts on each injected interface. This is
 * the real guarantee — an allowlist, not a substring denylist. The reviewer noted the
 * denylist below can be beaten by a gate-crossing method with an innocent name (e.g.
 * `finalize`); this closes that: any method NOT on this list is refused regardless of
 * its name, so an unknown capability can never reach the driver in the first place.
 */
export const EXPECTED_METHODS = Object.freeze({
  roles: ["run"],
  git: ["openPR"],
  io: ["readLiveMission", "writeProposal", "writeReport", "appendEvidence"],
});

/**
 * Refuse an interface that exposes any method outside `allowed`, or is missing one of
 * them. Names are irrelevant — only the exact set is accepted. This is what actually
 * bounds the supervisor's power; assertNoForbiddenVerbs is kept below as a second,
 * weaker layer (a fast, obvious rejection of the obvious cases).
 */
export function assertExactSurface(iface, allowed, label = "surface") {
  const methods = Object.keys(iface || {}).filter((k) => typeof iface[k] === "function");
  for (const m of methods) {
    if (!allowed.includes(m)) {
      throw new Error(
        `ATLAS SUPERVISOR: interface "${label}" exposes unexpected method "${m}". ` +
          `The supervisor accepts only [${allowed.join(", ")}] on ${label} — an unknown method, ` +
          `however innocently named, could carry authority, so it is refused.`,
      );
    }
  }
  for (const need of allowed) {
    if (typeof iface?.[need] !== "function") {
      throw new Error(`ATLAS SUPERVISOR: interface "${label}" is missing required method "${need}".`);
    }
  }
}

/** Throw if any method name on `surface` (object or array of names) contains a forbidden verb. */
export function assertNoForbiddenVerbs(surface, label = "surface") {
  const names = Array.isArray(surface)
    ? surface
    : Object.keys(surface || {}).filter((k) => typeof surface[k] === "function");
  for (const name of names) {
    const norm = String(name).toLowerCase().replace(/[_\-.]/g, "");
    for (const verb of FORBIDDEN_VERBS) {
      if (norm.includes(verb)) {
        throw new Error(
          `ATLAS SUPERVISOR: forbidden capability "${name}" on ${label}. ` +
            `The supervisor routes proposals; it must not hold gate-crossing verbs (${verb}).`,
        );
      }
    }
  }
}
