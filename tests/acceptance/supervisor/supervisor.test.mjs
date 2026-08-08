// @ts-nocheck
/**
 * Acceptance tests for the Atlas supervisor — AC-1..7 from the mission contract.
 * Every safety criterion is asserted as a CAPABILITY/STRUCTURE property, per the
 * criterion-critic: we prove the supervisor cannot cross a gate, not that it chose
 * not to. Run: node --test tests/acceptance/supervisor/
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runMission } from "../../../plugin/atlas/supervisor/supervisor.mjs";
import { buildRolePayload, PLAN_BLIND_ROLES } from "../../../plugin/atlas/supervisor/payloads.mjs";
import { assertNoForbiddenVerbs, SUPERVISOR_TOOLS, FORBIDDEN_VERBS } from "../../../plugin/atlas/supervisor/authority.mjs";
import { promotionGate, mergeGate } from "../../../plugin/atlas/supervisor/gates.mjs";

const PLAN_MARKER = "PLAN_MARKER_should_never_reach_acceptance_engineer";

function makeFakes({ live = null } = {}) {
  const calls = { roles: [], openPR: 0, writeProposal: [], evidence: [] };
  const roles = {
    async run(role, payload) {
      calls.roles.push({ role, payload });
      const canned = {
        auditor: { reality: "audited" },
        "mission-control": { direction: "do the thing" },
        "mission-author": { contract: "CONTRACT" },
        "criterion-critic": { critique: "attacked" },
        director: { plan: PLAN_MARKER },
        "acceptance-engineer": { tests: "red tests" },
        implementer: { impl: "built" },
        reviewer: { verdict: "GO" },
      };
      return canned[role] ?? {};
    },
  };
  const git = {
    async openPR(o) {
      calls.openPR += 1;
      return { number: 99, ...o };
    },
  };
  const io = {
    async readLiveMission() {
      return live;
    },
    async writeProposal(id, body) {
      calls.writeProposal.push({ id, body });
    },
    async writeReport() {},
    async appendEvidence(e) {
      calls.evidence.push(e);
    },
  };
  return { roles, git, io, calls };
}

// ---- AC-1 — Produces, never promotes -------------------------------------------
test("AC-1: drafts a proposal and halts at promotion; never opens a PR", async () => {
  const f = makeFakes({ live: null });
  const r = await runMission({ intent: "x", missionId: "m1", ...f });
  assert.equal(r.halt, "promote");
  assert.equal(r.proposalWritten, true);
  assert.equal(f.calls.writeProposal.length, 1);
  assert.equal(f.calls.openPR, 0, "must not open a PR before promotion");
});

// ---- AC-2 — Cannot make a mission live -----------------------------------------
test("AC-2: the io surface exposes no verb that could write live mission state", () => {
  const f = makeFakes();
  // capability check: no writeProject/writeMission/etc. on io
  assert.doesNotThrow(() => assertNoForbiddenVerbs(f.io, "io"));
});
test("AC-2: an io that CAN write live mission state is refused before running", async () => {
  const f = makeFakes({ live: null });
  const unsafeIo = { ...f.io, writeLiveMission: async () => {} };
  await assert.rejects(
    () => runMission({ intent: "x", missionId: "m1", roles: f.roles, git: f.git, io: unsafeIo }),
    /forbidden capability/i,
  );
});
test("AC-2: writing a proposal does NOT make a mission live (proposal is not authority)", async () => {
  const f = makeFakes({ live: null }); // no live mission even though a proposal gets written
  const r = await runMission({ intent: "x", missionId: "m1", ...f });
  assert.equal(r.halt, "promote", "a written proposal must never be read back as promotion");
});

// ---- AC-3 — Opens, never merges ------------------------------------------------
test("AC-3: after promotion, opens exactly one PR and halts at merge", async () => {
  const f = makeFakes({ live: { status: "active" } });
  const r = await runMission({ intent: "x", missionId: "m1", ...f });
  assert.equal(f.calls.openPR, 1);
  assert.equal(r.halt, "merge");
  assert.ok(r.pr && r.pr.number, "returns the opened PR");
});

// ---- AC-4 — Honors the gate ----------------------------------------------------
test("AC-4: git surface exposes no merge/label/override — a NO-GO cannot be bypassed", () => {
  const f = makeFakes();
  assert.doesNotThrow(() => assertNoForbiddenVerbs(f.git, "git"));
  // and a git that COULD merge is refused
  assert.throws(() => assertNoForbiddenVerbs({ ...f.git, merge: () => {} }, "git"), /forbidden/i);
});
test("AC-4: the merge gate has no GO->merge branch; it only ever halts", () => {
  const g = mergeGate();
  assert.equal(g.halt, "merge");
  assert.ok(!("proceed" in g), "supervisor must not have a proceed-to-merge outcome");
});

// ---- AC-5 — Role input isolation is real, not prose ----------------------------
test("AC-5: acceptance-engineer payload never contains the director's plan", () => {
  const state = { intent: "x", missionId: "m", contract: "CONTRACT", plan: PLAN_MARKER, audit: {} };
  const payload = buildRolePayload("acceptance-engineer", state);
  assert.ok(!JSON.stringify(payload).includes(PLAN_MARKER), "plan leaked into acceptance-engineer payload");
});
test("AC-5: every plan-blind role excludes the plan; the implementer alone receives it", () => {
  const state = { intent: "x", missionId: "m", contract: "CONTRACT", plan: PLAN_MARKER, audit: {}, direction: {} };
  for (const role of PLAN_BLIND_ROLES) {
    assert.ok(!JSON.stringify(buildRolePayload(role, state)).includes(PLAN_MARKER), `${role} must not see the plan`);
  }
  assert.ok(JSON.stringify(buildRolePayload("implementer", state)).includes(PLAN_MARKER), "implementer needs the plan");
});

// ---- AC-6 — No gate-clearing tool in hand --------------------------------------
test("AC-6: the declared tool surface contains no gate-crossing verb", () => {
  for (const tool of SUPERVISOR_TOOLS) {
    const norm = tool.toLowerCase().replace(/[_\-.]/g, "");
    for (const verb of FORBIDDEN_VERBS) {
      assert.ok(!norm.includes(verb), `SUPERVISOR_TOOLS leaks a forbidden verb: ${tool}`);
    }
  }
});
test("AC-6: runMission refuses to start if any interface carries a forbidden verb", async () => {
  const f = makeFakes({ live: null });
  const rolesWithPromote = { ...f.roles, promote: async () => {} };
  await assert.rejects(
    () => runMission({ intent: "x", missionId: "m", roles: rolesWithPromote, git: f.git, io: f.io }),
    /forbidden capability/i,
  );
});

// ---- AC-7 — Session-scoped, no durable authority -------------------------------
test("AC-7: two runs are independent — the driver holds no cross-run state", async () => {
  const a = makeFakes({ live: null });
  const b = makeFakes({ live: null });
  await runMission({ intent: "first", missionId: "a", ...a });
  await runMission({ intent: "second", missionId: "b", ...b });
  assert.equal(a.calls.writeProposal[0].id, "a");
  assert.equal(b.calls.writeProposal[0].id, "b", "second run must not inherit first run's state");
});
test("AC-7: promotion depends only on live mission state, never on a supervisor-written artifact", async () => {
  // proposal written, but readLiveMission=null -> still halts. The only authority read
  // is the owner-written live mission; the supervisor's own writes are never authority.
  const f = makeFakes({ live: null });
  const r = await runMission({ intent: "x", missionId: "m", ...f });
  assert.equal(f.calls.writeProposal.length, 1, "a proposal WAS written");
  assert.equal(r.halt, "promote", "yet it is not treated as promotion");
});
