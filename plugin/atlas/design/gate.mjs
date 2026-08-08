// @ts-nocheck
/**
 * The design gate — the ONE place the design verdict becomes a merge decision.
 *
 * It is pure and testable so that the logic proven by tests/acceptance/design-director/
 * is the SAME logic the CI workflow enforces (the workflow calls evaluateDesignGate and
 * exits non-zero when it says `blocks`). A gate whose tests exercise different logic than
 * production is a control that doesn't control — the exact Atlas failure this repo forbids.
 *
 * Fail-closed everywhere: missing evidence, a dead harness, or a missing verdict all
 * resolve to BLOCK, never to pass.
 */

/**
 * @param {object} i
 * @param {boolean} i.designEnabled          project.json design.enabled
 * @param {boolean} i.prTouchesDesignPaths   PR changed files intersect design.paths
 * @param {number}  i.harnessExitCode        exit code of the "bring the UI up" harness (0 ok)
 * @param {boolean} i.readyOk                readyUrl returned 200 before capture
 * @param {number}  i.screenshotsCaptured    count of PNGs actually written this run
 * @param {number}  i.declaredScreens        screens x viewports expected from config
 * @param {number|null} i.functionSignalExit repo e2e exit code, or null if none configured
 * @param {'GO'|'NO-GO'|null} i.reviewerVerdict  the design-director model's verdict
 * @param {{present:boolean, actorIsOwner:boolean}} i.override  owner-override label state
 * @returns {{status:string, blocks:boolean, pass:boolean, effectiveVerdict:string|null, reason:string}}
 */
export function evaluateDesignGate(i) {
  const skip = (reason) => ({ status: "skipped", blocks: false, pass: false, effectiveVerdict: null, reason });
  const block = (reason, effectiveVerdict = "NO-GO") => ({ status: "blocked", blocks: true, pass: false, effectiveVerdict, reason });

  // AC-D5 — scoped skip is NOT a pass. Repos with no UI, or PRs that touch no
  // user-facing path, are informational: they do not block, but pass=false so they
  // are never recorded as a green design pass.
  if (!i.designEnabled) return skip("design review disabled for this repo (design.enabled=false)");
  if (!i.prTouchesDesignPaths) return skip("PR touches no design.paths — no user-facing surface changed");

  // AC-D4 — owner-only override, evaluated before anything the machine could influence.
  // Present-but-not-owner is a HARD block (the machine account cannot self-clear); a
  // genuine owner override bypasses the design check only, and is not a pass.
  if (i.override && i.override.present) {
    if (!i.override.actorIsOwner) return block("atlas-override-design present but not applied by the owner — refused");
    return { status: "overridden", blocks: false, pass: false, effectiveVerdict: null, reason: "owner override (design check bypassed; code-owner review still stands)" };
  }

  // AC-D2 — can't render ⇒ NO-GO. A dead harness or a UI that never came up can never
  // read as a pass, whatever the model says.
  if (i.harnessExitCode !== 0) return block("UI harness exited non-zero — nothing could be rendered to review");
  if (!i.readyOk) return block("readyUrl never returned 200 — the app did not come up");

  // AC-D1 — no screenshot, no GO. This is checked BEFORE the model verdict, so a GO with
  // zero captured images still blocks: a design pass that looked at no image looked at nothing.
  if (!(i.screenshotsCaptured > 0)) return block("no screenshots were captured — there is nothing to have reviewed");
  if (i.declaredScreens > 0 && i.screenshotsCaptured < i.declaredScreens) {
    return block(`only ${i.screenshotsCaptured}/${i.declaredScreens} declared screens rendered — a declared screen is missing from the captures`);
  }

  // AC-D7 — works as intended. The repo's own e2e is the function signal; a failing (or
  // errored) run is a NO-GO on its own, independent of how the screens look.
  if (i.functionSignalExit !== null && i.functionSignalExit !== undefined && i.functionSignalExit !== 0) {
    return block("the repo's own end-to-end run failed — it may render but it does not work as intended");
  }

  // Only now does the model verdict decide. A null/absent verdict fails closed.
  if (i.reviewerVerdict !== "GO") {
    return block(`design-director verdict was ${i.reviewerVerdict ?? "absent"}`, i.reviewerVerdict ?? "NO-GO");
  }
  return { status: "pass", blocks: false, pass: true, effectiveVerdict: "GO", reason: "rendered, functioned, and design-director returned GO" };
}
