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
- **Business first, software second.** The Hub always represents the *business* first and the
  software second. When the business view and the platform view compete, optimize for helping
  the operator understand the business — not the internal mechanics of the platform. (A
  business can be healthy though an AI task failed; every AI task can succeed while the
  business drifts. Health is a business judgment, not a platform status.)

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

**"Operating normally" — evaluated in layers, business first.** Health is a *business*
judgment, not a platform status. The layers guide the design (they need not be shown as
explicit sections), and they lead in this order:

1. **Business health** — Are objectives progressing? Is work moving forward? Is anything
   *materially* stalled? *(Leads. This is what "is my business okay?" actually means.)*
2. **Operational health** — Am I waiting on decisions? Is any work blocked? Are approvals
   backing up?
3. **System health** — Are AI tasks completing? Are integrations functioning? Is spend within
   expected limits?

"Everything operating normally" is only honest when the business layer is genuinely moving —
not merely when the machinery is error-free. Any layer with a real problem becomes an
attention item, shown with its "why" (responsibility ④).

**Open design questions (for the sketch, step 5):**
- Defining "materially stalled" / "work moving forward" honestly, without crying wolf — the
  business-health signals are the most valuable *and* the least trivial to compute.
- Whether we can truthfully report "integrations functioning" (may need a health probe we
  don't yet have) — don't claim a green we can't verify.
- How much ambient orientation (working-now, team roster, recent work) stays on-screen vs.
  subordinated vs. left to its own pages.
- Mechanism for "what changed since I last looked."
