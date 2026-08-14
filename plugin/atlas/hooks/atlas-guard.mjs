#!/usr/bin/env node
/**
 * Atlas policy guard — PreToolUse hook.
 *
 * This is the enforcement layer. It runs below the model: a non-zero exit
 * blocks the tool call and the model cannot override it. Nothing in this file
 * may be influenced by repository content other than the declared project and
 * mission config under .atlas/ (see CONSTITUTION.md, "Policy comes from Atlas").
 *
 * Contract:
 *   stdin  = JSON payload from Claude Code (tool_name, tool_input, ...)
 *   exit 0 = allow
 *   exit 2 = DENY (stderr is returned to the model as the reason)
 *   exit 1 = guard error; treated as non-blocking by design (fail-open on
 *            guard bugs, fail-closed on policy) — see FAIL_OPEN below.
 *
 * Every decision is appended to .atlas/evidence/policy-decisions.jsonl.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";

// A guard crash must not brick the session. Policy denials are still hard.
// Polarity inverted deliberately. This used to read
//   const FAIL_OPEN = process.env.ATLAS_GUARD_FAIL_CLOSED !== "1";
// i.e. a guard that crashed ALLOWED the call, and no adoption step ever turned that
// off — so every adopting project ran fail-open forever without choosing to. A control
// whose own failure mode is "permit" is the pattern this guard exists to prevent.
// The escape hatch is now explicit and opt-in, so the unsafe state requires a decision.
const FAIL_OPEN = process.env.ATLAS_GUARD_FAIL_OPEN === "1";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const ATLAS_DIR = path.join(ROOT, ".atlas");

/* ------------------------------------------------------------------ utils */

/**
 * `absent` and `unparseable` are different facts and must not collapse into one.
 * A missing .atlas/project.json means the repository is not adopted, and the guard
 * correctly has no opinion. A present-but-broken one means something is wrong with
 * the policy itself — and treating that as "not adopted" silently disabled every
 * rule. A merge conflict or a bad edit was enough to turn enforcement off with no
 * signal. `strict` callers get a thrown error, which the fail-closed path denies.
 */
function readJson(file, fallback = null, { strict = false } = {}) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return fallback; // genuinely absent
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    if (strict) {
      throw new Error(`${file} exists but is not valid JSON: ${err.message}. ` +
        `Atlas cannot evaluate policy it cannot read, so the call is denied.`);
    }
    return fallback;
  }
}

/** Minimal glob → RegExp. Supports **, *, ?, and {a,b} alternation. */
function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across separators; **/ also matches zero directories
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) out += "\\{";
      else {
        out += `(?:${glob
          .slice(i + 1, close)
          .split(",")
          .map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = close;
      }
    } else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

function matchesAny(relPath, globs) {
  return (globs || []).some((g) => globToRegExp(g).test(relPath));
}

/**
 * `g=git; $g push` reached main: FORBIDDEN_COMMANDS matches the literal word "git",
 * and a variable holding that word is not the word. This is the same class of
 * indirection the "assembled from a variable" rule already caught for the ARGUMENT
 * (`git checkout $BRANCH`) but not for the COMMAND itself. Rather than special-case
 * one more pattern, resolve simple `name=value` assignments textually and re-check
 * the resolved command too. Deliberately dumb: single hop, no quoting/expansion
 * semantics, command-substitution or export forms are left alone. It does not need
 * to be a shell — it only needs to make `$g` visible as `git` to the same regexes
 * that already catch `git push` written literally.
 */
function resolveSimpleVarIndirection(cmd) {
  const assigns = {};
  for (const m of cmd.matchAll(/(?:^|[;&\n]|&&|\|\|)\s*([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g)) {
    let val = m[2];
    if ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    assigns[m[1]] = val;
  }
  const names = Object.keys(assigns);
  if (!names.length) return cmd;
  let out = cmd;
  for (const name of names) {
    out = out.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}\\b`, "g"), assigns[name]);
  }
  return out;
}

/**
 * `cat .en*` read `.env` in the tree; the token-scan below denies the literal path
 * `.env` but a glob is not the literal path — it is a pattern the shell expands
 * before this guard ever sees a filename. Two defects compounded: the token regex
 * dropped `*`/`?`/`[]` entirely (so `.en*` was scanned as `.en`), and even an intact
 * token was never expanded against the filesystem the way a shell would. Fixed by
 * widening the token regex to keep glob characters, then expanding here exactly as
 * the shell would (single directory level — sufficient for the secret/protected
 * paths this guards, which are never legitimately reached through a deep `**`).
 * An unresolved glob (no matches on disk, e.g. `.env` doesn't exist yet) is NOT
 * treated as safe — it is checked as its own literal pattern, over-denying by design.
 */
function expandGlobToken(cleaned) {
  if (!/[*?[\]]/.test(cleaned)) return [cleaned];
  let abs;
  try {
    const base = cleaned.startsWith("~")
      ? path.join(process.env.HOME || "/root", cleaned.slice(1))
      : path.resolve(ROOT, cleaned);
    abs = base;
  } catch {
    return [cleaned];
  }
  const dir = path.dirname(abs);
  const pattern = path.basename(abs);
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [cleaned];
  }
  const re = globToRegExp(pattern);
  const matches = entries.filter((e) => re.test(e)).map((e) => path.join(dir, e));
  return matches.length ? matches : [cleaned];
}

/** Repo-relative, POSIX-separated, no leading "./". Null if outside the repo. */
function relativize(target) {
  if (!target || typeof target !== "string") return null;
  let abs = path.resolve(ROOT, target);
  // resolve() is lexical, so a symlink inside the repo pointing out of it produced
  // an in-repo relative path and passed every check. Walk to the nearest existing
  // ancestor and realpath THAT — the target itself often does not exist yet (Write).
  try {
    let probe = abs, tail = [];
    for (;;) {
      try { probe = realpathSync(probe); break; } catch {
        const parent = path.dirname(probe);
        if (parent === probe) { probe = null; break; }
        tail.unshift(path.basename(probe));
        probe = parent;
      }
    }
    if (probe) abs = tail.length ? path.join(probe, ...tail) : probe;
  } catch { /* fall through to the lexical result */ }
  const root = (() => { try { return realpathSync(ROOT); } catch { return ROOT; } })();
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

// The harness's own ephemeral scratch (plan-mode + todo files) lives under ~/.claude/
// outside the repo. Allow ONLY those two directories — never the rest of ~/.claude/,
// which holds settings.json; writing there would let a session widen its own
// permissions, the one escalation this must never permit.
function isHarnessScratch(target) {
  try {
    const home = process.env.HOME || "";
    if (!home || !target) return false;
    const abs = path.resolve(target.startsWith("~/") ? path.join(home, target.slice(2)) : target);
    const bases = [path.join(home, ".claude", "plans"), path.join(home, ".claude", "todos")];
    return bases.some((b) => abs === b || abs.startsWith(b + path.sep));
  } catch {
    return false;
  }
}

// Quote-aware shell tokeniser: strips surrounding quotes, keeps a quoted value with
// spaces as ONE token, and emits ; & | ( ) AND a newline as their own tokens so a
// second command can't merge into the first. Not a full shell parser — enough to
// inspect a git push safely.
//
// A NEWLINE IS A COMMAND SEPARATOR. It used to fall through to the generic
// whitespace branch, so a following command's words were absorbed as arguments of
// the first: `git push\ngit status` tokenised as `git push git status`, which
// satisfied the ">= 2 positionals" bare-push rule and was ALLOWED — it pushed the
// checked-out branch (main) to the remote. `git push;git status` denied correctly.
// Verified end-to-end against a bare remote before and after this change.
//
// A backslash immediately before the newline is a shell LINE CONTINUATION: the
// newline is removed and the command continues, so it must be treated as a word
// break only, never as a command boundary. Otherwise a legitimate multi-line
// `git push \<nl> origin feature/x` would be denied as a bare push.
const SEP_TOKENS = new Set([";", "&", "|", "(", ")", "\n"]);
const isSepToken = (t) => SEP_TOKENS.has(t);

function tokenizeShell(s) {
  const toks = [];
  let cur = "";
  let has = false;
  let q = null;
  let prevBackslash = false; // last char was an unquoted, unescaped backslash
  // CRLF (and a lone CR) normalise to LF so a Windows-style line ending is one
  // separator, and a `\`+CRLF continuation is still recognised as a continuation.
  for (const ch of String(s).replace(/\r\n?/g, "\n")) {
    if (q) {
      if (ch === q) q = null;
      else { cur += ch; }
      has = true;
      prevBackslash = false;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      has = true;
      prevBackslash = false;
    } else if (ch === "\n") {
      if (prevBackslash) {
        // Line continuation: the shell deletes the `\` AND the newline, and the
        // word continues on the next line. Emitting a separator here would deny a
        // legitimate multi-line `git push \<nl> origin feature/x`; emitting a token
        // boundary would split `ma\<nl>in` into two harmless-looking words.
        cur = cur.slice(0, -1);
        if (cur === "") has = false;
        prevBackslash = false;
        continue;
      }
      if (has) { toks.push(cur); cur = ""; has = false; }
      if (toks[toks.length - 1] !== "\n") toks.push("\n");
    } else if (/\s/.test(ch)) {
      if (has) { toks.push(cur); cur = ""; has = false; }
      prevBackslash = false;
    } else if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
      if (has) { toks.push(cur); cur = ""; has = false; }
      toks.push(ch);
      prevBackslash = false;
    } else {
      cur += ch;
      has = true;
      prevBackslash = ch === "\\" ? !prevBackslash : false;
    }
  }
  if (has) toks.push(cur);
  return toks;
}

// Push policy (Option A), enforced by DENY-BY-DEFAULT on the parsed tokens rather than a
// leaky regex. A feature-branch push is allowed; force, remote-delete/prune, direct
// main/master, and a bare/underspecified push (which could reach a protected branch
// from the current checkout) all require a human. Quotes are stripped by the tokeniser,
// so '+feature' / ':feature' cannot hide the marker. Returns a deny decision, or null to
// fall through (allow) when the push is an explicit, clearly-safe feature push.
// True if a token invokes the git binary however it is spelled: `git`, `/usr/bin/git`,
// `./git`, `\git`, `(git`, `g\it`, `"git"`. Backslashes (shell escapes that vanish at
// runtime) and wrapping punctuation/quotes are removed, then the path basename is taken.
// Matching the exact token "git" — the previous approach — let every one of these through.
function isGitBinary(tok) {
  const t = String(tok).replace(/\\/g, "").replace(/^[('"{]+/, "").replace(/[)'"}]+$/, "");
  return t.split("/").pop() === "git";
}

/* ---------------------------------------------------------------------------
 * OPTION-ARITY TABLE for `git push` (arity is a fact, not a heuristic)
 *
 * The bare-push rule counts POSITIONALS ("a push with < 2 positionals names no
 * refspec, so it could reach main → deny"). Any option whose value is a SEPARATE
 * following word donated a phantom positional to that count, which inverted the
 * rule: `git push -o ci.skip origin` counted `ci.skip` + `origin` = 2 positionals,
 * was judged "explicit", and pushed the checked-out branch — main — to the remote.
 * Verified end-to-end against a bare remote.
 *
 * Arity cannot be guessed from the spelling, so it is tabulated from
 * `git push -h` / builtin/push.c, and ANYTHING NOT IN THE TABLE FAILS CLOSED.
 * That is the load-bearing property: git's parse-options accepts unambiguous
 * long-option ABBREVIATIONS (`--push-opt`, `--rece`, `--exe`), so an exact-spelling
 * table alone would leak forever. Denying unknown option-shaped tokens costs a
 * possible false denial of some future/abbreviated flag — the safe direction, and
 * the agent can always spell the option out in full.
 *
 * SEPARATE-VALUE (consume the next word; the value is NOT a positional). Each also
 * accepts the value attached (`--repo=origin`, `-oci.skip`), which consumes nothing.
 *   --repo <repository>            -o / --push-option <option>
 *   --recurse-submodules <mode>    --receive-pack / --exec <program>   (see below)
 * ATTACHED-VALUE ONLY (`[=value]` in the help text — NEVER consumes the next word;
 * writing `--signed yes` makes `yes` a genuine positional, which is correct):
 *   --force-with-lease[=<ref>:<expect>]      --signed[=(yes|no|if-asked)]
 * ZERO-ARITY: everything in PUSH_OPT_ZERO below.
 *
 * `--receive-pack` / `--exec` are DENIED rather than merely consumed: they name a
 * program for the REMOTE to execute. Nothing in an agent's feature-push workflow
 * needs that, and consuming the value would have left
 * `git push --receive-pack X origin feature` allowed. `--all` / `--branches` are
 * denied for the same reason as a bare push — they push every local branch,
 * including main, with no refspec on the command line.
 * ------------------------------------------------------------------------- */
const PUSH_OPT_SEPARATE = new Set([
  "--repo", "--push-option", "-o", "--recurse-submodules",
]);
const PUSH_OPT_ATTACHED_ONLY = new Set([
  "--force-with-lease", "--signed",
]);
const PUSH_OPT_ZERO = new Set([
  "--verbose", "--no-verbose", "--quiet", "--no-quiet",
  "--dry-run", "--no-dry-run", "--porcelain", "--no-porcelain",
  "--thin", "--no-thin", "--set-upstream", "--no-set-upstream",
  "--progress", "--no-progress", "--verify", "--no-verify",
  "--follow-tags", "--no-follow-tags", "--atomic", "--no-atomic",
  "--tags", "--no-tags", "--ipv4", "--ipv6",
  "--no-recurse-submodules", "--no-repo", "--no-push-option", "--no-signed",
  "--no-force-with-lease", "--force-if-includes", "--no-force-if-includes",
  // These are zero-arity but dangerous; the checks above deny them first. Listed
  // so their `--no-` forms and their arity are recorded rather than inferred.
  "--force", "--no-force", "--delete", "--no-delete",
  "--mirror", "--no-mirror", "--prune", "--no-prune",
]);
// Short options that take no value. `-f`, `-d`, `-D` are absent on purpose: the
// force/delete rules deny any cluster containing them before arity is consulted.
const PUSH_OPT_ZERO_SHORT = new Set(["v", "q", "n", "u", "4", "6"]);

/**
 * Classify one option-shaped token that appears after `push`.
 * Returns { skip: true } (option consumes nothing), { consume: true } (the NEXT
 * token is this option's value and must not be counted as a positional), or
 * { deny: <reason> }. Unknown → deny, by design.
 */
function classifyPushOption(tok, nextTok) {
  if (/^--(receive-pack|exec)(=|$)/.test(tok)) {
    return { deny: "`--receive-pack`/`--exec` tell the remote which program to run to receive the push. That is not part of any agent workflow and requires a human." };
  }
  if (/^--(all|branches)$/.test(tok)) {
    return { deny: "`--all`/`--branches` pushes every local branch, including main, with no refspec named. Push one feature branch explicitly." };
  }
  if (tok === "--" || tok === "-") {
    return { deny: "`--`/`-` as a push argument makes the refspec list ambiguous to a static check, so it requires a human." };
  }
  if (tok.startsWith("--")) {
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok : tok.slice(0, eq);
    const known = PUSH_OPT_SEPARATE.has(name) || PUSH_OPT_ATTACHED_ONLY.has(name) || PUSH_OPT_ZERO.has(name);
    if (!known) {
      return { deny: `\`${name}\` is not a recognised \`git push\` option, so the guard cannot know whether it swallows the next word as its value (which would let a refspec-less push look explicit). Unknown options fail closed — spell the option out in full, or hand the command to a human.` };
    }
    if (eq !== -1) return { skip: true }; // value attached, consumes nothing
    if (PUSH_OPT_SEPARATE.has(name)) {
      if (nextTok === undefined || isSepToken(nextTok)) {
        return { deny: `\`${name}\` expects a value and none follows it; the command as written cannot be evaluated.` };
      }
      return { consume: true };
    }
    return { skip: true };
  }
  // Short-option cluster: `-uq`, `-oci.skip`, `-qo ci.skip`. The first char that
  // takes a value swallows the rest of the cluster, or the next word if the
  // cluster ends there — exactly how git's parse-options behaves.
  const body = tok.slice(1);
  if (body === "") return { deny: "A bare `-` is not a valid push argument." };
  for (let k = 0; k < body.length; k += 1) {
    const c = body[k];
    if (c === "o") {
      if (k + 1 < body.length) return { skip: true }; // -oci.skip: value attached
      if (nextTok === undefined || isSepToken(nextTok)) {
        return { deny: "`-o` expects a push option value and none follows it." };
      }
      return { consume: true };
    }
    if (!PUSH_OPT_ZERO_SHORT.has(c)) {
      return { deny: `\`-${c}\` is not a recognised \`git push\` short option, so the guard cannot know whether it swallows the next word as its value. Unknown options fail closed.` };
    }
  }
  return { skip: true };
}

/* ---------------------------------------------------------------------------
 * `git -c <key>=<value> … push` — ad-hoc config on the git BINARY.
 *
 * DECISION: deny `-c` (and `--config-env`) when the key can influence where a push
 * goes or how it authenticates; allow other keys. Reasoning and cost are recorded in
 * FINDINGS.md. The exploit this closes:
 *   git -c remote.origin.push=+HEAD:refs/heads/main push -o ci.skip origin
 * `remote.<name>.push` supplies the refspec when the command line does not, so a
 * push with no refspec on the line becomes a FORCE write of main. Observed to
 * destroy a commit on a real bare remote.
 *
 * A blanket deny of every `-c` is also defensible (an agent has no need for ad-hoc
 * config on a push) and is a one-line change, but it flips the pre-existing test
 * "safe feature push via -c is ALLOWED" (`git -c a=b push -u origin feature`), which
 * is an owner decision, not a bug to be silently rewritten. See FINDINGS.md.
 */
const GIT_C_DENY_KEY = /^(remote|push|url|credential|http|https|ssh|include|includeif|alias|receive|uploadpack|protocol|safe|transfer|pack|gpg|filter|browser|pager|sequence|diff\.external|core\.(hookspath|sshcommand|gitproxy|askpass|pager|editor|fsmonitor|alternaterefsprefixes))([.]|$)/i;

function gitConfigInjectionDeny(value) {
  const v = String(value === undefined ? "" : value);
  if (/[$`]/.test(v)) {
    return "a `-c` config value built from a variable or command substitution cannot be checked statically";
  }
  const m = /^([A-Za-z0-9._-]+)=/.exec(v);
  if (!m) {
    return `\`-c ${v.slice(0, 60)}\` is not a plain <key>=<value>, so the guard cannot tell what it configures`;
  }
  if (GIT_C_DENY_KEY.test(m[1])) {
    return `\`-c ${m[1]}=…\` can change where a push goes, or how it authenticates (a \`remote.*.push\` refspec turns a refspec-less push into a write of main)`;
  }
  return null;
}

// WHAT THIS IS, AND WHAT IT IS NOT.
// This function is DEFENCE IN DEPTH, not the control that protects `main`. Deciding what
// a shell command will actually do is undecidable in general (variables, substitution,
// aliases, config, `eval`, the agent's free choice of spelling), so a blocklist of
// dangerous spellings leaks indefinitely — every fix below was a leak found after the
// previous fix shipped. The AUTHORITATIVE control is the SERVER-SIDE GitHub ruleset on
// the protected branch (plus CODEOWNERS and required status checks): it is evaluated by
// the remote, on the real ref, after every spelling has collapsed to bytes on the wire.
// This function only raises the cost of an accident and makes a deliberate bypass
// visible in the evidence log. Do not treat a non-denial here as proof a push was safe,
// and do not weaken the ruleset because this exists.
//
// CLOSED 2026-08-13 (each was verified to write remote `main` BEFORE the fix and to be
// denied AFTER it, by executing the command against a real bare remote — see FINDINGS.md
// in this directory for the before/after SHAs):
//   1. OPTION-ARITY INFLATION defeated the ">= 2 positionals" bare-push rule: an option
//      whose value is a SEPARATE following word donated a phantom positional, so
//      `git push -o ci.skip origin` counted as "explicit" and pushed the checked-out
//      branch (main). Closed by the OPTION-ARITY TABLE above, which fails CLOSED on any
//      option-shaped token it does not recognise (including git's long-option
//      abbreviations, e.g. `--push-opt`, which no exact-spelling table could cover).
//   2. CONFIG-INJECTED REFSPEC, which compounded (1): `remote.<name>.push` supplies the
//      refspec when the command line does not, so
//      `git -c remote.origin.push=+HEAD:refs/heads/main push -o ci.skip origin`
//      force-wrote main (observed destroying a commit). Closed twice over: the arity fix
//      makes it a bare push, and push-affecting `-c` keys / `GIT_*` env assignments /
//      `--config-env` are now denied on a push segment.
//   3. NEWLINE IS NOW A COMMAND SEPARATOR. tokenizeShell() treated `\n` as ordinary
//      whitespace, so the next command's words were absorbed as positionals of the push:
//      `git push\ngit status` was allowed and was a bare push. `\n` is now emitted as a
//      separator token like `;` (with `\`-continuation handled), and each command in a
//      multi-line block is judged on its own.
//
// KNOWN RESIDUAL EVASIONS (left OPEN deliberately — the ruleset is the control, and
// chasing spellings here is the failure mode):
//   4. CASE VARIANTS of the branch name are not matched (`git push origin MAIN`, `Main`).
//      On a case-sensitive ref store these create a distinct ref and are harmless; on a
//      case-insensitive one they can reach main. Not fixed because case-folding refnames
//      would be wrong on Linux.
//   5. CONFIG ALREADY ON DISK. `-c`/`GIT_*` are the inline routes; a value already in
//      `.git/config` or a global config file is invisible here. Measured against git
//      2.43: with an EXPLICIT refspec present (the only push this guard allows),
//      `remote.*.push` and `push.default` are ignored and `remote.*.mirror` errors out,
//      so on-disk config cannot turn an allowed push into a write of main. What it CAN
//      still do is REDIRECT the allowed feature push to another host
//      (`remote.*.pushurl`, `url.*.pushInsteadOf`). `.git/**` is a protected path, so
//      the shell cannot write it, but a pre-existing value is not detected.
//   6. AN OBSCURE `-c` KEY that affects a push and is outside GIT_C_DENY_KEY still passes
//      (the `-c` rule is a deny-list, not an allow-list — see the DECISION note above).
//   7. WRAPPERS AND INDIRECTION: an alias, a shell function, a script in the repo, `xargs`,
//      `find -exec`, a Makefile target or an MCP/other tool surface that shells out can all
//      reach `git push` without the word `push` ever appearing in the checked command.
// NON-issues confirmed by the same audit, recorded so they are not re-chased: ANSI-C and
// `$"…"` quoting (`$'main'`, `$'ma\x69n'`), IFS manipulation, `--` end-of-options,
// `git -C <dir> push origin main`, and env-var-assigned refs all DENY already (the `$`/
// backtick rule and the backslash normalisation below cover them). Unicode homoglyphs
// (`maіn` with Cyrillic і, or a zero-width joiner) ALLOW but are a DIFFERENT ref than
// `main` and so cannot reach it. A trailing space (`feature:refs/heads/main `) ALLOWs but
// `git check-ref-format` rejects the refname, so it is not reachable.
function gitPushDecision(cmd, context) {
  // TOKENIZE FIRST, decide on tokens only. An earlier version regex-gated this on the
  // raw string (`\bpush\b`), so a quote-split verb — `git p"ush"` — never reached the
  // tokenizer at all. The tokenizer strips quotes, so on tokens `p"ush"` IS `push` and
  // `g"it"` IS `git`; no raw-string check may stand in front of it.
  const toks = tokenizeShell(cmd);
  const deny = (why) => decide("deny", "forbidden-effect", `${why}\nCommand: ${String(cmd).slice(0, 400)}`, context);
  // A quoted token carrying whitespace may be a whole sub-command (`sh -c "git push …"`).
  // Recurse into it so wrapping the push in an interpreter string cannot hide it.
  for (const t of toks) {
    // isSepToken guard: the newline separator token is itself whitespace, so without
    // this the recursion re-tokenised "\n" into ["\n"] forever (stack overflow → the
    // fail-closed handler denied every multi-line command, safe but useless).
    if (!isSepToken(t) && /\s/.test(t)) {
      const sub = gitPushDecision(t, context);
      if (sub) return sub;
    }
  }
  // Strip backslashes from every token before analysis: the shell removes an unquoted
  // `\` before git ever sees it, so `ma\in` is `main`, `--fo\rce` is `--force`, `-\d` is
  // `-d`. Checking the un-normalised token (as an earlier version did for the markers,
  // though not the binary) let a single backslash defeat every dangerous-push rule.
  const ntoks = toks.map((t) => t.replace(/\\/g, ""));
  // Analyse every `git … push` occurrence in every ;/&/| separated segment.
  let i = 0;
  while (i < ntoks.length) {
    if (!isGitBinary(ntoks[i])) { i += 1; continue; }
    // find `push` within this command segment
    let pi = -1;
    for (let j = i + 1; j < ntoks.length; j += 1) {
      const t = ntoks[j];
      if (isSepToken(t)) break;
      if (t === "push") { pi = j; break; }
    }
    if (pi === -1) { i += 1; continue; }
    // Everything between the start of this shell command and `push` is either an
    // env-var assignment prefix or a git BINARY option. Both can redirect the push.
    let segStart = 0;
    for (let k = i - 1; k >= 0; k -= 1) {
      if (isSepToken(ntoks[k])) { segStart = k + 1; break; }
    }
    for (let j = segStart; j < pi; j += 1) {
      const t = ntoks[j];
      // GIT_CONFIG_GLOBAL / GIT_CONFIG_COUNT / GIT_DIR / GIT_SSH_COMMAND … reach the
      // same place `-c` does, through the environment instead of the command line.
      if (/^GIT_[A-Za-z0-9_]*=/.test(t)) {
        return deny(`A \`GIT_*\` environment assignment on a push (\`${t.split("=")[0]}=…\`) can supply configuration — including a \`remote.*.push\` refspec — that decides where the push actually goes. Remove it, or hand the command to a human.`);
      }
      if (t === "-c" || t === "--config-env") {
        const why = gitConfigInjectionDeny(ntoks[j + 1]);
        if (why) return deny(`Ad-hoc git config on a push is refused: ${why}.`);
        if (t === "--config-env") {
          return deny("`--config-env` takes its config value from an environment variable, which a static check cannot read. It requires a human.");
        }
        j += 1; // the key=value is this option's value, not a further option
        continue;
      }
      if (t.startsWith("--config-env=")) {
        return deny("`--config-env` takes its config value from an environment variable, which a static check cannot read. It requires a human.");
      }
      if (t.startsWith("-c") && t.length > 2) {
        const why = gitConfigInjectionDeny(t.slice(2));
        if (why) return deny(`Ad-hoc git config on a push is refused: ${why}.`);
      }
    }
    const positionals = [];
    for (let j = pi + 1; j < ntoks.length; j += 1) {
      const t = ntoks[j];
      if (isSepToken(t)) break; // only this command
      // Shell substitution/expansion in a push argument ($(…), `…`, $VAR) makes the real
      // target unknowable to a static check — `git push origin $(echo main)` resolves to
      // main. A legitimate feature push never needs it, so any such argument is refused.
      if (t.includes("$") || t.includes("`")) return deny("A push argument uses shell substitution or a variable ($(…), `…`, $VAR); its real target can't be checked statically, so it requires a human.");
      if (/^--force(-with-lease|-if-includes)?(=.*)?$/.test(t) || /^-[A-Za-z]*f[A-Za-z]*$/.test(t)) return deny("Force-push overwrites published history and requires a human.");
      if (/^(--delete|--mirror|--prune)$/.test(t) || /^-[A-Za-z]*[dD][A-Za-z]*$/.test(t)) return deny("Deleting or pruning a remote ref requires a human.");
      if (t.startsWith("+")) return deny("Force-push (via +refspec) requires a human.");
      if (t.startsWith(":")) return deny("Deleting a remote ref (via :refspec) requires a human.");
      if (/(?:^|:)(?:refs\/heads\/)?(?:main|master)$/.test(t)) return deny("Pushing directly to main/master requires a human — open a PR.");
      // HEAD/@ are pronouns for "whatever is checked out" — possibly main. Without an
      // explicit :destination they are an unnamed push and are refused. HEAD:feature
      // names its destination and passes (a :main destination is already denied above).
      if (!t.includes(":") && (t === "HEAD" || /^HEAD[~^@]/.test(t) || t === "@" || t.startsWith("@{"))) {
        return deny("Pushing HEAD/@ pushes whatever branch is checked out — possibly main. Name the branch explicitly: `git push origin <branch>`.");
      }
      // OPTION ARITY. Every option-shaped token is classified against the table
      // above: it either consumes nothing, consumes the next word (which must NOT
      // be counted as a positional), or is unknown and denies. Before this, every
      // `-*` token was simply skipped and its separate value was miscounted as a
      // refspec — the bug that made `git push -o ci.skip origin` an allowed bare push.
      if (t.startsWith("-")) {
        const cls = classifyPushOption(t, ntoks[j + 1]);
        if (cls.deny) return deny(cls.deny);
        if (cls.consume) {
          const val = ntoks[j + 1];
          if (val.includes("$") || val.includes("`")) {
            return deny(`The value of \`${t}\` uses shell substitution or a variable; its real content can't be checked statically, so it requires a human.`);
          }
          j += 1;
        }
        continue;
      }
      if (t !== "") positionals.push(t);
    }
    // Require an explicit remote AND refspec. A bare `git push` (or remote-only) could
    // push the current branch — possibly main — with no branch named, so it is refused.
    if (positionals.length < 2) return deny("Name an explicit remote and feature branch: `git push origin <branch>`. A bare push could reach a protected branch.");
    i = pi + 1;
  }
  return null;
}

function decide(verdict, rule, detail, context) {
  try {
    mkdirSync(path.join(ATLAS_DIR, "evidence"), { recursive: true });
    appendFileSync(
      path.join(ATLAS_DIR, "evidence", "policy-decisions.jsonl"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        verdict,
        rule,
        detail,
        ...context,
      })}\n`,
    );
  } catch {
    /* evidence is best-effort; never block on logging failure */
  }
  if (verdict === "deny") {
    process.stderr.write(
      `ATLAS POLICY DENIED [${rule}]\n${detail}\n\n` +
        `This is a deterministic policy control, not a suggestion. Do not retry, ` +
        `do not work around it, and do not edit .atlas/ config to widen your own scope.\n` +
        `If this action is genuinely required by the mission, stop and report it as a ` +
        `blocker so a human can amend the mission or the policy.\n`,
    );
    process.exit(2);
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ config */

// Read eagerly but defer the throw: a top-level throw fires during module init,
// outside the try/catch that honours the fail polarity, so ATLAS_GUARD_FAIL_OPEN
// could not rescue it and the escape hatch was inert.
let policyError = null;
const project = (() => {
  try {
    return readJson(path.join(ATLAS_DIR, "project.json"), null, { strict: true });
  } catch (err) {
    policyError = err;
    return null;
  }
})();

// Not an adopted Atlas project → this guard has no opinion.
// `project === null` has two causes and they must not share an exit. Absent means the
// repository is not adopted and the guard genuinely has no opinion. Unparseable means
// the policy exists and cannot be evaluated — and taking the unadopted branch there is
// how a merge conflict in .atlas/project.json silently switched enforcement off.
if (!project) {
  if (policyError) {
    if (process.env.ATLAS_GUARD_FAIL_OPEN === "1") process.exit(0);
    process.stderr.write(
      `ATLAS POLICY DENIED [unreadable-policy]\n${policyError.message}\n` +
        `Fix .atlas/project.json, or set ATLAS_GUARD_FAIL_OPEN=1 to accept an unenforced session.\n`,
    );
    process.exit(2);
  }
  process.exit(0);
}

const policy = project.policy || {};
const activeMissionId = project.activeMission || null;
const mission = activeMissionId
  ? readJson(path.join(ATLAS_DIR, "missions", `${activeMissionId}.json`), null)
  : null;

const DEFAULT_PROTECTED = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".nvmrc",
  ".git/**",
  ".github/workflows/**",
  ".github/CODEOWNERS",
  "CODEOWNERS",
  ".atlas/**",
  // Anything that grants permission to a future session. A role able to write
  // these can widen its own authority for every subsequent run, which is a
  // strictly larger capability than any single mission's scope.
  ".claude/**",
  "CLAUDE.md",
  "AGENTS.md",
  ".mcp.json",
  ".devcontainer/**",
  "vercel.json",
  "Dockerfile",
  "**/*.config.{js,mjs,cjs,ts}",
  "migrations/**",
  "supabase/**",
];

const DEFAULT_SECRETS = [
  "**/.env",
  "**/.env.*",
  "**/secrets/**",
  "**/credentials/**",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.p8",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/service-account*.json",
  "**/.pypirc",
  // `**/.env.*` does not match `production.env`; these were all reachable.
  "**/*.env",
  "**/.aws/**",
  "**/.git-credentials",
  "**/.netrc",
  "**/terraform.tfstate*",
  "**/.kube/config",
  "**/kubeconfig",
  "**/.docker/config.json",
  "**/*.keystore",
  "**/*.jks",
];

// Effects that must never be reachable from an agent, in any mission.
// Publication, history mutation, infrastructure and destructive commands.
const FORBIDDEN_COMMANDS = [
  // Push is ALLOWED for feature branches — the machine account opens agent PRs, and
  // the independent reviewer + branch ruleset are the real merge gates. Only the
  // dangerous forms stay human-only. The broad `git … push … <marker>` shape means a
  // quoted global option carrying spaces (e.g. `git -c x='a b' push --force`) cannot
  // hide the marker — the evasion that slipped the old blanket rule. Over-denial (a
  // marker word appearing elsewhere on the line) is the safe direction.
  // NOTE: `git push` is NOT matched here. Regex blocklists kept leaking — a quoted
  // refspec ('+feature' / ':feature') put the marker behind a quote, and no regex could
  // require an explicit refspec (a bare `git push` from a main checkout reaches main).
  // Push is handled by gitPushDecision() below: a quote-aware tokeniser that DENIES by
  // default and allows only an explicit, non-force, non-delete, non-main feature refspec.
  { re: /\bgit\s+(?:(?:-[A-Za-z]|--[A-Za-z][A-Za-z-]*)(?:=\S+)?(?:\s+[^\s-]\S*)?\s+)*(commit\s+--amend|rebase|reset\s+--hard|filter-branch|filter-repo)\b/, why: "History mutation requires a human." },
  { re: /\bgit\s+(?:(?:-[A-Za-z]|--[A-Za-z][A-Za-z-]*)(?:=\S+)?(?:\s+[^\s-]\S*)?\s+)*(tag|switch|checkout)\s+.*(-d|-D|--delete)\b/, why: "Ref deletion requires a human." },
  { re: /\bgh\s+(?:(?:-[A-Za-z]|--[A-Za-z][A-Za-z-]*)(?:=\S+)?(?:\s+[^\s-]\S*)?\s+)*(pr\s+(merge|review)|release|workflow\s+run|api\b.*(-X|--method)\s*(POST|PUT|PATCH|DELETE))/, why: "Merging, approving, releasing and write-API calls are human authority." },
  { re: /\bnpm\s+(publish|version)\b|\byarn\s+publish\b|\bpnpm\s+publish\b/, why: "Package publication requires a human." },
  { re: /\b(vercel|netlify|fly|railway)\s+(deploy|--prod)\b|\bvercel\s+--prod\b/, why: "Deployment requires a human." },
  { re: /\bsupabase\s+(db\s+push|migration\s+up|link)\b/, why: "Applying migrations requires a human." },
  { re: /\b(terraform\s+(apply|destroy)|pulumi\s+up|kubectl\s+(apply|delete)|helm\s+(install|upgrade|uninstall))\b/, why: "Infrastructure mutation requires a human." },
  { re: /\bgit\s+(?:(?:-[A-Za-z]|--[A-Za-z][A-Za-z-]*)(?:=\S+)?(?:\s+[^\s-]\S*)?\s+)*clean\s+-[a-z]*[xX]/, why: "git clean -x destroys untracked state including Atlas evidence." },
  { re: /\brm\s+-rf\s+(\/|~|\$HOME)/, why: "Destructive filesystem command." },
  { re: /\bcurl\b[^|;]*\|\s*(ba)?sh\b|\bwget\b[^|;]*\|\s*(ba)?sh\b/, why: "Piping network content into a shell is never permitted." },
  { re: /\bchmod\s+(777|-R\s+777)\b/, why: "Blanket permission changes are not permitted." },
  { re: /\b(git|gh|npm|npx|supabase|vercel)\s+[^\s;|&]*\$/, why: "A subcommand assembled from a variable cannot be checked. Write the command literally." },
  { re: /\beval\b/, why: "eval makes the effective command unknowable to any static check." },
  // atlas.mjs is the HUMAN authority CLI. Its own header claims it is "deliberately
  // NOT reachable from any agent tool surface" — it was, via Bash, and an agent
  // could promote and activate a mission it had drafted, thereby choosing its own
  // scope.allowWrite. That is the whole escalation chain; this is its choke point.
  { re: /atlas\.mjs\b/, why: "atlas.mjs is human authority. Promotion, activation and acceptance are not agent actions." },
  // Symlink creation defeats path checking by construction.
  { re: /\bln\s+(-s|--symbolic)\b/, why: "Symlinks can redirect a checked path to an unchecked one." },
  // git config can relocate hooks or install a credential helper.
  { re: /\bgit\s+(?:(?:-[A-Za-z]|--[A-Za-z][A-Za-z-]*)(?:=\S+)?(?:\s+[^\s-]\S*)?\s+)*config\b(?!\s+--get)/, why: "git config can relocate hooksPath or install a credential helper." },
];

// Paths that decide what Atlas itself enforces. A mission may legitimately declare
// `package.json` or `migrations/**` in scope — that is a normal guarded mission. It may
// never declare these, because writing them rewrites the boundary rather than working
// inside it. Enforced below by stripping them from the mission's own allowlist, so a
// broad `allowWrite: ["**"]` widens nothing that matters. This closes the escalation
// even if promotion is reached by a path FORBIDDEN_COMMANDS does not anticipate.
const POLICY_CRITICAL = [
  ".atlas/project.json",
  ".atlas/missions/**",
  ".claude/**",
  "CLAUDE.md",
  "AGENTS.md",
  ".github/workflows/**",
  ".github/CODEOWNERS",
  "CODEOWNERS",
  ".mcp.json",
];

const protectedPaths = policy.protectedPaths || DEFAULT_PROTECTED;
const secretPaths = policy.secretPaths || DEFAULT_SECRETS;
const acceptancePaths = policy.acceptanceTestPaths || ["tests/acceptance/**"];
const enforceScope = policy.enforceMissionScope !== false;

// Surfaces an agent may write regardless of mission scope. Deliberately narrow:
// drafts and append-only evidence, never live policy or mission state.
const alwaysWritable = [
  ".atlas/proposals/**",
  ".atlas/evidence/**",
  ".atlas/retrospectives/**",
  ".atlas/reports/**",
];

/* -------------------------------------------------------------------- main */

function main() {
let payload = {};
try {
  const raw = readFileSync(0, "utf8");
  payload = raw ? JSON.parse(raw) : {};
} catch {
  if (FAIL_OPEN) process.exit(0);
  process.stderr.write("ATLAS POLICY: guard could not read its input.\n");
  process.exit(2);
}

const toolName = payload.tool_name || payload.toolName || "";
const input = payload.tool_input || payload.toolInput || {};
// Role attribution is best-effort: Claude Code does not guarantee an agent
// identifier in the hook payload. Unknown is treated as the LEAST privileged
// role, so a missing field can never grant access.
const role =
  payload.agent_name ||
  payload.agentName ||
  payload.subagent_type ||
  process.env.ATLAS_ROLE ||
  "unknown";

const context = { tool: toolName, role, mission: activeMissionId };

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

/**
 * Unambiguous write targets in a shell command. Not a parser and not complete —
 * it recognises the forms where the destination is not in doubt. Layer (a) above
 * is what actually holds the line for secrets and protected paths; this adds
 * acceptance-test ownership and mission scope for the cases we can read reliably.
 */
function bashWriteTargets(cmd) {
  const out = new Set();
  const add = (t) => {
    if (!t) return;
    const rel = relativize(String(t).replace(/^['"]+|['"]+$/g, ""));
    if (rel !== null) out.add(rel);
  };
  // redirection: >file  >>file  2>file  &>file
  for (const m of cmd.matchAll(/(?:^|[\s;&|])\d*&?>>?\s*([^\s;&|<>]+)/g)) add(m[1]);
  // tee [-a] file...
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+|--append\s+)*([^\s;&|<>]+)/g)) add(m[1]);
  // sed -i / perl -i  (last non-flag token)
  for (const m of cmd.matchAll(/\b(?:sed|perl)\s+[^;&|]*?-i[^\s]*\s+([^;&|]+)/g)) {
    const toks = m[1].trim().split(/\s+/).filter((t) => !t.startsWith("-"));
    if (toks.length) add(toks[toks.length - 1]);
  }
  // dd of=file
  for (const m of cmd.matchAll(/\bdd\s+[^;&|]*\bof=([^\s;&|]+)/g)) add(m[1]);
  // cp / mv / install / rsync — destination is the last argument
  for (const m of cmd.matchAll(/\b(?:cp|mv|install|rsync)\s+([^;&|]+)/g)) {
    const toks = m[1].trim().split(/\s+/).filter((t) => !t.startsWith("-"));
    if (toks.length > 1) add(toks[toks.length - 1]);
  }
  // truncate -s N file
  for (const m of cmd.matchAll(/\btruncate\s+[^;&|]*?\s([^\s;&|-][^\s;&|]*)\s*$/gm)) add(m[1]);
  return [...out];
}

/**
 * The write rule set, applied to one already-relativized path. Returns a decision
 * to short-circuit on, or null to continue. Factored out so the Bash branch and the
 * file-tool branch cannot drift — the drift between them was the original defect.
 */
/**
 * The mission's declared scope, with any entry that would sweep a policy-critical
 * path removed. `allowWrite: ["**"]` therefore grants everything EXCEPT the files
 * that decide enforcement — which is what makes the protected floor a floor.
 */
function declaredScope() {
  const raw = (mission && mission.scope && mission.scope.allowWrite) || [];
  return raw.filter((pattern) => !POLICY_CRITICAL.some((crit) => matchesAny(crit, [pattern])));
}

function checkWriteTarget(rel, context) {
  if (matchesAny(rel, acceptancePaths) && role !== "atlas-acceptance-engineer") {
    return decide("deny", "acceptance-tests-immutable",
      `${rel} is an acceptance test and this command writes it. Only atlas-acceptance-engineer may write these.\n` +
      `If the criterion is wrong, that is a mission amendment for Mission Control — not a test edit.`, context);
  }
  if (matchesAny(rel, alwaysWritable)) return null;
  const declared = declaredScope();
  if (enforceScope && mission && declared.length > 0 && !matchesAny(rel, declared)) {
    return decide("deny", "outside-mission-scope",
      `${rel} is written by this command and is outside the declared file scope of mission "${activeMissionId}".\n` +
      `Declared: ${declared.join(", ")}\n` +
      `Report this as a blocker rather than widening scope yourself.`, context);
  }
  return null;
}

try {
  // Surfaced here rather than at read time so the fail polarity applies to it.
  if (policyError) throw policyError;

  /* ---- 1. Shell effects: publication, history, infra, destruction ------- */
  if (toolName === "Bash" || toolName === "BashOutput") {
    const cmd = String(input.command || "");
    // `g=git; $g push` — a variable holding a forbidden binary's name, invoked
    // through it. Check both the literal command and this one-hop resolution so
    // the existing regexes see the effective command, not just the written one.
    const cmdResolved = resolveSimpleVarIndirection(cmd);
    // Push is analysed by a quote-aware tokeniser (deny-by-default), not the regex list.
    for (const c of [cmd, cmdResolved]) {
      const pv = gitPushDecision(c, context);
      if (pv) return pv;
    }
    // Neutralise quoted argument VALUES (keeping empty quotes as a token boundary) so a
    // global option carrying spaces — e.g. `git -c x='a b' push` — cannot push the
    // forbidden verb out of reach of the flag-skipping regexes. Detection only; this
    // never grants anything, it only makes the existing denials harder to evade.
    const stripQuoted = (s) => s.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    // Tokens-rejoined variant: tokenization strips quotes, so a quote-split verb
    // (`git reb"ase"`) or binary (`g"it" push`) reads as its real word here. Over-denial
    // (a rule word appearing in quoted prose) is the safe direction for this list.
    const rejoin = (s) => tokenizeShell(s).join(" ");
    // deBackslash: the shell drops an unquoted `\`, so `--am\end` runs as `--amend`.
    // Include a backslash-stripped variant so that trick can't slip any rule below.
    const deBackslash = (s) => String(s).replace(/\\/g, "");
    const variants = [cmd, cmdResolved, stripQuoted(cmd), stripQuoted(cmdResolved), rejoin(cmd), rejoin(cmdResolved), deBackslash(cmd), deBackslash(rejoin(cmd))];
    for (const { re, why } of FORBIDDEN_COMMANDS) {
      if (variants.some((v) => re.test(v))) {
        return decide("deny", "forbidden-effect", `${why}\nCommand: ${cmd.slice(0, 400)}`, context);
      }
    }
    /* The path rules below used to be unreachable from Bash: this branch returned
       `allow` before the file-target block, so every secret and protected path was
       writable and readable through the shell. `cat .env`, `echo x > .atlas/project.json`
       and `echo x > tests/acceptance/a.test.js` all exited 0.

       The guard cannot parse shell — variables, command substitution, quoting and
       `eval` make the touched-file set undecidable, and the agent controls the shape.
       So it does not try to extract targets. Two layers instead, both conservative:

         (a) any token anywhere in the command that resolves to a secret or protected
             path denies the command outright, regardless of what the command does
             with it. This over-denies (mentioning `.env` in an echo is refused) and
             that is the correct failure direction — the file tools are precisely
             checked and are the right channel for these paths.
         (b) unambiguous write forms — redirection, tee, sed -i, cp/mv destination,
             dd of= — additionally carry the full write rule set including mission
             scope, because for those the target is not in doubt.

       Mission scope is deliberately NOT applied to layer (a): doing so would deny
       `cat src/x.js` and `node --test`, and a guard that blocks reading is a guard
       that gets disabled. */
    // Glob characters are kept (not stripped) so a pattern like `.en*` survives as
    // one token instead of being silently truncated to `.en` — see expandGlobToken.
    const mentioned = new Set([
      ...(cmd.match(/[-A-Za-z0-9._~/@+*?[\]]{2,}/g) || []),
      ...(cmdResolved.match(/[-A-Za-z0-9._~/@+*?[\]]{2,}/g) || []),
    ]);
    for (const raw of mentioned) {
      const quoteStripped = raw.replace(/^['"]+|['"]+$/g, "");
      for (const cleaned of expandGlobToken(quoteStripped)) {
        const rel = relativize(cleaned);
        if (rel === null) {
          // Out-of-repository. relativize() returns null, and simply skipping was
          // still a bypass: `cat ~/.ssh/id_rsa` and `cat /etc/…` name no in-repo path.
          // Secrets are never legitimate through the shell, inside the tree or out.
          const probe = cleaned.replace(/^~\/+/, "").replace(/^\/+/, "");
          if (matchesAny(probe, secretPaths)) {
            return decide("deny", "bash-secret-path-external",
              `${cleaned} is a credential-bearing path outside the repository and this command names it. Atlas never reads or writes secrets.\nCommand: ${cmd.slice(0, 400)}`, context);
          }
          continue;
        }
        if (matchesAny(rel, secretPaths)) {
          return decide("deny", "bash-secret-path",
            `${rel} is a credential-bearing path and this command names it. Atlas never reads or writes secrets, through any tool.\nCommand: ${cmd.slice(0, 400)}`, context);
        }
        const declaredForBash = declaredScope();
        if (matchesAny(rel, protectedPaths) && !matchesAny(rel, declaredForBash)) {
          return decide("deny", "bash-protected-path",
            `${rel} is a protected path and this command names it. Shell access is denied because the guard cannot verify what a shell command does to a file.\n` +
            (activeMissionId
              ? `Mission "${activeMissionId}" does not declare it in scope.allowWrite.`
              : `No active mission declares it.`) +
            `\nUse Edit/Write, which are checked per path, or escalate to the owner.\nCommand: ${cmd.slice(0, 400)}`, context);
        }
      }
    }

    for (const rel of new Set([...bashWriteTargets(cmd), ...bashWriteTargets(cmdResolved)])) {
      const verdict = checkWriteTarget(rel, context);
      if (verdict) return verdict;
    }

    return decide("allow", "bash-ok", cmd.slice(0, 200), context);
  }

  /* ---- 2. File targets -------------------------------------------------- */
  const rawTarget = input.file_path || input.path || input.notebook_path || input.filePath;
  if (!rawTarget) return decide("allow", "no-path-target", toolName, context);

  const rel = relativize(rawTarget);
  if (rel === null) {
    // Plan-mode/todo scratch under ~/.claude/plans|todos is the harness's own bookkeeping,
    // not repo content — allow it so plan mode works in an Atlas repo. Everything else
    // outside the repository (including the rest of ~/.claude/) stays denied.
    if (isHarnessScratch(rawTarget)) {
      return decide("allow", "harness-scratch", rawTarget, context);
    }
    return decide("deny", "outside-repository", `Path resolves outside the repository: ${rawTarget}`, context);
  }

  // 2a. Secrets — denied for read AND write, regardless of mission scope.
  if (matchesAny(rel, secretPaths)) {
    return decide("deny", "secret-path", `${rel} is a credential-bearing path. Atlas never reads or writes secrets.`, context);
  }

  if (!WRITE_TOOLS.has(toolName)) {
    return decide("allow", READ_TOOLS.has(toolName) ? "read-ok" : "non-write-ok", rel, context);
  }

  // 2b. Acceptance tests are writable only by the Acceptance Engineer.
  //     This is the rule that stops an implementer editing the test until it passes.
  if (matchesAny(rel, acceptancePaths)) {
    if (role !== "atlas-acceptance-engineer") {
      return decide(
        "deny",
        "acceptance-tests-immutable",
        `${rel} is an acceptance test. Only atlas-acceptance-engineer may write these.\n` +
          `If the criterion itself is wrong, that is a mission amendment for Mission Control — not a test edit.`,
        context,
      );
    }
    // Acceptance paths are implicitly in scope for their owner, so the mission
    // does not have to re-declare them (and an implementer cannot reach them).
    return decide("allow", "acceptance-author-ok", rel, context);
  }

  // 2b-ii. Agent-writable Atlas surfaces.
  //
  // Agents may DRAFT into .atlas/proposals/ and append evidence, but they may
  // never write .atlas/project.json or .atlas/missions/. A mission declares its
  // own scope.allowWrite, so an agent able to author a live mission could widen
  // its own authority — the escalation this carve-out exists to prevent.
  // Promotion from proposal to live mission is a human CLI step:
  //   node <plugin>/scripts/atlas-promote.mjs <proposal-id>
  if (matchesAny(rel, alwaysWritable)) {
    return decide("allow", "atlas-draft-surface", rel, context);
  }

  // 2c. Protected infrastructure paths require explicit mission scope.
  const declared = declaredScope();
  if (matchesAny(rel, POLICY_CRITICAL)) {
    return decide(
      "deny",
      "policy-critical-path",
      `${rel} decides what Atlas enforces. No mission may declare it in scope.allowWrite — ` +
        `a role able to write it could widen its own authority for every future session.\n` +
        `This is an owner action, outside any mission.`,
      context,
    );
  }
  if (matchesAny(rel, protectedPaths) && !matchesAny(rel, declared)) {
    return decide(
      "deny",
      "protected-path",
      `${rel} is protected infrastructure (manifest, lockfile, CI, migration, devcontainer or Atlas config).\n` +
        (activeMissionId
          ? `The active mission "${activeMissionId}" does not declare it in scope.allowWrite.`
          : `No active mission declares it.`) +
        `\nChanging this file changes what Atlas itself enforces or executes, so it needs a human.`,
      context,
    );
  }

  // 2d. Mission file scope. Only enforced when a mission is active and declares one.
  if (enforceScope && mission && declared.length > 0 && !matchesAny(rel, declared)) {
    return decide(
      "deny",
      "outside-mission-scope",
      `${rel} is outside the declared file scope of mission "${activeMissionId}".\n` +
        `Declared: ${declared.join(", ")}\n` +
        `Narrow missions are the point. Report this as a blocker rather than widening scope yourself.`,
      context,
    );
  }

  return decide("allow", "write-ok", rel, context);
} catch (error) {
  if (FAIL_OPEN) {
    try {
      process.stderr.write(`ATLAS POLICY: guard error (allowing): ${error.message}\n`);
    } catch {}
    process.exit(0);
  }
  process.stderr.write(`ATLAS POLICY: guard error (denying): ${error.message}\n`);
  process.exit(2);
}
}

main();
