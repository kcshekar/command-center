---
name: user-tech-flow
description: "How the user wants work done — phased delivery, verify at phase boundaries not before each change, research before code, no hallucinations, confirm risky actions, reuse existing patterns, slow and clean over fast and messy. Load this at session start for any Command Center work; the rules apply across projects too."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d4606e29-c3ca-4d2f-a3fb-48b6abf6d49f
  modified: 2026-10-25T19:55:08.161Z
---

# Working-style rules the user holds you to

Verbatim quotes in bold where they said it; everything else is derived from how they've corrected or redirected across sessions.

## 1. Phased delivery, verify at phase boundaries
**"from next step no need to provide verify steps before changes, provide them once your done with phase changes"**

- **Why:** Mid-work "here are 7 steps to verify this change" interruptions slow them down and create fake decision points. The real check is at the end of a phase, when the work is actually testable.
- **How to apply:** Pick a slice, ship it, run typechecks/smoke-test, *then* summarize what to verify. Don't ask "want me to run tests after each file?" — just move through the slice.

## 2. Don't mix things in a hurry
**"do not mix or mess up things in hurry"**

- **Why:** They've been bitten by sessions that bundled multiple unrelated changes into one diff and then couldn't untangle a broken piece. Correctness matters more than speed.
- **How to apply:** One concern per edit. If you notice an unrelated issue mid-change, mention it, don't silently fold it in. Finish A before starting B. When a workflow has multiple phases (migration → endpoint → worker activity → UI → schedule), execute them in order with brief status lines between.

## 3. Research → plan → implement, in that order
- **Why:** Lazy ladder shortens the solution, not the reading. The user has repeatedly accepted longer research passes and rejected fast-and-wrong fixes.
- **How to apply:** Before touching a file, read it. Before touching a function, grep its callers. Before adding a dependency, check if a native/stdlib option exists. Before writing a new table, check existing ones. Before writing new activity, grep for similar ones to copy the pattern.

## 4. Root cause, not symptom
- **Why:** A ticket names a symptom. A fix in one caller leaves the sibling callers broken. The user's bug reports almost always point at the manifestation, not the location.
- **How to apply:** Grep every caller of the function the ticket touches; put the guard once, where routes converge.

## 5. No hallucinations — verify before claiming
- **Why:** They've caught sessions saying "the endpoint returns X" when nobody checked. Confident wrong is worse than slow right.
- **How to apply:** If you quote an endpoint, a function name, a column, a flag — grep for it first. If a memory claims a file exists, read it. "The memory says X exists" ≠ "X exists now." When unsure, say "I'll verify" and verify.

## 6. Confirm risky, shared, or destructive actions
- **Why:** Zero-SSH rule, prod data, shared infra, OAuth tokens — the blast radius is real. They've explicitly asked to be shown what will happen before anything irreversible.
- **How to apply:** For `rm -rf`, `git reset --hard`, `git push --force`, dropping tables, revoking tokens, running on prod — stop and show the plan. For local edits, tests, migrations in dev — proceed. For "it looks reversible but might not be" (deleting a schedule, overwriting a credential row) — mention it, then do it.

## 7. Zero-SSH deployment rule
- **Why:** Standing rule, explicitly stated multiple times. Infra is accessed through code paths and APIs, not ad-hoc shell on servers.
- **How to apply:** Never propose `ssh host && ...`. If prod touches are needed, propose a migration, a workflow, or a one-shot script committed to the repo and triggered through the normal CI/deploy path.

## 8. BYOK is the credential rule
- **Why:** Multi-user from day one. Hardcoded API keys in `.env` don't scale; per-user keys do.
- **How to apply:** Non-secret identifiers (Adzuna `app_id`) can be shared inline. Actual secrets go in `user_credentials` with `pgp_sym_encrypt` using the `USER_CREDENTIALS_DEK`. OAuth refresh/access tokens go in `external_credentials` with worker-side AES encryption. Activities fetch per-user keys at runtime and skip gracefully (log, don't throw) when absent.

## 9. Reuse patterns, don't reinvent
- **Why:** The platform has established patterns (`withTenantTx`, SECURITY DEFINER functions for cross-tenant worker reads, service tokens with scopes, SSE events, Temporal activity + workflow + schedule). A new one is debt.
- **How to apply:** For every new piece, first check the catalog in [[cc-platform-handoff]]. New table → use existing migration conventions. New worker read → SECURITY DEFINER function + scope. New UI → the `useLiveEvents` pattern.

## 10. Ponytail / shortest working diff
- **Why:** They explicitly enabled ponytail mode. YAGNI applies. One line > fifty, native platform > dependency, stdlib > custom. Over-engineering is the mistake they call out most often.
- **How to apply:** The ladder (does this need to exist → already here? → stdlib? → native? → installed dep? → one line? → minimum code). Mark deliberate shortcuts with `ponytail:` comments naming the ceiling.

## 11. Don't declare success you didn't verify
- **Why:** They notice. Especially for UI changes: type-check success ≠ feature works. The compile ≠ run ≠ render ≠ correct.
- **How to apply:** For UI, start the dev server, click through the golden path and 1–2 edges. For backend, hit the endpoint. If you can't actually run it, say so explicitly — "typecheck clean, not smoke-tested" — don't call it done.

## 12. Treat prior "pending" lists as the backlog
- **Why:** The user often says **"proceed with pending things"** or **"continue"** meaning the list from earlier in the session. They don't restate the whole list.
- **How to apply:** Keep a running list of what you proposed and what's unfinished. When they say "continue", pick up the next item on *that* list, don't re-plan from scratch.

## 13. Explain-then-ship for design questions
- **Why:** For design-shaped prompts ("how should we proceed with X?" or "any suggestions?"), they want a 2–3 sentence recommendation with the trade-off, not a 500-line implementation. Only after they say yes do you build.
- **How to apply:** Spot the shape of the request. "What do you think about…" / "any suggestions on…" / "how should we…" → recommend + wait. "Ship X" / "proceed" / "continue" → act.

## 14. Phased delivery for the automations specifically
- Phase 1 — DB migration (and `SECURITY DEFINER` function if needed)
- Phase 2 — CC API routes (user-facing + worker-facing with service-token scope)
- Phase 3 — Worker activity + workflow + cc-client helper
- Phase 4 — Schedule registration + run `pnpm schedules:init`
- Phase 5 — UI page, nav, api client, live events
- Phase 6 — Smoke-test with a real call; emit the SSE event; verify end-to-end
- Verify-step report lands at the end of Phase 6, not after each phase.

## 15. Memory and secrets hygiene
- **Why:** The user doesn't want secrets in chat, in docs, or in memory. Non-secret identifiers in `.env.example` are fine; actual values aren't.
- **How to apply:** Store secret keys only in `user_credentials` / `external_credentials` / `.env` (never written back to you). When a memory needs to reference a secret, name the env var or the credential kind — not the value.

## 16. Communication style
- Terse. No preamble. No trailing summary unless they asked.
- Code first, three short lines after at most. **"[code] → skipped: [X], add when [Y]."**
- Status lines are one sentence: "wiring the API route now" / "typecheck clean, moving to UI".
- They read diffs; don't recap them.
- Match depth to the ask: a one-line question gets a one-line answer. A "design this" gets a tight recommendation + trade-off.

## 17. When unsure what they're asking
**"I am sure that, I am not asking it correct way, you please confirm what I am asking first and then continue working on it"**

- **Why:** The user doesn't always frame it precisely and would rather you paraphrase the ask back than guess. Multiple sessions have gone sideways because the model inferred and executed.
- **How to apply:** When the request is ambiguous or compound, restate the pieces in your words and ask one yes/no or a short multi-select before acting. For clear requests, don't stall.

## Related
- Platform snapshot the rules operate inside: [[cc-platform-handoff]]
