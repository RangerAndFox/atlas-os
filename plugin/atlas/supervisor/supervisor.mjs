// @ts-nocheck
/**
 * Atlas auto-handoff supervisor — the driver.
 *
 * Runs one mission through the roles, threading each role's structured output into the
 * next role's payload, writing only proposals/reports/evidence, and STOPPING at the two
 * authority gates (promote, merge). It is a scheduler with no keys: every dangerous
 * action is behind an injected interface (`roles`, `git`, `io`) that, by construction,
 * exposes no gate-crossing verb (checked at entry via assertNoForbiddenVerbs).
 *
 * No module-level mutable state: all state is local to a call, so the driver holds no
 * authority between runs (AC-7). Re-entry after promotion re-reads live mission state
 * written by the human — never a flag the supervisor itself wrote.
 */

import { buildRolePayload } from "./payloads.mjs";
import { promotionGate, mergeGate } from "./gates.mjs";
import { assertNoForbiddenVerbs, SUPERVISOR_TOOLS } from "./authority.mjs";

const DRAFT_ROLES = ["auditor", "mission-control", "mission-author", "criterion-critic"];
const BUILD_ROLES = ["director", "acceptance-engineer", "implementer"];

/**
 * @param {object} ctx
 * @param {string} ctx.intent            product intent to run
 * @param {string} [ctx.missionId]       id used for proposal/live-mission lookup
 * @param {{run:(role,payload)=>Promise<any>}} ctx.roles   spawns a role, returns its structured output
 * @param {{openPR:(o)=>Promise<any>}} ctx.git             opens a PR (NO merge/label/promote)
 * @param {{readLiveMission:(id)=>Promise<any>, writeProposal:Function, writeReport:Function, appendEvidence:Function}} ctx.io
 * @returns {Promise<{halt:string, [k:string]:any}>}
 */
export async function runMission(ctx) {
  // Refuse to run if any handed-in interface carries a gate-crossing verb. This is AC-6:
  // capability, checked before we do anything, not intention observed afterwards.
  assertNoForbiddenVerbs(ctx.roles, "roles");
  assertNoForbiddenVerbs(ctx.git, "git");
  assertNoForbiddenVerbs(ctx.io, "io");

  const state = {
    intent: ctx.intent,
    missionId: ctx.missionId ?? null,
  };

  // ---- Draft phase: reality -> direction -> contract -> critique -----------------
  state.audit = await ctx.roles.run("auditor", buildRolePayload("auditor", state));
  state.direction = await ctx.roles.run("mission-control", buildRolePayload("mission-control", state));
  state.contract = await ctx.roles.run("mission-author", buildRolePayload("mission-author", state));
  state.critique = await ctx.roles.run("criterion-critic", buildRolePayload("criterion-critic", state));

  await ctx.io.writeProposal(state.missionId ?? "supervisor-proposal", {
    contract: state.contract,
    critique: state.critique,
  });
  await ctx.io.appendEvidence({ at: "draft-complete", missionId: state.missionId });

  // ---- Gate 1: promotion (human). We only ever READ live mission state. ----------
  const live = await ctx.io.readLiveMission(state.missionId);
  const g1 = promotionGate(live);
  if (g1.halt) return { halt: "promote", reason: g1.reason, proposalWritten: true };

  // ---- Build phase (only reached because a human promoted): plan -> tests -> impl -
  state.plan = await ctx.roles.run("director", buildRolePayload("director", state));
  state.tests = await ctx.roles.run("acceptance-engineer", buildRolePayload("acceptance-engineer", state));
  state.impl = await ctx.roles.run("implementer", buildRolePayload("implementer", state));

  const pr = await ctx.git.openPR({ missionId: state.missionId, contract: state.contract });
  await ctx.io.appendEvidence({ at: "pr-opened", missionId: state.missionId, pr });

  // ---- Gate 2: merge (CI reviewer + owner). The supervisor never merges. ----------
  const g2 = mergeGate();
  return { halt: g2.halt, reason: g2.reason, pr };
}

export { SUPERVISOR_TOOLS };
