---
name: atlas-supervisor
description: Run one Atlas mission end-to-end through the roles automatically, stopping only at the two authority gates (promote, merge). Use to drive a mission from a product intent to an opened PR without invoking each role by hand. Session-scoped; holds no authority.
---

# Atlas supervisor — auto-handoff between the roles

The supervisor runs the roles for you — auditor → mission-control → mission-author →
criterion-critic, then (after you promote) director → acceptance-engineer →
implementer → PR — threading each role's structured output into the next. Your
involvement is the two yes/no taps that were always yours: **promote the mission**,
**approve the merge**.

It is a scheduler with no keys. It writes only `.atlas/proposals/`, `.atlas/reports/`,
`.atlas/evidence/`. It cannot promote a mission or merge a PR — those stay with
`atlas.mjs promote` (you) and the CI reviewer + your approval. See
`plugin/atlas/supervisor/` and the invariant tests in `tests/acceptance/supervisor/`.

## Run it

The driver is `plugin/atlas/supervisor/supervisor.mjs`, exporting `runMission(ctx)`.
`ctx` supplies three injected interfaces — this is what keeps the supervisor unable to
cross a gate:

- `roles.run(role, payload)` — spawns the named role subagent, returns its structured
  output. (In a Claude Code session, wire this to the Task/subagent tool.)
- `git.openPR({...})` — opens a PR as the machine account. **No** merge/label/promote.
- `io` — `readLiveMission(id)`, `writeProposal`, `writeReport`, `appendEvidence`.
  Reads/writes only under `.atlas/`; has **no** method that writes `.atlas/project.json`
  or `.atlas/missions/**`.

`runMission` returns `{halt:"promote"}` after drafting the proposed contract, and
`{halt:"merge", pr}` after opening the PR. Each halt returns to you; the supervisor
does not act past it.

## The two halts (do not automate past these)

1. **`halt: "promote"`** — a proposed mission contract is in `.atlas/proposals/`.
   Read it. To proceed, run `atlas.mjs promote <id>` yourself. Re-invoking the
   supervisor after promotion resumes the build. It resumes only because *you* made the
   mission live — the supervisor detects promotion by reading live mission state, never
   a flag it wrote itself.
2. **`halt: "merge"`** — a PR is open. The CI independent reviewer gates it; you approve
   the merge (or it auto-merges on GO for ordinary paths). The supervisor never merges.

## Invariants (enforced by tests, not by trust)

`node --test tests/acceptance/supervisor/supervisor.test.mjs` proves:

- It writes a proposal and halts; it never opens a PR before promotion (AC-1).
- Its `io` cannot write live mission state, and an `io` that could is refused at entry
  (AC-2). A written proposal is never read back as promotion (AC-2).
- After promotion it opens exactly one PR and halts; it never merges (AC-3, AC-4).
- The acceptance-engineer's payload never contains the director's plan (AC-5).
- Its whole tool surface carries no promote/merge/label/override verb; `runMission`
  refuses to start if any handed-in interface does (AC-6).
- Two runs share no state; promotion depends only on owner-written live mission state
  (AC-7).

If any of these fail, the supervisor is unsafe — do not run it until they pass.

## Do not

- Give the supervisor an interface with a merge/promote/label/ruleset method. It will
  refuse to start, by design — do not "work around" the refusal.
- Treat a `halt` as advisory. The halts are the authority gates; automating past them
  rebuilds the controller-clears-its-own-gate defect that deprecated the last
  orchestrator.
