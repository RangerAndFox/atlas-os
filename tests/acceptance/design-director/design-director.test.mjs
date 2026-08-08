// @ts-nocheck
/**
 * Acceptance tests for the Atlas design-director gate — AC-D1..D7.
 * Every criterion is asserted as a CAPABILITY/STRUCTURE property: we prove the gate
 * CANNOT let an unrendered/unseen/failing change through, not that it happened to say no.
 * The workflow calls evaluateDesignGate and exits on `blocks`, so this logic IS the gate.
 * Run: node --test tests/acceptance/design-director/design-director.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateDesignGate } from "../../../plugin/atlas/design/gate.mjs";
import { assertNoForbiddenVerbs, assertExactSurface } from "../../../plugin/atlas/supervisor/authority.mjs";

// A fully-healthy user-facing run: enabled, touches design paths, rendered everything,
// e2e passed, model said GO, no override. The baseline we perturb one field at a time.
function ok(overrides = {}) {
  return {
    designEnabled: true,
    prTouchesDesignPaths: true,
    harnessExitCode: 0,
    readyOk: true,
    screenshotsCaptured: 4,
    declaredScreens: 4,
    functionSignalExit: 0,
    reviewerVerdict: "GO",
    override: { present: false, actorIsOwner: false },
    ...overrides,
  };
}

// ---- AC-D1 — evidence-backed: no screenshot, no GO ------------------------------
test("AC-D1: a GO verdict with zero screenshots still BLOCKS", () => {
  const g = evaluateDesignGate(ok({ screenshotsCaptured: 0, declaredScreens: 0 }));
  assert.equal(g.blocks, true);
  assert.equal(g.pass, false);
  assert.match(g.reason, /no screenshots/i);
});
test("AC-D1: a declared screen missing from the captures BLOCKS even on GO", () => {
  const g = evaluateDesignGate(ok({ screenshotsCaptured: 3, declaredScreens: 4 }));
  assert.equal(g.blocks, true);
  assert.match(g.reason, /missing from the captures/i);
});

// ---- AC-D2 — can't render, NO-GO -----------------------------------------------
test("AC-D2: harness non-zero forces NO-GO regardless of model verdict", () => {
  const g = evaluateDesignGate(ok({ harnessExitCode: 1 }));
  assert.equal(g.blocks, true);
  assert.equal(g.effectiveVerdict, "NO-GO");
});
test("AC-D2: readyUrl never 200 forces NO-GO", () => {
  const g = evaluateDesignGate(ok({ readyOk: false }));
  assert.equal(g.blocks, true);
  assert.equal(g.effectiveVerdict, "NO-GO");
});

// ---- AC-D3 — teeth on user-facing PRs ------------------------------------------
test("AC-D3: a NO-GO on a user-facing PR blocks the merge", () => {
  const g = evaluateDesignGate(ok({ reviewerVerdict: "NO-GO" }));
  assert.equal(g.blocks, true);
});
test("AC-D3: a fully-healthy GO on a user-facing PR passes (teeth don't false-block)", () => {
  const g = evaluateDesignGate(ok());
  assert.equal(g.blocks, false);
  assert.equal(g.pass, true);
  assert.equal(g.effectiveVerdict, "GO");
});

// ---- AC-D4 — owner-only override -----------------------------------------------
test("AC-D4: override present but NOT by the owner is refused (machine cannot self-clear)", () => {
  const g = evaluateDesignGate(ok({ reviewerVerdict: "NO-GO", override: { present: true, actorIsOwner: false } }));
  assert.equal(g.blocks, true);
  assert.match(g.reason, /not applied by the owner/i);
});
test("AC-D4: owner override bypasses the design check only, and is NOT recorded as a pass", () => {
  const g = evaluateDesignGate(ok({ reviewerVerdict: "NO-GO", override: { present: true, actorIsOwner: true } }));
  assert.equal(g.blocks, false);
  assert.equal(g.pass, false, "an override is not a design pass");
  assert.equal(g.status, "overridden");
});

// ---- AC-D5 — a scoped skip is never a pass -------------------------------------
test("AC-D5: design disabled skips without blocking and without passing", () => {
  const g = evaluateDesignGate(ok({ designEnabled: false }));
  assert.equal(g.blocks, false);
  assert.equal(g.pass, false);
  assert.equal(g.status, "skipped");
});
test("AC-D5: a PR touching no design paths skips without blocking and without passing", () => {
  const g = evaluateDesignGate(ok({ prTouchesDesignPaths: false }));
  assert.equal(g.blocks, false);
  assert.equal(g.pass, false);
  assert.equal(g.status, "skipped");
});

// ---- AC-D6 — no standing authority (reuses the proven authority module) --------
test("AC-D6: a sane design surface carries no gate-crossing verb", () => {
  const design = { readScreens() {}, captureEvidence() {}, writeReport() {} };
  assert.doesNotThrow(() => assertNoForbiddenVerbs(design, "design"));
});
test("AC-D6: a design surface with merge/promote/label is refused", () => {
  assert.throws(() => assertNoForbiddenVerbs({ readScreens() {}, merge() {} }, "design"), /forbidden/i);
  assert.throws(() => assertNoForbiddenVerbs({ readScreens() {}, promoteRelease() {} }, "design"), /forbidden/i);
});
test("AC-D6: an innocent-named extra method is refused by the exact-surface allowlist", () => {
  const allowed = ["readScreens", "captureEvidence", "writeReport"];
  assert.throws(
    () => assertExactSurface({ readScreens() {}, captureEvidence() {}, writeReport() {}, finalize() {} }, allowed, "design"),
    /unexpected method "finalize"/,
  );
});

// ---- AC-D7 — works-as-intended is enforced, not narrated -----------------------
test("AC-D7: a failing e2e (functionSignal) BLOCKS even when it renders and model says GO", () => {
  const g = evaluateDesignGate(ok({ functionSignalExit: 1 }));
  assert.equal(g.blocks, true);
  assert.match(g.reason, /does not work as intended/i);
});
test("AC-D7: a null functionSignal (none configured) does not fabricate a function pass", () => {
  // With no e2e configured we do not INVENT a pass; the model verdict still governs,
  // and a GO with real screenshots is allowed. (Absence of a signal is logged upstream.)
  const g = evaluateDesignGate(ok({ functionSignalExit: null }));
  assert.equal(g.blocks, false);
  assert.equal(g.pass, true);
});
