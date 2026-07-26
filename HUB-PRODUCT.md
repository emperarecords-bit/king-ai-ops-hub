# Hub Product Definition — North Star

Working definitions we design each area against. **Not a backlog** — the agreed *purpose*
of each screen, settled before any layout or code.

**Design sequence, per area (do not skip ahead):**
1. Understand the experience.
2. Agree on the personality.
3. Define the purpose.
4. Design the interaction.
5. *Only then* worry about how the Hub computes the result.

The algorithms behind a screen (e.g. the health verdict) live in step 5 and will keep
evolving as we operate real businesses. The *experience* and the *personality* are settled
earlier and should not drift.

## The Hub's personality — the chief of staff

The Hub speaks as **one character across every screen**: a competent, accountable chief of
staff who has been running the business while you were away. This is the through-line for the
entire product. The test for any area is no longer only "would I proudly ship this?" but also
**"does this sound like the same chief of staff?"**

- **Accountable, not reporting.** It has been *minding the business*, not just tallying it. It
  owns the state of things and stands behind its read.
- **Confident and active, not passive.** Its stance is: *"Here's where we stand. Here's why.
  Here's what, if anything, needs you."*
- **Judgment, not just reporting — but not advice, yet.** It interprets raw information into
  what *matters*. Three levels:
  - **Observation** — *"three approvals are waiting."*
  - **Judgment** — *"one is blocking customer onboarding; the other two are administrative."*
  - **Advice** — *"clear the onboarding one first."*

  The finished Hub masters **Observation and Judgment**: it confidently tells you *what
  matters* (prioritizes, gives consequence, separates material from noise). It stays
  **cautious about telling you what you *ought to do*** — Advice is a higher responsibility,
  *earned* only once operating together produces repeated evidence that the Hub reads your
  priorities well (see *earn capability through evidence*). We will probably cross this line
  eventually; we have not earned it yet. Until then it never pretends to know your priorities
  better than you do. Judgment is *earned* too: offered only from signals the Hub can stand
  behind; where evidence is thin it says so rather than guessing. It never decides for you and
  is never paternalistic — its aim is to make you a better operator, not to run the company.
- **Human, not mechanical.** It greets you like an operating partner — "Good morning.
  AccurateBids is operating normally." — not like software emitting a status line.
- **Calm · honest · business-first · never noisy · never dramatic.**
- **Never pretends certainty it doesn't have.** When it can't verify something, it says so
  plainly ("I haven't been able to check X") rather than showing a green it can't stand
  behind. Honesty over false reassurance — that is what makes its confidence trustworthy.
- **Confidence is not certainty.** Confidence comes from speaking calmly and honestly;
  certainty comes from complete information. The chief of staff is useful *without* perfect
  information — "things look healthy overall, but I can't confidently assess customer momentum
  yet" is integrity, not weakness. It never confuses the two.
- **One voice, many executive lenses.** The chief of staff is where it starts, not where it
  ends. The Hub is an executive *team* in one consistent personality: it orients like a **Chief
  of Staff**, thinks like a **COO** (operations), reasons like a **CFO** (money), and challenges
  like a **CEO** (strategy) — same calm, honest, business-first character throughout. The
  personality is constant; the capability grows.

## Capability grows by earning trust

The personality is fixed; the *capability* climbs a ladder, and every rung is earned through
evidence in real operation — never granted because it seems clever. The Hub is not building
toward a reporting tool; it is building toward an executive operating system that assumes an
increasing share of the owner's responsibilities. It starts as a trusted advisor, earns the
right to become a trusted operator, and ultimately earns the right to become an autonomous
partner.

**The ladder:** Observe → Understand → Judge → Recommend → Act → Automate.
*(Compressed for a screen: Observe → Explain → Recommend → Automate.)*

- **Where we are now:** the Hub masters Observe / Understand / Judge, and **explains** its
  judgments. Recommend / Act / Automate are later rungs the architecture anticipates but has
  not yet earned.
- **The Hub earns the right to automate.** A behavior advances a rung only when the Hub has
  *repeatedly demonstrated good judgment* on that kind of decision in real operation. Evidence
  promotes a capability — never our confidence that it would be clever.

**Every opinion is explainable — and the explanation *teaches*, it does not justify.** The gate
is not "no opinions"; the Hub *should* have opinions. The gate is that every opinion carries its
reasoning. But the panel's job is not to defend the Hub against doubt — it is to **teach the
operator how the Hub thinks.** Done well, the operator eventually stops opening it, because
they've learned the pattern. The panel wins when it becomes unnecessary. Trust is built by
*consistently applying the same reasoning*, not by hiding complexity or re-proving itself each
time. Every explanation should leave the operator thinking "that makes sense."

**The reasoning contract (five dimensions).** Any judgment, recommendation, or autonomous action
must be able to answer:

1. **Why does this matter to the business?** — grounds everything in *outcomes, not mechanics*.
   "The onboarding objective stalled, delaying activation of new contractors," never just
   "stalled." Reinforces *business first, software second*.
2. What evidence led to this?
3. Why was this the best option — what alternatives were considered?
4. How confident are you?
5. What would have changed your decision (what assumptions is it resting on)?

If the Hub cannot answer these, it has not earned the right to *assert* the opinion — let alone
act on it. Explainability is the currency of trust and the gate at every rung of the ladder.

**Evidence is not inference — label the difference.** The Hub distinguishes what it can *prove*
from what it *concludes*. "Onboarding hasn't progressed while this objective has been stalled"
is evidence; "this objective is delaying activation" is a causal claim. When it can't prove
causation, it states the narrower truth or clearly labels the relationship as an inference —
never a conclusion dressed as fact. Business impact frequently lives right on this line: state
the correlation as fact, the consequence as a labeled inference.

**Sharper honesty in claims (refined via Objectives, applies Hub-wide):**
- **Confidence attaches to a specific claim, not the whole thing.** The Hub can be highly
  confident two criteria are met while barely confident the outcome finishes on time — it should
  say so. Assessment confidence is *metadata on a judgment*, never a property of the thing judged
  (an objective's *risk* and the Hub's *confidence* about it are orthogonal — different axes).
- **Every outcome claim keeps its evidence source.** "Met" is not one thing: verified by external
  data, human-confirmed, artifact-supported, Hub-inferred, or merely marked without evidence —
  not equivalent. The Hub knows and communicates the source of any load-bearing claim.
- **Absence of a recorded problem is not proof of no problem.** Bound negative/exhaustive claims
  to what the Hub can actually see: "no blockers *recorded*," "no open decisions *linked*" — not
  "nothing's blocked." Reassure without implying complete visibility. *(Retroactively tightens the
  Dashboard's "nothing needs a decision / nothing's blocked" copy — a small pending follow-up.)*
- **No forecast without a basis.** "On track / on time" is a forecast needing a defensible time
  model (target, trajectory, evidence cadence, dependencies, remaining distance, baseline). Absent
  it, the honest judgment is "advancing on evidence" — strong without overreaching. Same for
  "the natural next step, not a stuck one": if unsupported, label it an inference.
- **Narrow causes without inventing one.** Offer the plausible space ("misdirected, delayed by a
  dependency, or evidence not yet captured — worth examining"), never a false either/or that
  implies the cause is known.

**The reasoning contract is universal; its depth is not.** The five dimensions stay consistent
everywhere, so the operator learns *one* way the Hub thinks. The *presentation* adapts to
significance: a small prioritization judgment may be two sentences; a major recommendation
deserves the fuller model; an autonomous decision carries the full reasoning plus alternatives
considered, authority used, and an audit record. Consistency should help the operator recognize
how the Hub thinks — not force every thought into a heavy panel.

**Depth matches consequence.** The higher the impact, uncertainty, or autonomy of a judgment or
action, the more explanation the Hub owes. Small calls travel light; big or autonomous ones
carry their full reasoning. Build the reasoning surface once; let the depth it shows scale with
what's at stake.

**Future — the explanation becomes institutional memory (preserve space, do not build yet).** As
the Hub earns the right to automate, the explanation surface becomes the business's memory.
Today it answers *"why do you say this matters?"* Later: *"why did you make this decision?"*
Months on: *"why did we do it that way?"* At that point the reasoning behind every important
recommendation and autonomous action is organizational knowledge — where explainable judgment,
Decision Memory, and Knowledge converge. Not today. But designing the reasoning model well now
means we won't have to reinvent it then.

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
- **Earns trust before it asks for attention.** The emotional sequence on every screen: tell
  me where we stand → prove that assessment → *only then* ask for my attention. Begin by
  creating confidence, not by demanding attention.
- **Curate attention — help me understand what matters most.** The Hub doesn't just tell me
  what's happening; it reduces cognitive load by interpreting — prioritizing, giving
  consequence, separating what's material from what's noise. Curation, not decision-making, and
  not advice: it tells me *what matters*, not *what to do*. This is likely the difference
  between software I check and a partner I rely on.
- **The finished-screen test.** *"After using this page, do I feel more in control than before
  I opened it?"* If yes, it's done. If no, no amount of visual polish will fix it. This is the
  working definition of a finished Hub.
- **Every page leaves me better prepared to run my business than before I opened it.** Every
  interaction reduces uncertainty — sometimes by giving confidence, sometimes clarity, sometimes
  direction, sometimes helping a decision. This is what the Hub ultimately sells: not dashboards,
  not AI, not automation — *confidence in operating a business.*
- **One partner everywhere.** The personality is part of the product, not just the Dashboard.
  Every area — Objectives, Work, Decisions, Knowledge, Settings — sounds like the *same*
  accountable operating partner. The operator should never feel they're switching between apps;
  they're always working with one mind.
- **Earn a place with the 30-second test; don't over-protect whitespace.** A clean sketch is not
  a reason to refuse genuinely useful information. Ask only: *does this help me become a better
  operator in the first 30 seconds?* If yes, it earns its place; if not, it belongs on another
  page.
- **Places, not actions.** Navigation is for *places*; actions live *within* the place they act
  on. A verb never sits in the nav among the nouns. (Likely resolves dozens of future design
  questions on its own.)
- **Objectives measure movement toward outcomes, not the volume of work performed.** Effort
  belongs to Execution; meaning belongs to Direction. The Hub never calls activity "progress"
  unless it can explain how that activity changed the outcome.
- **Navigation reflects the enduring domains of operating a workspace, not the architecture of
  the software.** Group by the operator's cycle — set direction → move execution → capture what's
  learned, enabled by resources and kept honest by governance — not by software-object type. And
  by *enduring domains of a workspace*, not a particular business or today's implementation: the
  Hub will operate many workspaces, so the model must outlast any one of them. You don't wake up
  thinking "I'll go to Objectives"; you think "what are we trying to achieve, what needs to
  happen, what do we know." The structure reinforces that rhythm every day.
- **Business first, software second.** The Hub always represents the *business* first and the
  software second. When the business view and the platform view compete, optimize for helping
  the operator understand the business — not the internal mechanics of the platform. (A
  business can be healthy though an AI task failed; every AI task can succeed while the
  business drifts. Health is a business judgment, not a platform status.)
- **Information reveals itself in layers.** A glance conveys the state; a second glance
  explains why; detail is a deliberate drill-down. A screen *invites* you down to the pages
  beneath it — it never competes with them or duplicates them.
- **Design the experience, not the interface.** Decide what the operator should *feel* and
  understand first; the layout follows from that. Screens hold a conversation with the
  operator — they don't just display data.

## Dashboard  — *agreed 2026-07-26*

**Primary question:** "How is my business doing, and where do I need to act?"

Stepping into the operator's seat — not opening a to-do list. Attention is an *outcome* of
orientation, not the purpose.

**Trajectory.** The Dashboard is the *first visible expression* of an operating partner, not a
final state. Today it operates at **Observe → Judge → Explain**: it tells you what matters and
can show its reasoning on demand (the five-question reasoning model above). As the Hub earns trust through real
operation, that same explainable judgment evolves into recommendations and, eventually,
autonomous action — same personality, more responsibility. Design for that trajectory, not a
dead end.

**Responsibilities, in order:**
1. Orient me to the business I'm operating (identity).
2. Give me confidence in its current state (a trustworthy "healthy / operating normally").
3. Highlight anything requiring my attention (decisions, blocked work, real risk, budget).
4. Provide enough context that I understand *why*.

**Reward-opening test:** in ~30 seconds I know — which business I'm in, whether it's
healthy, what changed that matters, and whether I need to do anything before my day. If the
answer is "nothing," it feels reassuring, not empty.

**The morning conversation (experience definition).** The Dashboard is the chief of staff
greeting you at the start of the day. The 30-second arc, which obeys *earn-trust-before-
attention*:
- **0–3s — where we stand.** A human greeting + a one-sentence verdict of the business's
  health. *"Good morning. AccurateBids is operating normally."* or *"Good morning. AccurateBids
  is healthy overall, but two things need your attention."* Identity + confidence, before any
  detail.
- **3–10s — why.** The proof behind the verdict, business-first: objectives advancing, work
  moving, nothing stalled.
- **10–20s — what needs you (or that nothing does).** Attention items with their *why* and a
  way in; when nothing needs you, it *affirms* that ("You're clear") — reassurance is content,
  not empty space.
- **20–30s — what changed since you last looked.** A short re-entry digest (orientation, not
  analytics).
- **Fades:** run counts, "working now," roster, cost detail, history — software talks second.

Answers to the five experience questions: **first thing seen** = business name + one-line
verdict · **reassures** = a green verdict backed by real business movement · **concerns** =
only genuine problems, business-first, each with its why · **invites action** = each item is a
doorway into the page that handles it · **fades** = the machinery.

**Design intents:**
- Whole business represented: human Work Items *and* AI Tasks, not only AI activity.
- Calm on a quiet day: "everything operating normally" is a confident state, not a void.
- Front door, not a destination: it orients and points *into* the work (Objectives, Work,
  Decisions, Knowledge). If the operator sits here ten minutes, we designed it wrong.
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

## Navigation  — *purpose agreed 2026-07-26*

**Primary question:** "Where am I, and where should I go to operate this business?" And beneath
it: **navigation maintains the operator's mental model of the business.** It should answer *"where
does this belong? / which section? / operational work or administration?"* before the operator
has to ask.

**Responsibilities:**
1. **Orientation.** I always know which business I'm operating, which part of it I'm in, and
   whether I'm in a workspace or the portfolio. I never feel lost.
2. **Mental model.** The structure itself teaches how the Hub thinks about running a business. I
   shouldn't memorize fourteen destinations — I should understand the *categories* they belong
   to. *The categories are the product;* they must come from how an operator thinks about running
   a business, not from how the software is built (business first).
3. **Flow.** It supports the natural rhythm of operating — the paths I take most often feel
   encouraged, not equal to everything else. **Reconciled with Stability via fixed emphasis, not
   adaptive reordering:** the operating paths are permanently weighted higher; the nav never
   rearranges itself per usage (that would destroy the muscle memory Stability needs).
4. **Stability.** It becomes invisible. After a few weeks my hand knows where to go because the
   structure consistently reflects how I think. Consistency over cleverness.
5. **Identity.** Every element reinforces that I'm *operating this business* — running
   AccurateBids, running the next company — not "using an application." Carry the business's real
   name, never a slug.

**Personality (structural).** The same operating partner, expressed as structure: a calm,
well-run office where everything has an obvious place — not a busy directory. Business-first
(categories and names reflect the business), confident (a clear map, not a wall of equal
options), never noisy. Navigation teaches the *organizational* model the way the explanation
surface teaches the *reasoning* model — one mind, expressed in how the office is arranged.

**Defining principle — navigation reduces decisions, it does not create them.** Every flat list,
every moment of scanning, is a small cognitive cost. Good navigation removes those costs: I
shouldn't *decide* where to go — the right destination should feel obvious.

**The rail is the workspace's table of contents, not a link list.** At a glance it should say
"this workspace has direction, execution, knowledge, [capability], and governance" — valuable
*even when you aren't navigating anywhere.* Navigation is almost a side effect; the standing job
is to reinforce the mental model continuously. This is why the persistent side rail (not a top
bar) is correct: a top bar optimizes for compactness, a rail optimizes for *understanding*, and
the Hub optimizes for understanding. Keep the domain labels — like folders in a filing cabinet,
you stop consciously reading them but never stop benefiting from the structure they create.

**6th responsibility — navigation makes the workspace feel finite, and governs tomorrow's Hub.**
As the Hub grows, every new capability must ask "which domain do I belong to?" If it doesn't
clearly belong to one, that's a signal we've invented the wrong feature *or* the wrong mental
model. Navigation isn't only organizing today's Hub — it's the constraint that keeps tomorrow's
Hub from collapsing under a pile of new top-level destinations. That may be its most valuable
role.

**Domain naming — labeled "Team."** The operator-facing label is **Team**: human, immediately
understood, broad enough to cover people, providers, and future AI agents without translation.
Operator language over taxonomic precision — the underlying domain is broader than "people," but
the interface says Team unless real use exposes a problem. ("Capability" was tried and rejected —
abstract, enterprise-architecture-sounding, not an operating partner's voice. "Governance" stays:
stewardship, not administration.)

**Location is model-driven (a routing model, not per-page).** A single nav model (`nav-model.ts`)
maps every route to its domain. The rail highlights the parent domain even for routes that aren't
rail destinations — a task page lights **Execution** — and a breadcrumb shows "Domain › Section"
(a task reads "Execution › AI work"). Solved once for all nested/detail routes — never patched
page by page. **Rail = which room; breadcrumb = the exact record inside it.** The breadcrumb's
*structural* part comes from the model; its *dynamic leaf* — the actual record (task title,
objective title) — is supplied by the detail page from its loaded entity, never a raw id or route
param. Detail pages carry the full "Domain › Section › Record"; list/section pages rely on the
rail's active state and their own title (the room *is* the location). **Rule:** a breadcrumb
appears only when the user has moved *deeper* than the permanent nav structure (a specific
record) and restores context the rail and title can't provide alone — never merely because the
component exists. Applies to all future detail and nested-workflow pages.

*Navigation accepted 2026-07-26 (pending authenticated visual check). Area closed for this pass.*

## Objectives  — *purpose agreed 2026-07-26* (Direction domain)

**Primary question:** "What are we trying to accomplish, **how will we know**, and **is it
actually moving?**"

**Purpose.** Objectives is the workspace's *direction-and-accountability* system — it connects
**intent to evidence.** It does not manage the work (Execution owns that); it shows *why* work
exists and *whether it is producing the intended result.* The relationship:
**Direction defines the outcome · Execution performs the work · Objectives judge whether the work
is changing the outcome.**

**What is genuinely strong and must be preserved:** the success contract — criteria must be
defined, completion cannot be declared while criteria are unmet, changes to the definition are
audited, and closed objectives can't be quietly rewritten. That is the foundation.

**Responsibilities:**
1. **Establish direction.** Make active priorities explicit: what matters now, why, who's
   accountable, primary vs secondary, and what's no longer pursued. An intentional commitment,
   not a labeled container for tasks.
2. **Define success.** Criteria + the completion gate are the authoritative definition. Preserve:
   *an objective cannot be completed by activity alone.* Milestones, tasks, and Work Items may
   explain the path but must never silently redefine the destination.
3. **Judge meaningful progress** — keep *five* concepts separate, never compressed into one
   number/score/color/label: **lifecycle** (formal state: draft/active/completed/cancelled) ·
   **outcome progress** (what the success evidence establishes) · **momentum** (whether meaningful
   *outcome* movement is occurring) · **risk** (what threatens achieving the outcome) ·
   **assessment confidence** (how strongly the Hub can stand behind each judgment — *metadata on
   the judgment*, orthogonal to risk). A new objective can have low outcome progress but healthy
   momentum; an objective can have many completed tasks and no outcome movement; it can meet
   criteria while getting riskier as a dependency stalls; and the Hub can be highly confident
   about one of these while unable to assess another.
4. **Connect work to purpose.** Both human Work Items *and* AI tasks are execution and both must
   be visible (AI work counting while human work is invisible is a defect). But visibility ≠
   success: explain what work is contributing, what changed because of it, what remains, and
   whether the work appears *sufficient to advance the outcome.*
5. **Preserve accountability and integrity.** Make visible: ownership, who changed criteria and
   why, what evidence supports a progress claim, which conclusions are observed vs inferred, and
   why an objective was completed or cancelled. These are consequential acts — they leave an
   institutional record.

**Progress is evidence-first (semantic contract, not an algorithm yet).** The current single %
is incoherent — it means task-completion when tasks exist and criteria-satisfaction when they
don't, so one visual represents two different concepts. It does not survive merely because it
exists. Before *any* headline progress signal, the Hub must answer *"what exactly does this number
claim?"* Assessment begins with **evidence of the intended outcome** (criteria, measured results,
completed milestones, verified artifacts, dependency-resolving decisions, human confirmation,
external data). Tasks and Work Items are evidence of *effort*; they become evidence of *progress*
only when connected to a real change in the outcome. **The contract: the Hub never calls activity
progress unless it can explain how the activity changed the outcome.** *(Do not design the scoring
algorithm yet — establish the contract first.)*

**Milestones / Decisions / Artifacts.** Milestones are checkpoints in the path, not automatic
fractions of success. (Criteria describe success · milestones describe expected stages · work
describes activity · evidence describes what changed · judgment interprets whether it's
advancing.) Decisions and artifacts attach to an objective only when *meaningful* — they explain
why it changed, what evidence supports progress, what dependency resolved, what was learned, or
the basis of the Hub's judgment — never a foreign key added for completeness.

**The experience — a disciplined executive review.** Not "63% complete," but capable of: *"active
and work is continuing, but there's no evidence yet that contractor activation has improved"*;
*"two of three conditions are met; the last depends on onboarding, which hasn't changed in eight
days"*; or *"not enough current evidence to assess meaningful progress confidently."* The same
operating partner as the Dashboard — calm, honest, outcome-focused, evidence-aware, willing to
say it doesn't know, and unimpressed by activity that hasn't produced a result.

**Reuses what we've already built (not a new mechanism):** "is it moving?" is a chief-of-staff
judgment carrying the **five-dimension reasoning contract** (business impact / evidence /
reasoning / confidence / what-would-change) and the **observed-vs-inference** labeling — the same
explanation surface, applied to one outcome. The four concepts above mirror the Dashboard's
layered health, for one consistent mind across the product. Honest consequence: with today's
signals, **momentum and risk will often be "not enough evidence to assess" — that is correct
behavior, not a gap to paper over** (confidence is not certainty). Establish the contract; let the
measurement earn its way in from real operation.

**The accepted conversation model.** Across every state the partner communicates: (1) the outcome
pursued, (2) the success contract, (3) evidence available now, (4) what that evidence establishes,
(5) whether meaningful movement is visible, (6) what risk is present, (7) how confident it is in
each conclusion, (8) what evidence or event would change the assessment, (9) what — if anything —
needs the operator. Durable vocabulary: *"I can confirm effort, not outcome progress." · "The
objective is advancing on evidence." · "There isn't enough current evidence to assess momentum
confidently."*

**Evidence, not maintenance.** Manual confirmation of a criterion is *one* evidence source, not
the Hub's measurement system. Over time the Hub gathers outcome evidence from work, artifacts,
decisions, integrations, and business systems (the capability ladder, applied to evidence). The
operator maintaining the Hub so it *looks* intelligent is not the product. When evidence is
missing, say what's missing and offer confirmation as one option — never demand it as the answer.

**No fixed age thresholds.** "Too early to judge" depends on the objective's expected evidence
cadence, not a universal number of days (two days is long for incident response, nothing for a
quarterly goal). Until cadence is modeled, speak to evidence sufficiency ("not enough history or
outcome evidence to assess momentum yet"), never a hard-coded age.

**Reference conversations, not screen copy.** The narratives reveal the full reasoning; the
interface presents it in layers — a concise portfolio verdict, one line per commitment, a deeper
explanation when warranted, the full reasoning contract when opened. Same mind; the surface
respects attention.

**Next:** the conversation is set and refined — now let the **list** and **detail** *structure*
emerge from it (layered as above). Still no cards, bars, filters, or percentages until the
structure follows the conversation.

**Mobile — scoped follow-up (desktop-first today).** When the persistent rail can't stay visible,
the mental model *and* the current-location signal must survive. Do **not** collapse into an
unstructured hamburger — that preserves access while destroying the table-of-contents function.

**The mental model — the operating cycle** *(locked 2026-07-26).* Navigation groups by the
*enduring domains of operating a workspace*, not by software objects — durable across whatever
business runs in the workspace.

Three roles, kept distinct: **the Dashboard orients · Navigation organizes · pages let you
operate.**

**Lobby — the Dashboard.** Sits *above* the operating model, not part of it: orientation,
business briefing, workspace state. You orient here, then enter the model.

The daily **cycle** (primary, emphasized):
- **Direction** — "where are we going?" → Objectives.
- **Execution** — "how do we make progress?" → Work, Approvals *(approvals unblock work)*.
- **Knowledge** — "what does this workspace remember?" → Knowledge, Decisions, Documents,
  Artifacts. *(A decision isn't an action — it's memory, and already feeds Decision Memory;
  artifacts are work outputs that become part of the body of knowledge.)*

The **supporting domains** (secondary — touched far less):
- **Team** *(operator-facing label; underlying domain is broader)* — "who and what help this
  workspace operate?" → Employees, Providers (and eventually AI agents, tools, integrations).
- **Governance** — "is this workspace trustworthy, accountable, and well run?" → Usage, Audit,
  Settings.

"New task" leaves navigation entirely (places, not actions). The workspace's real name replaces
the slug (identity). The cycle carries the emphasis (Flow); the structure never reorders itself
(Stability).

**Next:** design the navigation *experience* from this model, then evaluate it against the five
responsibilities (orientation, mental model, flow, stability, identity) before implementation.
