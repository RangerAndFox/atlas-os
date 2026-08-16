# The Atlas authority model

One diagram and one rule. Everything else in this plugin follows from them.

```
     YOU (human)
       │
       ├── authority surface ─── never reachable by an agent
       │     • GitHub merge approval on a protected branch
       │     • GitHub environment required reviewer (release)
       │     • node scripts/atlas.mjs promote|activate|accept|advance-head
       │
       ▼
   ┌───────────────────────────────────────────────────────────┐
   │  .atlas/project.json   .atlas/missions/*.json             │  ← human-written
   │  (policy, gates, invariants, live missions)                │     agent-readable
   └───────────────────────────────────────────────────────────┘
       │  read only
       ▼
   hooks/atlas-guard.mjs  ── PreToolUse, exit 2 = hard deny
       │  runs BELOW the model; not overridable, not negotiable
       ▼
   ┌───────────────────────────────────────────────────────────┐
   │  agents: auditor · mission-control · mission-author ·      │
   │  acceptance-engineer · engineering-director · implementer ·│
   │  reviewer                                                  │
   │  may write: src (in mission scope) · tests/acceptance      │
   │             (acceptance-engineer only) · .atlas/proposals  │
   │             · .atlas/evidence · .atlas/reports             │
   └───────────────────────────────────────────────────────────┘
```

**The rule:** the governed may request, observe, and act within a grant. Only the governor may create, widen, or clear one.

## Why the boundary is drawn here

The previous Atlas implementation exposed `record_human_decision` and `set_standing_authorization` as MCP tools. The controller — a language model — could therefore clear its own gate and grant itself every authorization. That was not a coding error; it was the boundary in the wrong place. Any gate implemented on the surface the agent controls is a gate the agent holds the key to.

So three things are structurally impossible here rather than merely discouraged:

1. **An agent cannot approve a merge.** GitHub blocks approving your own PR, and `require_last_push_approval` means an agent that pushed cannot be the approver. The identity system is outside Atlas.
2. **An agent cannot activate a mission.** A mission declares its own `scope.allowWrite`, so an agent able to write `.atlas/missions/` could widen its own authority. Agents draft into `.atlas/proposals/`; a human promotes.
3. **An agent cannot edit an acceptance test.** `tests/acceptance/**` is writable only by `atlas-acceptance-engineer`, which never sees the implementation plan. This closes the most common agentic failure: editing the test until it passes.

## Where enforcement actually happens

| Control | Enforced by | Overridable by the model? |
|---|---|---|
| Publication, history mutation, deploy, migration | `atlas-guard.mjs` PreToolUse, exit 2 | No |
| Secret paths (read and write) | `atlas-guard.mjs` + platform protected paths | No |
| Manifests, lockfiles, CI, `.git/**`, `.atlas/**` | `atlas-guard.mjs` + platform protected paths | No |
| Mission file scope | `atlas-guard.mjs` against `scope.allowWrite` | No |
| Acceptance-test immutability | `atlas-guard.mjs` by role | No |
| Merge | GitHub ruleset on the default branch | No |
| Release | GitHub environment required reviewers | No |
| Acceptance | `atlas.mjs accept`, which refuses on non-green criteria | No |
| Role boundaries (who does what) | Agent definitions + prompts | **Yes — these are guidance** |

That last row is the honest limit. Role discipline is prompt-level: a subagent asked to do two jobs will sometimes do both. The controls that matter are the ones above it, which is why the security-relevant ones are all in the guard or in GitHub rather than in an agent's instructions.

## Known gaps

- **Role attribution in the hook payload is best-effort.** Claude Code does not guarantee an agent identifier to `PreToolUse`. The guard therefore treats an unknown role as the *least* privileged, so a missing field can never grant access — but verify attribution works in your version before relying on the acceptance-test rule as your only barrier. `hooks/atlas-guard.test.sh` covers the unknown-role case.
- **The guard fails closed on its own bugs.** Policy denials and guard crashes both
  block by default. `ATLAS_GUARD_FAIL_OPEN=1` is an explicit diagnostic escape hatch;
  never enable it in a governed agent session.
- **MCP servers and hooks run outside the built-in Bash sandbox.** If you add MCP servers, they are not constrained by the sandbox ladder.
- **A Routine or scheduled cloud run has no approval prompts by design.** That is exactly why the gate is a merge and not a prompt. Keep scheduled runs pushing to a `claude/*` branch and let the ruleset hold the line.
