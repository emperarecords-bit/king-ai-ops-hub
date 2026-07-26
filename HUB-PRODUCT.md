# Hub Product Definition — North Star

Working definitions we design each area against. **Not a backlog** — the agreed *purpose*
of each screen, settled before any layout or code. Method, per area:
describe what exists → what works → what feels incomplete → **agree the goals** →
sketch & evaluate against the goals → only then build.

## Hub-wide principles

- **Every screen answers one primary question.** Anything on the screen should help answer
  it; if it doesn't, question why it's there.
- **Every screen rewards opening it.** A short visit should make the operator more
  capable — orientation, confidence, and a clear sense of whether to act — without
  overwhelming and without turning into analytics.
- **Orientation over analysis.** The Hub orients (situational awareness + *what changed that
  matters since you last looked*). It is not a reporting/analytics system — no trends, no
  charts.
- **Signals must be trustworthy.** An alert always means something real; a quiet/green state
  means things are genuinely fine. No crying wolf.

## Dashboard  — *agreed 2026-07-26*

**Primary question:** "How is my business doing, and where do I need to act?"

Stepping into the operator's seat — not opening a to-do list. Attention is an *outcome* of
orientation, not the purpose.

**Responsibilities, in order:**
1. Orient me to the business I'm operating (identity).
2. Give me confidence in its current state (a trustworthy "healthy / operating normally").
3. Highlight anything requiring my attention (decisions, blocked work, real risk, budget).
4. Provide enough context that I understand *why*.

**Reward-opening test:** in ~30 seconds I know — which business I'm in, whether it's
healthy, what changed that matters, and whether I need to do anything before my day. If the
answer is "nothing," it feels reassuring, not empty.

**Design intents:**
- Whole business represented: human Work Items *and* AI Tasks, not only AI activity.
- Calm on a quiet day: "everything operating normally" is a confident state, not a void.
- Explicitly out of scope: trends, charts, reporting.

**"Healthy / operating normally" rubric (proposed — confirming):** the workspace is healthy
when *all* are true — nothing awaiting your decision · no blocked/failed work · no objective
genuinely stalled (fixed at-risk logic) · spend within budget · recent AI runs completed
without error. Any one false → that becomes the attention item, shown with its "why."

**Open design questions (for the sketch, step 5):**
- How much ambient orientation (working-now, objective list, team roster, recent work) stays
  on-screen vs. subordinated beneath the health/attention layer vs. left to its own pages.
- Mechanism for "what changed since I last looked."
