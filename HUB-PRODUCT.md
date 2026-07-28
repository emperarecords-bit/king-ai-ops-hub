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

*Objectives accepted & closed 2026-07-26.* **Future integrity boundary (do not build now):** the
closure record is currently frozen by terminal immutability (criteria/state can't be edited after
close). **If** success conditions, evidence links, or external evidence ever become mutable after
closure, the closure record must retain a *versioned snapshot* of what the Hub relied on at
closure — criterion wording, criterion state, evidence references/immutable ids, provenance, the
assessment produced, and any caveat. Not an acceptance blocker; a boundary to honor when
post-closure data can change.

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

## Execution (Work)  — *purpose agreed 2026-07-26*

**Primary question:** "What work is **advancing this workspace**, **who is accountable** for it,
and **where does execution need intervention?**"

**Purpose.** Execution turns *direction into coordinated action.* It shows what humans and AI are
doing toward outcomes, how that work is moving, and where the operator must intervene.
**Direction defines what should change · Execution coordinates the work · Evidence determines
whether it changed.** Execution avoids two opposite errors: treating completed work as proof of
outcome progress, and hiding operational work merely because it hasn't yet produced outcome
evidence. **Objectives judges meaning; Execution manages movement.**

**One system, two engines.** Human Work Items and AI Tasks should feel like two forms of work in
*one* system — not one identical data model. Human work is flexible/editable/manually updated and
the Hub only *observes & coordinates* it; AI work has explicit execution states, cost, deps,
review/approval, autonomy, auditability, and the Hub *executes & governs* it. The differences are
legitimate. **The unifying layer is not identical mechanics — it is shared operator meaning.**

**Responsibilities:**
1. **Present one execution picture.** Entering Execution shows *all consequential work* — Work
   Items, AI Tasks, scheduled autonomous work, work awaiting approval, blocked, failed, recently
   completed — without the operator assembling it from Dashboard + objectives + approvals + task
   links. The Dashboard summarizes what needs attention; **Execution provides the complete picture.**
2. **Translate native states into common meaning.** Engines keep their internal lifecycles, but
   the operator gets shared conditions: **Planned · Moving · Waiting · Needs attention · Finished ·
   Stopped** (operator meanings, not DB statuses). An AI task `awaiting_approval` and a Work Item
   waiting on a customer are both *Waiting*. Preserve native detail; translate to a shared condition.
3. **Keep accountability and performance distinct — universally.** For any work: who is
   *accountable*, who/what *performs* it, who can *unblock/approve*, who to *contact* when it stops.
   (Human work: owner = performer often; AI work: usually not; delegated: provider performs, employee
   accountable.)
4. **Connect work to direction.** Show which objective work supports, whether its expected
   contribution is *stated / known / merely assumed*, and which work has no objective link. Classify
   **directional · operational · unclassified** — operational/incident/admin work is valid without
   advancing an objective. Never imply a task advances strategy just because it exists.
5. **Identify where intervention is needed** — legibly, without alarming every irregularity.
   Triggers: awaiting decision/approval, blocked, repeatedly failing, over budget, past an expected
   date, unowned, inactive-without-explanation, missing input, acting beyond authority, "active" by a
   human but no recent update. Distinguish **observed** ("failed twice, awaiting a retry decision")
   from **inferred** ("not updated in 9 days; may no longer be moving") — reasoning contract applies,
   depth ∝ consequence.
6. **Make autonomy visible and governable.** For autonomous work the operator can tell: what it's
   authorized to do, whether review is required, whether it can spend, budget/tier limits, whether it
   can create further work, what triggered it, what would stop/pause it, what happened in the run.
   Autonomy is operating state, not buried config.
7. **Preserve lifecycle integrity.** Every work type must expose enough lifecycle meaning to say
   whether it's planned/moving/waiting/finished/stopped. A free-text `stage` alone is insufficient.
   Durable shape: **a shared operational condition + optional native detail** (e.g. native stage
   "Legal review", shared condition "Waiting"). *(Final status model not designed yet.)*
8. **Distinguish work completion from outcome progress.** Execution confirms what was *done*
   ("the outreach sequence completed" / "Jordan finished the follow-ups"); Direction judges what
   *changed* ("no new qualified contractors, so the outcome hasn't advanced").
9. **Preserve a coherent history.** Creation, ownership changes, transitions, deps, approvals,
   failures/retries, cancel/complete, material edits, cost, outputs, objective/evidence links —
   enough that later one can answer "what happened, who was responsible, why did this end this way."
   (Human work needs understandable history, not an immutable AI-run record.)

**Not a task inventory.** The Work area must not just place AI Tasks beside Work Items in one
bigger table — that combines records without creating a system. It must first answer *what's
moving / waiting / needs intervention / recently finished / who's accountable / what purpose it
serves*, and only then expose each work type's mechanical detail.

**Durable principles:**
- Execution may have different engines, but it must speak **one operational language.**
- The Hub **preserves mechanical differences while translating them into common operational meaning.**
- **Every consequential piece of work needs an accountable owner**, even when someone — or something
  — else performs it.
- **Autonomy is a visible property of work, not an invisible implementation detail.**
- **Every work type must expose enough lifecycle meaning** to determine whether it is planned,
  moving, waiting, finished, or stopped.
- **Execution confirms what was done. Direction judges what changed because of it.**

**Boundaries.** Dashboard = *what most deserves my attention?* · Execution = *the complete state of
the work.* Objectives = *are outcomes advancing?* · Execution = *what is being done toward them.*
Approvals = a focused intervention queue *within* Execution (not the only place waiting AI work is
visible). Audit = exhaustive system history; Execution = the operationally relevant history.

**The translation model — three distinct layers** *(refined 2026-07-26).* "Needs attention" is not
a condition; it's the operator's *relationship* to a condition. Keep three separate things (the
same correction as objective risk vs. assessment confidence):
1. **Execution condition** — *what the work is doing*: **Planned · Moving · Waiting · Finished ·
   Stopped · Unknown** (Unknown = the record doesn't establish it). Stable and mutually
   understandable across both engines.
2. **Intervention state** — *what the operator must do*: **None · Watch · Needs attention · Needs
   decision.** An overlay on the condition, never a replacement (Moving+Watch; Waiting+None when
   legitimately scheduled; Finished+Needs-decision when output needs review).
3. **Native reason** — *why it's in that condition*: awaiting approval · blocked by dependency ·
   waiting for customer · scheduled · failed, holding for retry · paused by owner · budget limit ·
   no update recorded · cancelled as superseded. Translate the state without hiding the mechanics.

**Source + confidence on the translation.** The condition is itself a judgment for some work: an AI
task's is system-observed; human work may be human-reported, from a structured field, inferred from
stage text, inferred from inactivity, or Unknown. The result carries the condition, its **source**
(system-observed / human-reported / inferred), **confidence**, and the observed facts behind it.

**Semantic contract (governs language, not decorative chips):** Condition · Intervention · Native
reason · Accountable owner · Performer (when known) · Source · Confidence · Available actions.

**Human lifecycle gap — a BUILD PREREQUISITE, not a future enhancement.** The partner's honesty
("its stage doesn't tell me whether it's waiting or stuck") is fine in conversation but can't be the
*foundation* of a unified view — else the Hub just sets two record types side by side and apologizes
for one. Human Work Items need a **minimal structured condition** beside the flexible stage:
`condition` (planned|moving|waiting|finished|stopped) · `stage` (optional label) · `waitingOn` /
conditionReason (optional) · existing ownership + timestamps. So: *Condition: Waiting · Stage: Legal
review · Waiting on: outside counsel.* New principle: **flexible workflow labels may describe human
work, but they cannot replace the minimum lifecycle meaning the Hub needs to operate it.**

**Accountability vs performer — explicit, not overloaded.** Don't block the first view on it: for
human work treat the owner as performer *when none is separately recorded* — but model that as an
explicit assumption, not a claimed fact. The performer may later be the owner, another employee, a
provider, an AI agent, or a mixed group; never permanently overload the owner field to mean all of
them.

**Tightened claims (durable):**
- Bound negatives to visibility: "No recorded work is currently waiting on your decision, and no AI
  failures are open" — not "nothing's waiting and nothing has failed."
- A general update ≠ movement: "update its condition or record what it's waiting on."
- Dependencies gate *eligibility*, not motion: "becomes eligible to continue once the dependency
  finishes," unless auto-continuation is actually guaranteed by the engine/authority.
- **Suggested actions come from actual, enforceable capabilities** — "edit and retry," "detach," "it
  pauses before anything leaves," "can't create further work" appear only when stored and
  enforceable, generated from available actions, never generic prose.

**Durable vocabulary:** "Execution's part is honest: the work got done. Whether it moved the outcome
is Objectives' call." · "Different mechanics, one picture."

**Intervention level vs. required action** *(refined 2026-07-26).* Split intervention into two
fields so the model doesn't accumulate overlapping labels: **Intervention level** — None · Watch ·
Required; and, only when Required, **Required action** — approve/return · retry/cancel · assign an
owner · update the reported condition · resolve a dependency · adjust/pause autonomous work · supply
missing input. The language still reads naturally ("Needs your decision: approve or return the
draft"). Principle: **intervention says whether involvement is required; the available action says
what involvement means.**

**Confidence attaches to each claim, not the whole assessment.** A human Work Item can be *high*
confidence in what was last reported, *low* confidence it still reflects reality, and *limited*
confidence in the inference that intervention helps — keep **condition confidence** and
**intervention confidence** separate (the Hub-wide "confidence attaches to a specific claim").

**Owner is not assumed to be the performer.** For human work say "Sam is accountable; a separate
performer is not recorded" — never "performer assumed." Unknown is more honest than an implicit
identity between accountability and execution; a future performer field resolves it.

**Available actions need three checks** (capability alone isn't enough): an action appears only when
it is (1) supported by the work type, (2) valid in the work's current state, and (3) allowed for the
current operator under the work's authority/permissions. The partner never recommends an action the
user can't take from the present state.

**Structured human condition — smallest sufficient field (build prerequisite).** Add to Work Items:
`condition` (planned | moving | waiting | finished | stopped) beside the flexible `stage`, plus
optional `waitingOn`. *Condition: Waiting · Stage: Legal review · Waiting on: outside counsel.* The
condition enables coordination; the stage preserves the team's vocabulary. Never infer the
structured condition permanently from arbitrary stage text.

**The Execution assessment model (conceptual — governs language, not a wall of chips):** Condition ·
Native reason · Condition source & confidence · Intervention level · Intervention basis & confidence
· Required/available actions · Accountable owner · Performer (when known) · Objective/operational
purpose · Autonomy & cost (when applicable).

**Next:** semantics settled (no further philosophy cycle). The structured human condition is being
added; then the execution portfolio and individual-work structures emerge from this language.

**Execution build — increment 1 shipped (2026-07-26); increment 2 to do.** Built: the pure tested
translator (`domain/execution/assess.ts`), the unified feed (`listExecution`), and the unified
`/work` view — Requires-you lens (single canonical record), Active Execution by condition
(Moving/Waiting/Planned/Unknown), Recent (Finished/Stopped); AI Tasks now listed; work type
secondary; explicit Unknown. **Still to build (increment 2), all accepted, none blocking:**
1. **Structured closure records for stopped work** — persist who/when/why when a Work Item becomes
   Stopped, and an operator reason on AI cancellation (schema + capture UI). *Required build-test
   "stopped work retains its closure reason" is NOT yet satisfied for work items/tasks.*
2. **Schedule ⟂ instance** — represent ongoing automations (enabled/paused, next run, authority,
   budget/spend, recent run health) distinct from the task instances they produce; never
   double-counted. *(Schedules aren't shown in the view yet.)*
3. **Shared detail frame** — a Work Item detail page with the 9-point shared frame; reframe the AI
   task detail to match, then diverge into engine mechanics.
4. **Cross-surface reuse** — Dashboard "Recent work" and the objective "Work contributing" should
   read through the execution translator (required build-test #10), so the same work reads
   identically everywhere.

**Execution 2b closed (2026-07-26) — model-limit classifications (accepted, not blockers):**
- **Watch ≠ Requires-you.** Run-health degradation is a *Watch* shown in Ongoing Automations with
  elevated-but-non-demanding language; only `intervention: required` enters Requires-you. v1 has no
  signal that makes a schedule Required (no budget boundary, no decision gate), so v1 never returns
  Required for a schedule. Regression test added.
- **Per-schedule budget = future autonomy-governance capability.** Show attributable spend only;
  never describe it as "within/approaching a budget" unless a stored, enforceable limit exists.
- **Stopped schedule state = future.** Paused is the only disabled state today; don't say "Stopped"
  for schedules until a terminal transition distinct from pause exists.
- **Control-location usability follow-up:** valid schedule actions should eventually live on the
  canonical Ongoing-Automations record, not require knowing the control sits under an objective.

**Execution 2c — shared work detail frame (built 2026-07-26).**

The detail view answers ten questions as *one coherent operational read*, not ten permanent
fields. That read is the shared `WorkFrame` (`work-frame.tsx`), rendered identically atop both the
Work Item and the AI Task detail pages, then the engine-specific mechanics diverge below it:
1. *What is this* — kind (Work Item / AI Task) + title. 2. *Its purpose* — the objective it serves,
or "operational — not tied to an objective." 3. *Its condition* — the assessed condition label
(shared vocabulary, human- and AI-compatible). 4. *Whether you're needed* — intervention: silent
for none, "watch" muted, "needs you: <action>" only when required. 5. *Why* — the native reason,
in the model's own terms. 6. *Who's accountable* — the owner, or "unowned." 7. *Who performs it* —
named only when a distinct performer is recorded; a human item shows "a separate performer is not
recorded" (it never invents a performer from an owner). 8. *How the Hub knows* — the source
(system-observed / human-reported / unknown), kept distinct. 9. *Valid + permitted actions* — the
live edit/finish/stop controls for an active Work Item; nothing actionable once terminal. 10. *What
changed* — the recent line. Per-claim confidence rides on the assessment, not a global badge.

- **Work Item detail is canonical** (`work/[workItemId]/page.tsx`): editable and coordination-
  oriented while active (reuses `WorkItemRow` — condition/owner/notes edit + finish/stop); a frozen,
  read-only **closure record** once terminal (who/when/why, then a pointer to the audit log). No live
  editing surfaces on a closed item — the freeze is enforced in `updateWorkItem`, and the page
  simply stops rendering the edit affordance.
- **AI Task detail reframed, not reduced** (`tasks/[taskId]/page.tsx`): the same `WorkFrame` read
  now leads; every existing mechanic (run, cancel-with-reason, output, provenance) stays intact
  below it. A cancelled task still shows its operator reason.
- **Provenance stays honest:** human-reported vs system-observed is carried through as the frame's
  `source`; a finished/stopped item is described as closed work, never as objective progress.
- **Links:** work-item titles across Execution (Requires-you, Active, Recent) and the row itself now
  route to the canonical detail page; the old in-page `#exec-<id>` anchor is retired as a nav target.
- Acceptance covered by `execution-assess` unit tests (condition/intervention/source/confidence
  translation, Unknown-stays-Unknown, unowned≠performer) plus new `work-items` integration cases
  (getWorkItem carries owner-not-performer, keeps null condition Unknown, exposes the frozen closure
  record with a resolved closer name).

**Execution 2d — cross-surface consistency (built 2026-07-26). Increment closed → Execution closed.**

The same task or work item now reads in one operational language wherever it appears; no surface
hand-rolls a second vocabulary of raw statuses/stages.
- **Objective "Work contributing"** (`objectives/[id]/page.tsx`) routes every attached task and work
  item through `assessTask`/`assessWorkItem` and shows the shared condition + "needs you"/"watch"
  read — replacing the old split of raw `StatusBadge`(AI) vs raw `stage`(human). Work items now link
  to their canonical detail page, not the Execution index.
- **Dashboard "needs you"** (`p/[projectKey]/page.tsx`) assesses failed tasks through `assessTask`
  and renders the translator's own required action ("needs you: Retry or cancel") verbatim, instead
  of a Dashboard-only "failed — open to retry." Finished work still shows only as a "Recently"
  glance — never restated as objective progress.
- **Data plumbing:** `ObjectiveTaskRow`/`ObjectiveWorkItemRow` and `TaskListRow` now carry the
  fields the translator needs (ownerAgentId; condition/waitingOn/updatedAt) so each surface assesses
  from the row's own truth rather than re-deriving it.
- **Consistency locked** by `cross-surface.test.ts` execution cases: a failed task reads identically
  on Dashboard and Execution; a waiting owned item is never a "needs you" on either surface; an
  unowned active item reads "needs you: assign an owner" everywhere, with its condition intact.

The through-line holds: one pure, tested translator (`domain/execution/assess.ts`) is the single
source of the operational read, consumed identically by Execution, Objectives, Dashboard, and both
detail pages. Execution (2a closure integrity · 2b schedule/instance · 2c shared detail · 2d
cross-surface) is complete.

---

## Approvals — the authorization system

Approvals is where autonomous intent crosses into operator-granted authority. Its job is not to show
an AI output and collect a binary answer; it is to help the operator determine: **should the Hub be
authorized to take this specific action, under these stated consequences and limits?**

**Primary question:** *What action is the Hub asking permission to take, why is it appropriate, and
what exactly will happen if I authorize or refuse it?* (Stronger than "what requires my decision?" —
it makes the authority boundary explicit.)

### Three separate lifecycles (the model that ends the stranded-task defect)

Work completion, authorization, and action execution are **distinct facts**, not one lifecycle. The
old defect came from fusing a task's execution status with its proposal's authorization status.
- **Task execution:** pending · running · completed · failed · cancelled.
- **Authorization:** proposed(pending) · authorized(approved) · refused(rejected) · expired ·
  withdrawn · superseded · **revoked** · executed.
- **Authorized-action execution** (future executor): not-started · queued · executing · succeeded ·
  failed · cancelled.

A task's own production work has *already completed successfully* when it emits a proposed action.
The pending authorization belongs to the **proposal**, not to the task's work forever.

**Withdrawn vs. Revoked — the pending/granted boundary.** *Withdrawal* applies **before**
authorization: a proposal is no longer requesting a decision (its task was cancelled or it was
superseded). *Revocation* applies **after** authorization but **before** execution: previously
granted authority is removed. Cancelling a task withdraws its *pending* proposals today; what happens
to an *approved, unexecuted* proposal must be recorded as an explicit transition, not silently
assumed. An authorization that has not executed must be able to become: **revoked** by the operator ·
**invalidated** because its originating context changed · **expired** because its authorization-
validity window ended · **superseded** by a newly authorized replacement. *(Revocation/authorization-
expiry transitions are recorded here as contract; they build with the executor + queue, not yet
wired.)*
> **Principle: Pending intent may be withdrawn. Granted authority must be revoked.**

**Two clocks, not one.** *Proposal expiry* answers "how long may this proposal remain undecided?"
(the 24h TTL today). *Authorization validity* answers a different question — "how long after approval
may this action still execute without a fresh decision?" — and does not exist yet. An authorization
should not be assumed valid forever: a deployment authorized today may be unsafe tomorrow; a financial
action goes stale when amount/payee/funds change; an email may be moot once the recipient replies. The
payload hash protects the exact *parameters*; it does not prove the surrounding *business context*
still holds. The detail must eventually be able to say "Authorized July 26 · not yet executed ·
authorization valid until July 27 2:00pm" or "Authorization expired before execution — a new decision
is required." Do not invent a universal validity period; the right duration depends on action type and
consequence.
> **Principle: Authorization is narrow in scope and bounded in time.**

**Reconciliation rule (built 2026-07-26):** a task holds `awaiting_approval` only while ≥1 proposal
it raised is genuinely pending. Once none remain — every proposal approved, rejected, expired, or
withdrawn — the task reconciles to `completed` (its work succeeded), while each authorization keeps
its independent outcome. Implemented in `reconcileTaskAuthorization` (called after every decision and
after the expiry sweep); a cancelled task withdraws its still-pending proposals via
`withdrawPendingApprovalsForTask`. `withdrawn` is a real authorization state — distinct from
`rejected` (a reviewer refused) and `expired` (it lapsed): the thing it would authorize no longer
exists. Locked by `approvals-lifecycle.test.ts` (approve/reject/expire the final proposal frees the
task; a second pending proposal keeps it waiting; cancel withdraws; a decided proposal is never
re-requested and can't be decided twice).

### Two load-bearing principles

- **Authorization is not execution. The Hub must never describe one as the other.** Until an executor
  exists, approving *records authorization only* — it does not perform the action. The UI says so
  plainly ("Approving records that you authorized this action; this version does not carry it out
  automatically"). Never say "this will deploy/send/charge/publish" unless the product will actually
  do it after authorization. The record must distinguish **Authorized** from **Executed**.
- **Approval grants the narrow authority shown, not general permission to pursue the intent.** The
  operator authorizes *this exact action with these parameters* — not a standing mandate.

### Operator vocabulary: Authorize / Refuse (built 2026-07-26)

Only surface actions the system can enforce truthfully. The operator-facing words are **Authorize**
(grant the narrow authority shown; records authorization only, does not execute) and **Refuse**
(withhold authority — **rationale required**, since a refusal becomes operational memory that shapes
future proposals). The schema keeps `approved`/`rejected`; the surface reads Authorized/Refused.
Authorization-rationale depth should scale with consequence (routine reversible write → no note; a
financial/destructive/production/external action → an explicit note) — enforced fully once the
consequence profile drives it; today Refuse requires a note and Authorize does not.
- **Return** (request a revised proposal) is *not* just a status — it opens another execution loop
  (what must change? does the task resume or a new run start? cost? does the revision need fresh
  approval? is the old proposal superseded?). Do **not** show Return until those mechanics exist.
- **Cancel** applies to the underlying task or an originator withdrawing a proposal — it is not a
  reviewer's authorization decision. A reviewer refusing permission is **Refuse**; a proposal made
  invalid by task cancellation is **Withdrawn/Superseded**.

### What shipped this pass (2026-07-26) — pre-queue integrity refinements

- **Work-finished ≠ action-executed.** `assessTask` takes `authorizedUnexecuted`; a completed task
  holding an authorized-but-unexecuted action never reads "Completed." — it reads "AI work finished; a
  proposed action is authorized but not yet executed." `listExecution` and the task-detail page carry
  the flag (task detail shows an explicit "AI work: Finished · Proposed action: Authorized, not
  executed" line). Locked cross-surface by `cross-surface.test.ts` + `approvals-lifecycle.test.ts`.
- **Evidence-backed consequence shape** (`domain/approvals/consequence.ts`): `assessConsequence`
  establishes only what the payload proves — target, external parties, data affected, financial
  exposure, authority requested, preconditions, execution method — each claim carrying source +
  confidence, everything unproven named in `unknowns`. **Reversibility is never inferred from the
  action type.** The model retains it; the interface must not become a wall of fields. Not yet wired
  to the queue (that's the queue build).
  > **Principle: the Hub may explain only consequences it can establish from the proposal, connected
  > systems, or explicit policy.**
- **Exact-duplicate detection** (`pendingDuplicateExists`): the runner suppresses a proposed action
  that exactly matches an already-pending authorization (same action type + canonical payload hash),
  so the operator is never asked to authorize the same external action twice; suppression is audited,
  and a task whose every proposal was a duplicate does not enter the gate. Broader semantic/superseded
  relationships remain future work — the "deciding one supersedes the other" wording stays out until
  the system can enforce it.

### Responsibilities (the north-star for the coming redesign — not yet built)

1. **State the proposed action precisely** — what the Hub will do; which system/account/file/
   audience/asset it affects; the meaningful parameters; whether it's one action or part of a
   sequence; who/what proposed it. Raw payload stays available for inspection but is *not* the
   primary explanation.
2. **Explain the business purpose** — link to the originating task, the objective/operational
   purpose, the accountable owner, the evidence that produced the proposal, and why now.
3. **Explain the consequence** — what changes if approved; what stays the same; external-party
   impact; reversibility; money spent/committed; data created/modified/disclosed/deleted; whether it
   grants further autonomy; whether later approval will be needed. If the Hub can't establish a
   consequence, it says so.
4. **Show the authority being requested** — the exact scope (send *this* email to *these*
   recipients; deploy *this* revision to staging; spend up to *this* amount). Never interpreted as
   broader permission than the proposal presented.
5. **Scale explanation with consequence** — a routine reversible `file_write` shouldn't demand the
   depth of a financial transaction, destructive mutation, external publication, production deploy,
   or customer communication. Depth scales with consequence · irreversibility · external impact ·
   financial exposure · uncertainty · autonomy granted. Not color-coded action types masquerading as
   judgment — explain why *this* proposal carries *its* consequence.
6. **Preserve decision validity** — at decision time confirm: still pending · not expired · task not
   cancelled · not superseded · payload still matches the stored hash · action still permitted ·
   operator still has authority. (Pending + expiry checks exist and are strong; task-cancellation is
   now handled via withdrawal; supersession/hash-recheck extend this.)
7. **Preserve the decision and its reasoning** — proposed action · exact payload + integrity hash ·
   context presented · who/when · outcome · rationale · whether execution later occurred + its
   result. Audit log stays the exhaustive technical history; the approval record stays the durable
   authorization record.
8. **Reconcile the related work** — once decided, the approval leaves the pending queue, the task's
   assessment recomputes, Dashboard/Execution stop requesting the resolved decision, remaining
   approvals stay visible, and the task reflects a defensible execution state independent of the
   authorization outcome. *(This responsibility is now met by the reconciliation rule above.)*

### What is genuinely strong (preserve — expose and complete, don't replace)

The gate integrity: the model cannot execute directly; a fixed validated action vocabulary; malformed
proposals rejected at the extraction boundary (TB-4); payloads canonicalized + hashed; decision state
re-read before mutation; expired proposals can't be approved; append-only audited decisions;
duplicate decisions prevented. This is the safety foundation.

### The central product failure (what the redesign must close)

The queue answers *"what did the model propose?"* It does not yet answer *"what authority am I
granting, what consequence follows, and what evidence supports granting it?"* — that is the purpose
gap the **queue redesign** must close. The primary question wording is now *"Why was this proposed,
and what evidence supports authorizing it?"* — the Hub explains the proposal (purpose · reasoning ·
evidence · uncertainty · consequence · policy) rather than *selling* it; it may recommend only when a
statable policy/risk assessment backs the recommendation (a bounded judgment like "I cannot recommend
authorization because the endpoint's effect is unknown and no trusted integration record is linked"),
never generic caution.

**Accepted conversation states** the operating-partner read must cover: proposed & awaiting ·
authorized-not-executed · executed · execution-failed-after-authorization · refused-with-rationale ·
expired-before-decision · withdrawn-before-decision · superseded-by-replacement · revoked-after-
authorization · authorization-expired-before-execution · duplicate-detected · consequence-cannot-be-
established. Each keeps the three lifecycles distinct (task execution · authorization · authorized-
action execution). **The queue and approval-detail structure emerge from that conversation — not from
Authorize/Refuse buttons.** (The conversation is agreed; the queue/detail build is the next step.)

### Engineering rule — parallel work must be isolated

> **Parallel implementation work must use isolated working trees.** Concurrent agents must never edit
> the same working tree. Use separate git worktrees or branches; stage only intended files (never
> blanket `git add -A` while another session is live); review the staged diff before committing.

*Origin: during this pass a background task's in-progress `run-jobs.test.ts` fix was unintentionally
swept into an Approvals commit by `git add -A`. Verified after the fact: the committed diff is
complete and coherent and the test passes 5/5 even against a large local queue backlog (it backdates
its own job to the FIFO front and cleans up its rows in teardown). Test files don't ship, so the
deploy was unaffected — but commit provenance still matters. Full suite subsequently run with no
exclusions: 388/388.*

### Queue & detail structures (built 2026-07-26)

The interface emerges from the authorization conversation, not from two buttons.

**Queue** (`approvals/page.tsx`, via `listApprovalsForQueue`) — three groups, not a flat wall:
1. **Needs clarification** — pending proposals whose *material* consequence can't be established
   (`readConsequence.needsClarification`); surfaced first, flagged, decision only via the detail. This
   is a decision-quality assessment, not a separate authorization status.
2. **Awaiting authorization** — the rest, ordered consequential-first. Each reference speaks operator
   language (action · consequence summary · originating task · objective · owner · level chip ·
   expiry) — never raw JSON. Only **routine, workspace-internal** actions offer a compact inline
   Authorize/Refuse; anything **consequential** shows "Open to review & decide" and cannot be
   authorized without opening the record.
3. **Decided** — terminal outcomes keep their distinct meaning (Authorized · not executed / Refused /
   Expired / Withdrawn), each linking to its record.

Consequence **level** and the needs-clarification flag come from `readConsequence(profile)` — evidence
+ nature of the action, never a color-code of the type alone.

**Detail** (`approvals/[approvalId]/page.tsx`, via `getApprovalDetail`) — the decision surface,
conducting the conversation in order: (1) the exact authority requested; (2) why it was proposed
(originating task · objective · accountable owner · performer · provider) — explained, not advocated;
(3) established consequences via `ConsequenceReadPanel` (what the Hub can vs. cannot establish, with
source + confidence; reversibility stays under *cannot establish*, never defaulted); (4) the three
lifecycles kept distinct (AI work · authorization · action execution); (5) integrity & validity
(proposed/deadline times · originating-task-cancelled flag · pending-duplicate flag · collapsible
exact payload + sha256); (6) the decision — Authorize (records narrow authority; **consequential
proposals require an explicit consequence-specific confirmation**, not a generic "are you sure?") or
Refuse (rationale required); (7) once decided, the same page becomes the durable authorization record
(outcome · who · when · rationale · authorized-not-executed) with the audit-log pointer for full
history. Locked by unit (`readConsequence` levels) + integration (`getApprovalDetail` context,
cancelled-task flag, `listApprovalsForQueue`). Full suite: 388/388.

**Inline authorization requires complete context (built 2026-07-26).** A decision may occur inline in
the queue *only* when no material authorization context is hidden elsewhere. `isInlineAuthorizable`
(evidence-driven, not type-tied) allows the compact inline Authorize/Refuse only for a routine
proposal whose payload conceals no material parameter (`hasHiddenMaterialParameters`) — content, diff,
recipients, amount, predicate, environment, URL, etc. Because the compact reference shows summary +
consequence but never payload *values*, any non-trivial payload field forces the decision onto the
detail page. A file creation with hidden content does not qualify; an empty-payload routine action
does. Locked by `consequence.test.ts` ("a proposal with a hidden material parameter can never be
authorized inline").

**Approvals is closed for this product-review pass (2026-07-26).** It answers *"should this exact
action receive narrow authority?"* — with the gate integrity intact, the authorization conversation
on the detail surface, honest authorization≠execution language, and inline decisions permitted only
when nothing material is concealed. Correctly deferred as **future capabilities** (not blockers while
the product states plainly that authorization does not execute): authorized-action execution (the
executor); revocation after authorization; authorization-validity enforcement; semantic
duplication/supersession; a richer identity for the proposal originator than the provider name.

---

## Decisions — bounded institutional memory

Decisions preserves conclusions that may guide later work — converting a moment of judgment into
bounded institutional memory. It is not for every event, opinion, authorization, or model suggestion;
it preserves conclusions with enough context that the Hub can later determine whether one remains
authoritative, whether it applies to the current work, what replaced or limits it, why it was made,
what evidence supported it, and where it has influenced later work.

- **Knowledge** preserves what the workspace *knows*.
- **Decisions** preserves what the workspace *concluded* from what it knew.
- **Decision Memory** applies those conclusions *only where they belong*.

**Primary question:** *What has this workspace concluded, why, and under what circumstances should
that conclusion guide future work?* The added clause is the purpose gap — a trustworthy record must
answer both *what was concluded* and *where it applies*.

### Immediate integrity fix — relevance is an eligibility rule (built 2026-07-26)

Decision Memory selection is now two distinct stages, not one score:
1. **Eligibility** — a decision may be considered only when a structural relationship to the run
   establishes relevance: same originating task, same objective's tasks, or a shared supporting
   reference. No relationship means omitted. Until explicit scope exists, this narrow default is
   deliberate: silently applying unrelated guidance is worse than reduced recall.
2. **Ranking** — recency (and, later, precedence) orders only decisions already eligible.

Previously every accepted decision got a recency score, so an unrelated one could enter a run merely
because fewer than ten better candidates existed. Fixed in `selectRelevantDecisions`; locked by
`decisions.test.ts` (an unrelated accepted decision is not injected even as the only candidate; a
shared supporting reference makes a decision eligible) and `decision-extraction.test.ts` (an accepted
decision does not leak into an unrelated run).
> Principle: Recency may rank applicable memory; it may not create applicability.

### Record vs. active guidance are different concepts

A decision can be worth preserving without being reusable guidance. "Use the shorter email for this
contractor" (task-specific) is not "all contractor outreach should be concise" (workspace policy),
which is not "don't renew this vendor this month" (time-bound), which is not "the pricing test failed
because the sample was too small" (historical conclusion — informs analysis, is not an instruction).
The model must separate:
- **Record status** — was the conclusion accepted as a legitimate record? (proposed, accepted,
  rejected, superseded, retired)
- **Guidance applicability** — should it actively guide later work? (record-only, or reusable within a
  bounded scope)
> Principle: Acceptance preserves the conclusion; scope determines where it may guide.

### Responsibilities (north-star for the redesign — not yet built beyond the eligibility fix)

1. **Preserve the conclusion** — what, why, who had authority, when, evidence, human-vs-AI origin,
   residual caveat. Summary stays joined to the rationale that makes it understandable.
2. **Define intended reuse** — one-time conclusion / task guidance / objective guidance / standing
   workspace guidance / historical precedent (informs but does not control). The Hub must know whether
   a decision is a record, an instruction, a precedent, or a bounded combination. A one-off must not
   become policy merely because it was accepted.
3. **Bound its scope** — task / objective / workspace (narrower scopes only when operation demands).
   Where scope can't be established, default narrow.
   > Principle: Institutional memory should default to the narrowest scope its evidence supports.
4. **Preserve time boundaries** — permanent / time-bounded / condition-dependent / historical. Do not
   assume an old accepted decision remains authoritative forever.
   > Principle: A decision may be historically valid without remaining operationally active.
5. **Establish authority** — why it may guide (operator accepted, owner within authority, implements a
   policy, superseded by a more authoritative decision, AI-proposed but human-accepted). AI suggestion
   confidence is not authority. Distinguish who proposed, who accepted, who is accountable, what scope
   they could establish.
6. **Manage supersession, retirement, reversal** — Superseded (replaced), Retired (no longer active,
   no replacement), Rejected (never accepted), Reversed (a later decision concludes the opposite). An
   accepted decision must be removable from active guidance without a replacement, and never disappear
   or be silently rewritten.
7. **Detect potential conflicts** — do not inject two incompatible active decisions and instruct the
   AI to obey both. v1 need not resolve semantic conflict — it must not hide known ambiguity; it should
   say "two active decisions may conflict within this objective; I cannot determine which governs
   without your review."
   > Principle: Conflicting memory must be surfaced for resolution, not silently blended.

### Scope & precedence (contract first, no complex algorithm yet)

Defensible initial ordering: (1) explicit supersession/replacement; (2) explicit applicability to the
current work; (3) narrower applicable scope over broader guidance when the narrower is an intended
exception; (4) authority and effective period; (5) recency only among otherwise applicable decisions.
Recency alone never overrides an active decision. The Hub should be able to explain why a decision was
selected.

### Decision Memory must be explainable (reverse view)

The run manifest records which decisions were injected (forward view). The missing experience is the
reverse: from this decision, where has it influenced work — which run, why applicable, which scope
matched, what text was supplied, which competing decisions were omitted, how it was used, what
followed.
> Principle: Reusable memory should leave a visible trail of where it was applied.

### Category ≠ scope

`decisionType` describes subject matter, not applicability. A decision has a Type and a Scope and an
intended reuse and a validity period — each answers a different question.

### AI suggestions & Defer

The AI proposal gate is correct and preserved (propose, explain worth, cite refs, estimate confidence,
never self-activate). Review must help the operator decide not just *is this reasonable?* but *should
the workspace remember it, and at what scope?* — an AI suggestion must not default to workspace-wide.
**Defer** currently only stamps `reviewedAt` (invisible bookkeeping); it must gain real semantics
(until when, why, who revisits, still visible?) or be removed from the primary workflow.

### Boundaries

- **Approvals** grants narrow authority for one action; an authorization does not become standing
  guidance because it was granted.
- **Decisions** preserves a conclusion intended to inform/govern future work within a stated boundary.
- **Knowledge** preserves facts/documents/evidence; may support a decision without becoming a directive.
- **Audit** preserves exhaustive event history; may explain how a decision was made but does not become
  guidance.

### Conversation refinements (accepted 2026-07-26) — six language/contract corrections

1. **Eligibility ≠ injection ≠ reference ≠ influence.** The manifest can show a decision was *injected*,
   not that the model *followed* it. Preserve four levels: **eligible** (matched applicability) →
   **injected** (in the run context) → **referenced** (the output cited it, when detectable) →
   **influenced** (materially changed the work — usually an inference). Say "included in the context for
   five runs," not "shaped five runs"; where effect is unknown, say so.
   > Principle: Memory application must distinguish eligibility, injection, explicit reference, and inferred influence.
2. **Scope is a boundary, not inject-everywhere.** Workspace scope means a decision *may* apply anywhere
   when its subject is relevant — not that it enters every run. Relevance still gates.
   > Principle: Scope defines where guidance may apply; relevance determines whether it applies now.
3. **Guidance should not outlive its scope by default.** Task guidance normally goes inactive when the
   task closes; objective guidance when the objective completes/cancels; kept afterward only as record,
   or deliberately extended. "Active while this objective remains open, unless you retire, supersede, or
   extend it" — not "open-ended."
   > Principle: Guidance should not outlive the scope that gave it meaning unless explicitly extended.
4. **Permanence belongs to the record, not active authority.** Use "open-ended workspace guidance," not
   "permanent." The record may be permanent; authority to guide stays reviewable and retirable.
   > Principle: The record may be permanent; operational authority remains reviewable.
5. **Distinguish proposal, authorship, acceptance, authority.** Preserve *proposed by · accepted by ·
   accountable owner · authority/role under which accepted*. AI confidence is evidence, never authority.
6. **Rationale ≠ evidence.** Rationale explains the judgment; evidence supports the factual/causal
   claims; supporting references are where it's inspectable; caveats are what's uncertain. Say "the
   decision cites three call records as support," not "three calls proved this works."
   > Principle: A decision rationale explains the judgment; it does not substitute for evidence.

**Language guards:** conflict → "these decisions *may* conflict within the same objective" (offer
supersede/retire/narrow/exception paths; don't pre-decide the relation or claim "can't apply together"
unless incompatibility is established). No unsupported promises: "scheduled to lapse on July 30," not
"I'll warn you a day out" (no scheduler yet); "the refusal and rationale remain in the record," not "the
suggestion carries your reasoning next time" (no rejected-learning yet). **Defer** stays out of the
workflow until it records revisit-trigger · reason · owner · queue-behavior.

**Accepted conversation spine** (every decision experience answers): what concluded · why · who proposed
· who accepted & under what authority · what evidence · record-or-guidance · scope · what makes it
relevant now · how long active · what limits/retires/replaces it · where eligible/injected · where
explicitly referenced · what conflicts.

### Semantic model built (2026-07-26) — the substrate the structure renders

- **Scope + applicability + validity** are now first-class on a decision (`applicability`
  record|guidance · `scope` task|objective|workspace + `scopeObjectiveId` · `effectiveUntil`). Only
  **active guidance** (accepted · applicability=guidance · not past `effectiveUntil`) is ever injected,
  and **scope is the ceiling on which relationships count**: task-scoped reaches only its own task,
  objective-scoped its objective's work, workspace-scoped any relevant run. **AI candidates default to
  task-scoped guidance — never workspace-wide.** Category (`decisionType`) stays separate from scope.
- **Retired** is a real status (`retireDecision`): an accepted decision can leave active guidance
  *without* a replacement (distinct from superseded), remaining a historical record.
- Locked by `decisions.test.ts`: record-only never injected · expired historical / future active ·
  task-scope doesn't leak to a sibling task · objective-scope reaches siblings · retire stops guidance.
  Full suite 397/397.
- The Decisions page now lets a human set mode/scope/objective/validity and retire an accepted decision,
  and shows each accepted decision's *guides-{scope}* / *record-only* / *until/expired* read.

### Three model-level fixes before the structures (built 2026-07-26)

1. **AI may recommend reuse; only the operator activates it.** AI candidates are now filed
   **record-only** (with a *suggested* task target preserved), so a plain Accept can never turn a
   suggestion into active guidance. Promotion is an explicit `acceptDecision(…, {applicability,
   scope, target})` that **requires a concrete scope**. Suggestion confidence carries no authority.
   Locked by tests (plain-accept stays record-only & uninjected · promote-to-guidance needs a target).
2. **Scope must name a concrete target.** New `scopeTaskId` (+ existing `scopeObjectiveId`);
   `assertScopeTargets` enforces: task→a real task, objective→a real objective, workspace→neither,
   and targets must belong to the workspace; a target is never inferred from category. The
   workspace-level Decisions form no longer offers "this task" (no task context there). Malformed
   combinations are rejected (tested).
3. **Guidance follows the lifecycle of its scope.** The selector drops task-scoped guidance once its
   task is terminal (completed/cancelled) and objective-scoped guidance once its objective closes —
   without deleting or rejecting the record (it stays an accepted, now-inactive memory). Enforced via
   scope-target status joins; locked by tests (completed/cancelled task · closed objective).

Plus: **Retire** applies only to active guidance (a record-only decision is already inactive —
rejected), records a reason (who/when via reviewedBy/At), and is offered in the UI only for guidance.
**`effectiveUntil`** is a stored timestamp; the selector uses one comparison (`> now`); a past instant
is historical, not active.

**Honest reverse trail:** a new `decision_injections` table logs each time a decision was *injected*
into a run (with why: task/objective/reference) — recorded in the runner once the run row exists.
`listInjectionsForDecision` reads it. This is **injection, never "influence."** `detectPotentialOverlaps`
surfaces *possible* conflicts (2+ active guidance on the same objective) as "may conflict — review,"
never asserting incompatibility. All verified: full suite **401/401**.

### Four record-model fixes before the pages (built 2026-07-26)

1. **Suggested reuse ≠ actual scope.** AI candidates store their recommendation in *separate*
   `suggestedApplicability` / `suggestedScope` / `suggestedScopeTaskId` fields; the decision's ACTUAL
   applicability is `record` with no active scope. The reviewer's promotion sets the actual scope
   independently — even when it differs from the AI's suggestion. The selector and Portfolio read
   *actual* applicability only. *Principle: suggested reuse is evidence for review, not active scope.*
2. **Lifecycle authority is persisted, not conflated.** Who proposed/accepted/rejected/retired/
   superseded a decision — with when and (where recorded) why — is read from the append-only
   `audit_logs` via `getDecisionLifecycle`; the author is never used as the acceptor, and the generic
   `reviewedAt` is never treated as explaining which event occurred. Reject/retire now record a
   reason. *The Hub must not claim decision authority it has not recorded.*
3. **Injection trail is idempotent and historical.** A unique `(run_id, decision_id)` boundary +
   `onConflictDoNothing` means a runner retry never double-counts. Each injection stores the EXACT
   rendered `memoryText` supplied to the AI — an immutable snapshot, so the detail shows what the
   model actually received even after the decision or rendering later changes. *Principle: application
   history preserves what the AI actually received, not what the decision looks like today.*
4. **Shared applicability ≠ conflict.** `detectSharedApplicability` reports that multiple active
   guidance decisions *apply to* one objective — an observed overlap, never labeled a conflict. A
   conflict assessment needs an additional basis (operator flag, opposition/supersession, incompatible
   directives) — future work. *Principle: shared applicability is not evidence of conflict.* The Needs-
   review lens must not be fed by mere overlap, and "never injected" is not an automatic defect.

All verified: full suite **406/406**.

### Portfolio & Detail structures (built 2026-07-26)

- **One shared assessment** (`domain/decisions/assess.ts` → `assessDecision`): the single pure source
  of record-status · memory-role · guidance-state · inactive-reason · active-guidance · historical ·
  valid-actions. The **selector, Portfolio, and Detail all consume it** — a decision can't be active
  in one surface and inactive in another. The selector calls `assessDecision().isActiveGuidance` as
  its base gate, then adds run-relevance. Locked by `decision-assess.test.ts` (7 states) +
  `decisions.test.ts` cross-surface (Detail-active ⇒ injected; Detail-closed ⇒ not injected).
- **Portfolio** (`decisions/page.tsx`): Awaiting review (with AI suggestion clearly labeled as a
  suggestion, and Accept-as-record / Accept-as-guidance-with-scope / Refuse-with-rationale) · Active
  guidance (scope + target · effective period · "supplied to N runs") · Record only (legitimate
  memory, not second-class) · **Needs review** as a *lens* (invalid scope · approaching expiry ·
  multiple guidance on one objective) whose items keep their canonical home and are shown as concise
  references, never duplicate cards — and **"never injected" is NOT a concern** · Historical (distinct
  reasons: retired/superseded/rejected/expired/task-closed/objective-closed).
- **Decision Detail** (`decisions/[decisionId]/page.tsx`, via `getDecisionDetail`): conclusion ·
  rationale · evidence/refs · proposal provenance · **acceptance/refusal/retirement authority read
  from `audit_logs`, shown only when the event exists** ("no recorded acceptance event" otherwise,
  never the author-as-acceptor) · memory role · scope + concrete target · effective period +
  active-state reason · lifecycle history + supersession lineage · **Decision Memory applications**
  (labeled as injections, not "eligibility"; each shows the run, why it qualified, and the **exact
  immutable `memoryText`** supplied) · shared applicability (observed overlap, explicitly *not* a
  conflict) · valid actions. Scope-broadening is not an ordinary edit — accepted guidance is retired
  or superseded; broader guidance is a new, traceable decision (stated in the Actions section).
- Verified: `tsc` clean · build clean · full suite **416/416** (no exclusions).

**Correction (2026-07-26): shared applicability is NOT a Needs-review trigger.** Several decisions may
legitimately guide one objective. The Needs-review lens fires only on an evidence-backed concern —
invalid/missing scope target, approaching expiry, or a closed scope that needs deliberate
promotion/restatement — never on scope overlap alone. Shared applicability stays as *neutral context*
on Detail only ("N other active guidance decisions also apply to this objective"). Also clarified: the
selector rule is **active guidance + a relevant run relationship may be injected** — active guidance
alone is never injected into every run. Regression tests added (`decision-assess.test.ts`: overlapping
objective guidance is a clean active state; `decisions.test.ts`: active guidance is injected only into
a relevant run, not an unrelated one). Full suite **417/417**.

**Decisions is CLOSED for this product-review pass (2026-07-26).** It answers *"what has this
workspace concluded, why, and under what circumstances should that conclusion guide future work?"* and
preserves the distinctions: history vs instruction · suggestion vs authority · scope vs relevance ·
injection vs influence · active guidance vs historically-valid record. Deferred (recorded, not built,
never presented as if they exist): eligible-but-not-injected history (needs an evaluation event
persisted at assembly time), evidence-backed semantic conflict assessment, and Defer with real
semantics.

---

## Knowledge — the workspace evidence & context system

Knowledge preserves facts, claims, learned context, and reusable reference material with enough
provenance that the Hub can decide what a record says, where it came from, how it was established,
whether it remains current, where it applies, how confidently it may be used, whether another record
disputes it, and whether it may be disclosed in the current work.

- **Documents** preserve source material · **Artifacts** preserve outputs of execution · **Knowledge**
  preserves claims and context derived from identifiable sources · **Decisions** preserve conclusions
  intended to guide future work. **Knowledge supports judgment; it does not grant authority.**

**Primary question:** *What does this workspace believe to be true, what supports that belief, and when
is it appropriate to rely on it?* ("What does the workspace know?" is fine product language, but the
internal contract is more precise — Knowledge holds observed facts, human assertions, extractions,
summaries, interpretations, inferences, and reference material, which do NOT carry equal weight.)

The central failure the review named: **active Knowledge was treated as universally applicable,
currently true, and equally trustworthy — three different claims, none established by activation.**

### Immediate integrity fix — relevance gates injection (built 2026-07-26)

`loadApprovedContext` injected every active item into every run as "charter." That is corrected on the
**run path**: the runner now uses `selectRelevantKnowledge`, two-stage like Decision Memory —
**eligibility** (an active item is considered only when it shares subject vocabulary with the run's
query = task input + objective; workspace membership alone is never enough), then **ranking**
(shared-term strength, then recency — recency ranks, never creates relevance). No relationship →
omitted (`domain/knowledge/relevance.ts`, `MIN_SHARED_TERMS`). Bounded to 12. Only active items are
eligible, so a superseded/archived version can never be supplied.
> Principle: Approval permits Knowledge to be used; relevance determines whether it belongs in this run.

**Application records** (`knowledge_injections`): each time a knowledge item VERSION is injected, one
immutable row records item+version · run · task · why eligible · the **exact rendered text supplied** ·
timestamp — idempotent per (run, item), so a retry can't inflate history and a later revision can't
rewrite what a past run received. `logKnowledgeInjections` / `listInjectionsForKnowledge`. This is
**injection, not influence** (eligible → injected → referenced → influenced stay distinct).
> Principle: Application history preserves what the AI actually received, not what the record looks like today.

### Durable principles (recorded; enforcement partly future)

- Approval permits Knowledge to be used; relevance determines whether it belongs in this run. *(built)*
- Activation is permission to consider a record, not proof that every claim in it is true.
- A provenance label is useful only when it leads back to inspectable support.
- A claim may remain historically correct while becoming unsafe to use as current context.
- Scope defines where Knowledge may apply; relevance determines whether it applies now.
- Knowledge may describe a directive; only an authoritative decision can establish it as guidance.
- Conflicting evidence must remain visible until authority or stronger evidence resolves it.
- AI may propose what the workspace could remember; it may not declare its own output trusted Knowledge.
- Relevant Knowledge is supplied only when its disclosure is permitted.

### Responsibilities (north-star for the coming build)

1. Preserve claims and context without rewriting history *(the versioning lifecycle already does this)*.
2. Retain inspectable provenance. 3. Distinguish epistemic basis (observed / asserted / extracted /
summarized / inferred / derived). 4. **Separate activation from verification** (record status vs
verification state vs claim-level confidence — no single confidence for a multi-claim free-text item).
5. Represent freshness and validity (as-of / last-verified / optional review-or-expiry / freshness
assessment / staleness reason; no universal staleness window). 6. Bound applicability through scope
(workspace/objective/task/entity) AND relevance. 7. Preserve disputes, supersession, correction
(superseded / archived / stale / disputed as distinct). 8. Control sensitive disclosure — the future
retrieval gate asks **(a) is it relevant? (b) is this run authorized to receive it?** 9. Record where
Knowledge was supplied *(built: application records)*. 10. Support Decisions without behaving as
authority itself.

### What is genuinely strong (preserve)

The versioned record lifecycle: drafts quarantined · only-active injects · revision creates a new
version (never rewrites) · explicit supersession · activating a replacement archives its predecessor
atomically · every transition audited · tenancy reasserted on the high-risk read.

### Boundaries

Knowledge (facts/evidence/context) · Decisions (conclusions/guidance) · Documents (files) · Artifacts
(execution outputs) · Audit (history). The `kind` set (`policy`/`standard`/`decision`) leans
prescriptive; **a subject category must not create authority** — Knowledge is presented as evidence,
never as instructions that override Decision Memory. (Prompt reframing + the trustworthiness schema are
the next step.)

### Two live context-path fixes (built 2026-07-26)

- **Every AI consumer uses the safe path.** Objective suggestion (`suggest.ts`) — an AI call — now
  uses `selectRelevantKnowledge` with the drafted objective as its query, not the wholesale loader.
  The wholesale loader is renamed **`listAllActiveKnowledgeForAdministration`** (was
  `loadApprovedContext`) so its risk is explicit; it is for admin/inspection/migration only. A
  guard test asserts no prompt-producing module (`runner.ts`, `suggest.ts`) references it.
  > Principle: Every AI context consumer must pass through the explicit relevance gate. (The
  > **disclosure gate does not exist yet** — sensitivity classification + access enforcement are
  > future. Precise claim: *Knowledge retrieval is protected against wholesale relevance leakage
  > across known AI prompt paths* — NOT "every consumer passes a relevance AND disclosure gate.")
- **Knowledge enters prompts as evidence, not charter.** Level 2 is reframed from "APPROVED WORKSPACE
  CONTROLS (authoritative)" to **"KNOWLEDGE CONTEXT — evidence to weigh, NOT instructions"**; the
  authority contract states Knowledge is not authority/instructions and defers directive authority to
  Decision Memory (Level 1) — even for a record titled policy/standard/decision. The run item label is
  now "Knowledge context." Locked by `knowledge-prompt-framing.test.ts` (policy-titled item renders as
  context, not an approved control; contract defers to Decisions).
- **Lexical relevance hardened + labeled transitional.** Generic business vocabulary (customer /
  project / process / price / task / work / company / …) is excluded so it can't create false
  relevance; the matched terms are preserved in the application record's reason (`subject: <terms>`) —
  provisional relevance by shared terminology, *not* structural applicability. When scope/entity
  fields exist, structural scope becomes primary and vocabulary supporting. Full suite **429/429**.

### Checkpoint corrections (built 2026-07-26)

- **Application history covers every AI consumer.** `knowledge_injections` gained a consumer identity
  (`consumerType` + `consumerId`); `logKnowledgeApplications` replaces the run-only logger. Task runs
  log as `task_run` (consumerId = run id); objective suggestion logs as `objective_suggestion`
  (consumerId = a per-call operation id) — the **same inspectable, immutable, idempotent** record, no
  separate audit mechanism. Idempotency is now per `(consumerType, consumerId, item)`. Tested for both
  consumer types (suggestion records what it received, retry doesn't duplicate, text immutable, reason
  preserved). *Principle: every AI use of Knowledge leaves the same inspectable application record.*
- **Durable admin boundary.** The unrestricted wholesale loader now lives in `domain/knowledge/admin.ts`
  (`listAllActiveKnowledgeForAdministration`) — removed from the AI-context/domain surface, so a prompt
  path can only reach it by a conspicuous, deliberate import. Safe selection (`selectRelevantKnowledge`)
  is the obvious public API; the repository guard test remains as a secondary defense.

### Trustworthiness model — increment 1: the shared assessment + selection order (built 2026-07-26)

One shared **`assessKnowledge`** (`domain/knowledge/assess.ts`) is the single source of a record's
trust: lifecycle · epistemic basis · verification · freshness · scope validity · disclosure decision ·
**use-state** (usable / usable-with-qualification / withheld) · reasons · prompt qualifications. The
selector consumes it; rendering and the future Portfolio/Detail will too — a record can't be usable in
selection, stale in rendering, and trusted in inspection at once.

- **Persisted trust facts** on `knowledge_items`: `epistemicBasis` (observed/human_asserted/extracted/
  summarized/inferred — how it was *formed*, never derived from `kind`); `verification`
  (unverified/human_confirmed/source_supported/system_verified/disputed — **separate from activation**;
  `setKnowledgeVerification` is the explicit audited event; creation is always `unverified`); temporal
  `asOf`/`verifiedAt`/`reviewAfter`/`expiresAt` → derived freshness (current/review-due/stale/
  historical/unknown) by one deterministic rule, never from `updatedAt`; `scopeKind` (task/objective/
  workspace) + concrete target (validated same-workspace); `disclosure` (workspace_internal/restricted,
  **restricted denied by default** — grants are future).
- **Selection order enforced** (`selectRelevantKnowledge`): lifecycle → active version → **disclosure**
  → **scope validity** → **relevance** (scope-target match, or lexical for workspace scope — a record
  failing scope is not rescued by lexical overlap) → **freshness/verification** (use-intent aware) →
  rank → render with qualifications → log. Withheld items never enter scoring and contribute **no text**
  to the prompt. **Use-intent aware:** a task run (`current_operational_fact`) withholds expired,
  scope-closed, and disputed records; a `reference`/`historical_analysis` consumer may receive the same
  record *qualified*. Supplied records carry a `[basis · verification · freshness · scope]` label.
- Locked by `knowledge-assess.test.ts` (state matrix) + `knowledge.test.ts` (unverified-after-activation,
  expired withheld, restricted withheld with no sensitive text supplied, scope requires a concrete
  same-workspace target, closed-scope doesn't leak, disputed withheld for current / qualified for
  reference, `kind` plays no role). Full suite **443/443**.

### Trustworthiness increment 1b — foundation hardening (built 2026-07-26)

- **Durable AI operations** (`ai_operations` + `domain/ai/operations.ts`). Objective suggestion now
  records a durable operation BEFORE provider dispatch, references it as the Knowledge-application
  `consumerId`, logs applications at dispatch (even if the provider later fails), and advances the op
  to completed/failed. `idempotencyKey` makes the same logical retry reuse the same operation; no key
  → a new operation per request. Inspectable via `getAiOperation`. *Principle: an AI application is
  inspectable only when it belongs to a durable operation record.* (A client-supplied idempotency key
  is threadable but not yet passed by the form — each call is currently its own durable op.)
- **Verification is an evidenced event, not a label** (`setKnowledgeVerification`). Preconditions
  enforced: `disputed` requires a rationale; `source_supported` requires a resolvable source and
  `system_verified` a deterministic check — **both rejected until provenance exists** (no unsupported
  labels); `human_confirmed` is an explicit affirmation; activation never verifies. Who/when/why live
  in the append-only audit event (`getKnowledgeVerificationHistory`). *Principle: verification is an
  evidenced lifecycle event, not an editable label.*
- **Freshness locked to explicit facts.** "Current" now requires an `asOf` (a `verifiedAt` alone is
  not currency); boundaries are inclusive and compared as absolute instants (timezone-independent);
  age of a row never implies staleness. *Principle: freshness is derived from explicit validity facts,
  not the age of a database row.* Locked by boundary/timezone tests.

Verified: full suite **447/447**.

**Increment 1c — idempotency threaded through the real caller + freshness corrected (built 2026-07-26):**
- **Idempotency is now enforced end to end.** The objective-suggestion form generates a stable
  per-click request key (a network replay/double-submit of the same click reuses it; a fresh click is
  a new key), threaded action → domain. `beginOrReuseAiOperation` decides: no op → dispatch; completed
  op → **return the stored result (no second provider call)**; running op → in-progress (no re-dispatch);
  failed op → retry under the same operation (attempt++). The suggestion result is stored on the
  operation (`resultData`) so a replay returns it. Locked by tests (double-submit, replay-while-running,
  post-completion replay returns stored result, failure→retry-same-op, keyless→new op).
- **`asOf` alone no longer means current.** An observation date establishes *historical position, not
  continuing validity*: `asOf`-only → freshness unknown, rendered "as of <date>; current status not
  established", and never handed to a current-operational consumer as settled fact. "Current" requires
  an open validity window — a future `reviewAfter` or `expiresAt`. Locked by boundary/timezone tests +
  historical-analysis qualification. *Principle: an observation date establishes historical position,
  not continuing validity.* Full suite **450/450**.

**Increment 1d — operation-integrity: idempotency fingerprint + frozen retry context (built 2026-07-26):**
An idempotency key now identifies ONE immutable logical request. `beginOrReuseAiOperation` binds the
key to a request **fingerprint** (`contextHash` = hash of workspace · type · objective content ·
prompt version): same key + same fingerprint reuses the operation; **same key + different fingerprint
is rejected as a conflict** (a changed submission needs a new key). Retries repeat the **frozen**
Knowledge context recorded at first dispatch (`listConsumerKnowledgeApplications`) rather than
re-selecting — a failed retry can't silently receive a different Knowledge set because records changed
between attempts. Locked by tests (key can't alias two requests · retry preserves fingerprint · retry
reuses the frozen snapshot · changed submission still conflicts after failure). *Principle:
idempotency identifies one immutable logical request, not merely one client-generated string.* Full
suite **452/452**.

### Trustworthiness increment 2 — inspectable provenance, Part A (built 2026-07-26)

- **Version-specific source relationships** (`knowledge_sources`): type · resolvable ref · label · exact
  version hash · source date · transformation · locator · added-by/at; multiple independent sources per
  Knowledge version; only resolvable types (`document`/`artifact`). A manual assertion legitimately has
  none. Immutable version boundary enforced in the domain: `attachKnowledgeSource` works only on a
  **draft** — a change to an active/applied version requires a new version.
- **Bounded, exact-version resolver** (`provenance.ts`, `resolveKnowledgeSource`): resolved / missing /
  inaccessible / version-mismatch / unsupported. A document resolves by path **and exact sha256** — a
  differing current hash is `version_mismatch`, never a silent fallback to latest. Access-aware
  (`inaccessible` reserved for actor/consumer permission). Persisted citation facts stay separate from
  the current resolution result.
- **Provenance state** (`assessProvenance`, consumed by `assessKnowledge`): no_source /
  attached_not_reviewed / inspectable_support / partial / broken / unsupported. Distinguishes "no source
  claimed" (not a defect) from "a claimed source can't be inspected" (broken). Broken provenance on a
  **source-dependent** record (extracted/summarized/inferred or source_supported) is **withheld for
  current-operational use, qualified for historical**.
- **Attached ≠ inspected ≠ judged-to-support.** Attaching a source never changes verification.
  `source_supported` is reachable ONLY via `recordSupportJudgment`, which names the relied-upon sources,
  requires each to resolve to its exact cited version now, and writes an **append-only** judgment event
  snapshotting the relied ids + their resolution.
- **Historical support ≠ current inspectability.** A later resolution failure never rewrites the
  judgment event; verification stays `source_supported` while current provenance reads `broken`.
  *Principle: a later source-resolution failure does not rewrite the historical verification event, but
  it may limit present reliance.*
- Locked by `knowledge-provenance.test.ts` (no-source-not-defect · attach-doesn't-verify · judgment
  needs relied sources · missing/version-mismatch fail source_supported · multiple sources resolve
  independently → partial · historical judgment survives a later break · post-activation immutability).
  Full suite **458/458**.

**Provenance Part A refinements (built 2026-07-26):**
- **Artifacts get the exact-version contract too.** The resolver verifies an artifact's `sha256`
  against the cited `sourceVersionHash` — write-once artifacts still can't silently resolve to changed
  content. *Principle: a resolvable identifier is provenance only when it identifies the exact evidence
  originally used.*
- **`inaccessible` stays reserved.** The resolver emits only missing / version-mismatch / unsupported /
  resolved today; `inaccessible` will be emitted only from a real access decision when source
  permissions land. *Principle: the Hub may call evidence inaccessible only when it can establish the
  evidence exists and access is denied.*
- **Relied-upon vs supplemental sources.** `assessKnowledgeProvenance` now separates the sources a
  support judgment RELIED upon from merely supplemental attachments, and reports `reliedBroken` +
  `brokenForCurrentUse`: a broken *supplemental* source (overall `partial`) does NOT invalidate resolved
  relied-upon support; a broken *relied-upon* source limits present reliance and withholds from current
  use. Locked by tests (artifact version-mismatch; broken-supplemental-usable; broken-relied-withheld;
  judgment identifies which relationships govern). Full suite **460/460**.

### Trustworthiness increment 2 — inspectable provenance, Part B (built 2026-07-26)

Provenance is now resolved into the LIVE retrieval path and frozen onto every application — the trust
model stops being an inspection-only artifact and starts governing what actually reaches a prompt.

- **Resolve provenance during selection, but only where it can bite.** `selectRelevantKnowledge` runs
  the cheap gates first (lifecycle / disclosure / scope / freshness / dispute) and the relevance gate,
  then — for the surviving relevant candidates only — resolves each cited source against today's
  workspace via `assessKnowledgeProvenance` and re-runs the shared `assessKnowledge` with
  `provenanceBroken = brokenForCurrentUse`. Source resolution is never paid for on irrelevant or
  already-withheld rows. *Principle: the same assessment governs inspection, rendering, and selection —
  a record can't be trusted in one and withheld in another.*
- **Intended use decides the verdict, not the defect alone.** A source-dependent claim whose
  relied-upon evidence can't be inspected at its cited version is **withheld** from
  `current_operational_fact` use, yet remains **usable-with-qualification** for `historical_analysis` /
  `reference`. Broken provenance limits reliance; it does not erase the record. *Principle: broken
  evidence changes what a record may be used FOR, not whether it exists.*
- **Qualified rendering carries provenance, and the sensitive-metadata guard holds.** The prompt bracket
  gains a provenance phrase (`source-supported` · `cited source version unavailable` ·
  `relied-upon source version unavailable` · `some supplemental sources unavailable` · `cited source
  type not resolvable` · `source attached, support not yet reviewed`). A human-readable source label is
  rendered into the prompt **only when that source currently resolves to its cited version** — broken /
  missing / mismatched / inaccessible sources contribute a generic phrase but never leak their label,
  ref, or hash. *Principle: name the evidence you can stand behind now; never leak a pointer to evidence
  the consumer can't inspect.*
- **Immutable trust snapshot on every application.** `knowledge_injections.trust_snapshot` (migration
  0030) freezes the facts used AT DISPATCH: epistemic basis, verification, freshness, provenance state,
  use-state, scope, disclosure decision, intended use, relied + supplemental source IDs, per-source
  resolution outcomes, support-judgment ID, and a pinned `renderingVersion` (`kv1`). Source IDs and
  outcomes are stored; human-readable labels are NOT (the snapshot is an internal audit fact and labels
  can be sensitive). *Principle: a past dispatch must be explainable from what was true then, without
  recomputing from records that have since moved.*
- **A retry repeats the frozen snapshot — it never re-resolves.** Selection (and therefore resolution)
  runs only at first dispatch; retries read the frozen `memoryText` + snapshot via
  `listConsumerKnowledgeApplications`. A source breaking between attempts cannot silently change the
  Knowledge a retried operation receives. *Principle: one immutable logical request receives one frozen
  evidence set, whatever happens to the underlying records mid-flight.*
- Locked by `knowledge-provenance-selection.test.ts` (inspectable→selected+named · broken-relied→withheld
  for current · broken→usable-qualified for historical + no label leak · broken-supplemental→usable,
  names only resolved relied · no-source→clean · snapshot freezes resolutions/relied-ids/judgment ·
  retry repeats frozen state after a break · reverse trail carries the version). Full suite **468/468**.

### Trustworthiness increment 3 — enforceable disclosure grants (built 2026-07-26)

Until now, `restricted` was a dead end: the selector hardcoded `disclosurePermitted = disclosure !==
'restricted'`, so restricted Knowledge was withheld from *everyone*, always. A grant turns that blanket
refusal into a real, revocable, tightly-scoped decision.

- **Scope: per specific agent + per specific purpose, in an explicit window.** A
  `knowledge_disclosure_grants` row (migration 0031) authorizes ONE restricted item for ONE agent for
  ONE purpose (a `KnowledgeUseIntent`) until a required `expiresAt`. A grant is LIVE only when not
  revoked AND `grantedAt <= now < expiresAt`. Operator chose the tightest consumer scoping on offer —
  restricted Knowledge reaches exactly the intended agent for exactly the intended use.
- **Every consuming agent must be granted.** The runner passes `consumerAgentIds = [primary, reviewer]`
  (both read the same context package); `selectRelevantKnowledge` discloses a restricted item only when
  EVERY consuming agent holds a live matching grant. One un-granted consumer withholds the whole
  disclosure. *Principle: a restricted item is only as contained as its least-restricted reader — a
  grant to one consumer does not leak it to another that shares the same prompt.*
- **No agent, no disclosure.** A non-run consumer with no agent (e.g. objective suggestion) has an empty
  consumer set, which can never satisfy "every consumer is granted" — restricted Knowledge is therefore
  structurally unreachable there. *Principle: there must be a named party accountable for a restricted
  disclosure; absent one, the answer is no.*
- **Revocation is a decision, not a delete.** `revokeDisclosureGrant` stamps `revokedAt/revokedBy/
  revokeReason` (audited); the row and its history survive, and a revoked grant is immediately not live.
  Double-revoke conflicts. Granting a non-restricted item is rejected (meaningless).
- **A disclosure is explainable after the fact.** A supplied restricted item freezes the authorizing
  grant id(s) into its application trust snapshot (`disclosureGrantIds`), alongside the provenance and
  freshness facts from Part B. *Principle: every restricted disclosure carries, in its immutable
  record, the exact authorization that permitted it.*
- Enforcement lives in the ONE shared assessment: `assessKnowledge` already withholds when
  `disclosure === 'restricted' && !disclosurePermitted`; the selector now computes `disclosurePermitted`
  from live grants instead of a constant. Nothing else in the trust model changed.
- Locked by `knowledge-disclosure.test.ts` (no-grant→withheld · agent+purpose grant→disclosed+snapshot
  records id · wrong-purpose→withheld · both-agents-required · expired→no-grant · revoked→no-grant +
  history survives + double-revoke conflicts · only-restricted-accepts-a-grant · no-agent→never). RLS
  regression guard extended to the new table. Full suite **476/476**.

### Trustworthiness increment 3b — disclosure hardening: execution identity, explicit recipient, derived purpose (built 2026-07-26)

Three semantics that make the grant model sound rather than merely present. Reviewer's framing: a grant
targeting an agent is safe only if the agent's execution identity can't materially change while keeping
the same id; every restricted recipient must be explicit, not an accident of an empty array; and the
use-purpose must be derived from the operation, not asserted by a caller.

- **Grants bind to an immutable execution identity.** A grant now stores the agent's material execution
  FINGERPRINT at grant time (`agentExecutionFingerprint` over provider · model · systemPrompt ·
  temperature · maxOutputTokens · role — migration 0032). Selection authorizes a restricted item only
  when the consuming agent's CURRENT fingerprint still matches the grant's. Reconfiguring the agent's
  provider, model, or instructions changes the fingerprint and silently invalidates the old grant; a
  harmless display-name change does not (name is excluded). *Principle: disclosure authority follows the
  execution identity that was reviewed, not merely a reusable agent name.*
- **Every AI consumer has an explicit execution identity.** Objective suggestion runs AS its primary
  agent, so that agent is now passed as the consuming identity (it resolves the agent *before*
  selection). "No restricted Knowledge for a consumer with no agent" is thus an explicit model — the
  recipient is a named execution identity that may or may not hold a grant — not an accident of an empty
  array. *Principle: no identified recipient means no restricted disclosure.*
- **Purpose is derived from the operation, never supplied.** `KNOWLEDGE_PURPOSE_BY_CONSUMER` maps each
  consumer type to its one permitted `KnowledgeUseIntent` (`task_run → current_operational_fact`,
  `objective_suggestion → objective_planning`); `selectRelevantKnowledge` now takes `consumerType` and
  derives the purpose internally, rejecting an unknown/forged type. A task run can no longer relabel
  itself "historical analysis" to receive stale or disputed Knowledge under looser rules. The derived
  purpose is recorded on the AI operation (`ai_operations.knowledge_purpose`) and in the application
  snapshot. *Principle: operation type and configuration determine permitted Knowledge-use intents.*
- The application snapshot's `disclosureGrantIds` became `disclosureGrants` — per consuming agent:
  `{ grantId, agentId, executionFingerprint, provider, model, expiresAt }`. A historical application now
  shows the exact execution identity that received the Knowledge and the grant validity in force.
- Locked by `knowledge-disclosure.test.ts` (+ model-change-invalidates · provider-change-invalidates ·
  rename-preserves · forged-consumer-type-rejected, and the snapshot now carries the execution identity)
  and the updated provenance-selection/idempotency tests. Full suite **480/480**.

**Disclosure boundary CLOSED.** With execution-identity binding, explicit recipients, and derived
purpose enforced, the operational retrieval + disclosure path is defensible end to end. Selection order:
1. active current version → 2. disclosure permitted to *every* actual execution identity → 3. scope
permits possible applicability → 4. relevance established → 5. freshness/verification/provenance permit
the derived intended use → 6. eligible records ranked → 7. qualified evidence rendered → 8. exact
dispatch representation + trust decision recorded (immutable). *This closes provenance + disclosure for
the Knowledge review; the wider Knowledge trust model is NOT yet finished — the ingestion side is next.*

### Ingestion increment 4 — AI extraction & human promotion (built 2026-07-26)

The ingestion side of the trust model: how untrusted AI output *enters* the evidence system. Primary
question — *what claim is the AI proposing the workspace remember, what exact evidence supports it, and
what human judgment is required before it may be trusted or used?* Mirrors the Decision-extraction
integrity pattern (`decisions/extraction.ts`).

Boundary: **source material → AI-proposed claim → quarantined draft → human review → optional
activation → separate verification.** Extraction ≠ activation; activation ≠ verification; attaching a
source ≠ a support judgment; AI confidence ≠ authority.

- **Extraction proposes only, and is fail-safe.** `extractKnowledgeForRun` (module
  `knowledge/extraction.ts`) runs after a completed run — independent of decision extraction, its own
  `runs.knowledge_extraction_status` guard, its own durable `ai_operation` — mines the consolidated
  output through a fixed schema (`MAX_KNOWLEDGE_CANDIDATES = 3`), and any error is recorded + swallowed
  so the run is never affected.
- **Quarantine, hardcoded.** Each proposal inserts a `draft` / `unverified` / injection-ineligible
  `knowledge_item` (`source = promoted_context`), scoped to the NARROWEST actual (the originating task),
  with disclosure = the inherited (most-restrictive) classification. The AI can neither self-activate
  (`status` hardcoded) nor self-verify (`verification` hardcoded), nor record a support judgment.
- **Source integrity — exact version or nothing.** Every cited ref must resolve to a document in the
  run's context manifest; a fabricated/absent path invalidates the whole candidate, and a source-less
  candidate is rejected (schema `min(1)`). Each citation is bound to the document's EXACT `sha256` at
  extraction time, so it names the version the extractor saw — never "latest". *Principle: a citation
  is provenance only when it identifies the exact evidence used.*
- **Sensitivity is inherited, never laundered.** Documents gained a `disclosure` classification
  (migration 0033); a proposal's suggested disclosure is the most-restrictive over its cited sources —
  any restricted source ⇒ restricted proposal (draft actual disclosure already restricted). Promotion
  may tighten disclosure but **never loosen it below the inherited** (no v1 declassification authority).
  *Principle: derived Knowledge cannot launder the sensitivity of its sources.*
- **Suggested ≠ actual.** A companion `knowledge_proposals` row holds the AI's SUGGESTED values (scope,
  disclosure, temporal, confidence, reason) + extraction provenance (run, operation, provider/model,
  prompt version), physically separate from the item's actual columns.
- **Explicit structured promotion** (operator's choice): `promoteKnowledgeProposal` requires an explicit
  scope + temporal validity + disclosure + lifecycle decision — no one-click Accept that silently
  activates, verifies, broadens, or declassifies. A promoted proposal stays `unverified` until a
  separate support judgment (the existing Part-A path). `rejectKnowledgeProposal` preserves the proposal
  (archived draft + recorded reason), never deletes; re-reviewing a decided proposal conflicts.
- Granularity: materially-independent claims are separate candidates (prompt + per-candidate handling);
  an exact duplicate of an ACTIVE record is suppressed; near-duplicates/contradictions are left as
  distinct proposals to surface for review (never auto-merged).
- Locked by `knowledge-extraction.test.ts` (14): quarantined-draft · exact-version-frozen · fabricated
  ref rejected · no-source rejected · inherited-restricted · confidence-not-authority · suggested-vs-
  actual-scope · independent-claims-split · duplicate-suppressed · failure-doesn't-affect-run ·
  idempotent · explicit-promotion-activates-not-verifies · no-declassification · rejection-preserved.
  RLS extended to `knowledge_proposals`. Full suite **494/494**.

### Ingestion increment 4b — source-integrity hardening (built 2026-07-26)

Four corrections that make the citation trustworthy, not just present. The theme: a citation must name
the evidence the ORIGINATING run received, and only claims that can be checked against it may be kept.

- **Cite the run's evidence, not later document state.** The run now freezes an IMMUTABLE source
  snapshot at dispatch — `runs.retrieved_sources` (migration 0034): per supplied document the exact
  `sha256`, the disclosure classification in force, and the chunk `excerpt`, captured when context is
  assembled (retrieval now carries `sha256`+`disclosure` through `RetrievedChunk`). Extraction cites
  against THIS snapshot and never re-reads live documents; the cited version is the snapshot hash. A
  document that changes after dispatch cannot alter what a proposal cites — it only makes that version
  currently unavailable / a mismatch on resolution. *Principle: extracted Knowledge cites the evidence
  supplied to the originating operation, not whatever source version exists later.*
- **Validate locators/excerpts, drop invented precision.** A cited quote is persisted (as the source
  `locator`) only when it verifiably appears in the snapshot excerpt (whitespace-insensitive). A
  fabricated quote or an uncheckable page/section claim is dropped while the validated source
  relationship is retained. *Principle: a valid source reference does not validate every detail the
  model claims about that source.*
- **Operational, audited document classification.** `restrictDocument` (audited; refuses to loosen — no
  silent downgrade) and `declassifyDocument` (a distinct, reason-required, audited authority action)
  make the sensitivity anchor controllable. Extraction inherits the classification from the run
  SNAPSHOT, so a later reclassification never rewrites an existing proposal's inherited disclosure.
  *Principle: sensitivity inheritance is trustworthy only when source classification is itself
  controlled and auditable.* (The Documents authoring UI for this lands in the Documents review; the
  domain action + historical snapshot exist now.)
- **Explicit v1 source boundary.** Knowledge extraction v1 may cite ONLY document evidence supplied in
  the run. Any ref not in the document snapshot — a fabricated path, an artifact id, the run's own
  output — is rejected; the consolidated output is untrusted candidate-generation material, never
  evidence. Artifact-as-evidence is a deliberate future source-resolver increment.
- Reviewer support: `reviseKnowledgeProposalDraft` lets a pending proposal's claim be refined/narrowed
  before promotion (splitting is reviewer-driven: revise one, reject-and-re-propose the rest); promotion
  runs in one transaction, so configuration + activation cannot partially succeed.
- Bounded language (corrected): the extractor is *instructed* to propose one closely-related claim group
  per candidate, and the reviewer must split proposals whose claims need different trust assessments —
  the cap + prompt encourage bounded claims but do not *prove* semantic separation. Duplicate/
  contradiction handling stays conservative: exact-duplicate-of-active is suppressed deterministically;
  near-duplicates and different-claims-on-the-same-subject surface as distinct proposals; nothing is
  called a contradiction from title/subject similarity alone.
- Locked by the expanded `knowledge-extraction.test.ts` (19): snapshot-version-not-live · fabricated/
  artifact ref rejected · valid-quote-persisted vs fabricated-quote-dropped-source-kept · inherited
  restricted · revise-before-promotion / conflict-after · classification audited · declassification
  reason-required + authority-bearing · later-classification-change-doesn't-rewrite-proposal · plus the
  original quarantine/promotion invariants. Full suite **499/499**.

**Extraction & promotion CLOSED.** The ingestion path is defensible: propose-only, quarantined,
source-integrity-checked against the immutable run snapshot, sensitivity-inherited, human-promoted by
explicit decision, never self-verifying.

Extraction closure also added **proposal splitting** (`splitKnowledgeProposal`): a bundled proposal
becomes 2+ independently-reviewable drafts, each carrying the same extraction provenance and a chosen
subset of the original's sources at their exact versions; inherited disclosure is preserved and never
weakened; the original is retired `split` (archived, unpromotable) so only the children can be promoted;
nothing is activated or verified. *Principle: a record may be no broader than the trust assessment that
honestly applies to all its claims — and when it is, split before relying on it.*

### Conversation increment 5 — the operating-partner conversation (built 2026-07-26)

The *voice* of the trust model — it adds no trust logic; it translates the already-computed assessments
into accurate, proportionate language. Two layers (`knowledge/conversation.ts`), both PURE:

- **Layer 1 — `describeKnowledgeForConversation`** composes item + `assessKnowledge` + `assessKnowledge​Provenance`
  + verification count + disclosure decision + relevance + application count (+ optional superseded /
  proposal / asOf) into a structured descriptor. It makes ALL eleven reasoning answers available;
  invents no confidence, re-resolves nothing, and derives the conversational **category from the FULL
  assessment** — a gate (disclosure / dispute / stale / draft) wins over epistemic basis, so an
  "observed" record can still be withheld. `currentUseVerdict` mirrors the shared assessment;
  `historicalUseVerdict` is derived from *why* current use was refused (a structural gate denies every
  use; a current-fact-only concern is fine, qualified, for history).
- **Layer 2 — renderers by audience + depth.** `renderOperatorSummary` (routine: claim + key
  qualification + date, not an 11-field dump), `renderOperatorEvidence` (deep, with per-source
  resolution — progressive disclosure), `renderHistoricalAudit` (speaks the past for superseded/
  historical records), and `renderAiQualification` — the ONLY AI-facing text, which returns **null**
  for a denied or withheld record *before reading any content*, so denied content is absent, never
  redacted-after.

Honesty guarantees enforced and tested: eleven answers are available, not mandatory (depth scales with
consequence); AI consumers receive nothing about a denied restricted record (not even its existence),
while an authorized operator may receive a bounded withholding reason; application language is
**"supplied"**, never "used"/"influenced"; **no Decision relationship is inferred** — the descriptor
states "No authoritative Decision relationship is recorded" until an explicit link exists (that link is
future work, not built inside the adapter); a long free-text body is flagged `possibly_multiple` rather
than given one misleading verdict; source-supported verification and current inspectability are reported
separately. Locked by `tests/unit/knowledge-conversation.test.ts` (14). Full suite **514/514**.

**Conversation-build corrections (built 2026-07-26):**
- **Historical use is its OWN assessment, not inferred.** The descriptor now takes `currentAssessment`
  AND `historicalAssessment` (each `assessKnowledge` run with its own intended use + its own consumer
  disclosure decision); `historicalUseVerdict` = the historical assessment's verdict, never a mapping of
  current-refusal reasons. A draft stays withheld in both modes; restricted-without-a-historical-grant
  stays withheld; stale is withheld-current yet qualified-historical — each because its own assessment
  says so. *Principle: alternative use is established by a separate trust assessment, not inferred from
  why another use was denied.*
- **Audience visibility precedes rendering.** `describeKnowledgeForConversation` takes `operatorAccess`;
  for a restricted record the viewer may not inspect, it returns a REDACTED descriptor directly (claim
  null, sources empty, only a bounded withholding reason) — the sensitive fields are absent, not stripped
  by a downstream renderer. `visibility.operator` ∈ full / metadata_only / withholding_only / none; the
  renderers refuse to reveal content the visibility state forbids. *Principle: audience-specific
  rendering begins with audience-specific data visibility.*
- Locked by 5 more unit tests (draft-withheld-both · restricted-withheld-both · verdicts-match-their-own
  assessment · authorized-operator-inspects · unauthorized-operator-gets-reason-only-content-absent).
  Full suite **519/519**. **Operating-partner conversation CLOSED.**

### Surface increment 6 — Knowledge Portfolio & Detail (built 2026-07-26)

Both pages render from ONE aggregator (`knowledge/portfolio.ts`) that turns each record into the shared
conversation descriptor — so the Portfolio, the Detail, and the selector cannot disagree. No new trust
classification; it reuses `assessKnowledge` (current AND historical) / `assessKnowledgeProvenance` /
disclosure / `describeKnowledgeForConversation`.

- **`buildKnowledgePortfolio`** — canonical, mutually-exclusive groups by lifecycle + current usability:
  `awaiting_review` (drafts + pending proposals), `available` (active, usable), `use_with_qualification`
  (active, qualified), `needs_review` (active but withheld for a non-freshness reason), `historical`
  (archived / superseded / stale / scope-closed). A cross-cutting **Needs-Review lens** references
  canonical records carrying evidence-backed concerns (review_due · provenance_broken ·
  invalid_or_closed_scope · disputed · possibly_multiple_claims · restricted_no_disclosure_path) — it
  does not duplicate cards.
- **`buildKnowledgeReference`** — one record's descriptor for the Detail surface.
- **Portfolio page**: groups + lens; each reference shows formation · verification · freshness ·
  provenance · disclosure · "supplied to N operations" — Available never reads as verified.
- **Detail page**: the evidence conversation in sections (claim + multi-claim caution · current/
  historical verdict · formation · provenance with relied/supplemental · verification stated separately
  from provenance · freshness · scope/relevance · disclosure · AI application/dispatch history ·
  extraction/promotion for proposals · "No authoritative Decision relationship is recorded"). Only
  implemented actions are surfaced (revise/activate/archive); promotion/split/support-judgment/grant/
  declassify controls are flagged as domain-ready, UI follow-on.
- **Shared surface integrity** locked by `knowledge-portfolio.test.ts` (3): canonical grouping across
  the representative states; the Detail verdict never contradicts the Portfolio group; the selector
  injects Available/Qualified relevant records and never a Needs-Review one, matching the Portfolio.
  Full suite **522/522**, build clean.

**Knowledge trust ARCHITECTURE is implemented end to end** (not yet the complete product — see closure):
create/propose → relevance-gated selection → evidence-not-directive rendering → shared assessment →
durable/idempotent ops → live-resolved provenance → enforceable disclosure (execution identity + derived
purpose) → AI extraction/promotion with source integrity → the operating-partner conversation →
Portfolio & Detail, all reading one assessment.

### Surface increment 6b — Portfolio/Detail closure corrections (built 2026-07-26)

- **Needs-Review is a lens, not a selection gate.** The selector never depended on the Portfolio (it
  only reads `assessKnowledge`); the earlier *test/report* framed the invariant wrongly. Corrected: the
  ASSESSMENT governs selection — withheld → not selected, qualified → selectable-with-qualification,
  Needs-Review membership alone neither permits nor prohibits. Proven by tests where a review-due record
  is in the lens AND selected, a disputed record is withheld by its assessment, and a restricted record
  the Portfolio shows as Needs-Review IS selected for an agent that holds a live grant. *Principle:
  surfaces share judgment; operational systems do not depend on presentation categories.*
- **Viewer access is resolved from the authenticated request, filtered at retrieval.** The aggregator
  derives `operatorAccess` from the viewer's role (`viewerMaySeeRestricted`: project admin / org
  owner-admin; deny-by-default); a non-privileged viewer's descriptor is built REDACTED (claim null,
  sources empty) — sensitive fields absent from the loader result, not hidden by the component. The
  Detail route branches on visibility before running the sensitive queries; direct navigation to a
  restricted URL yields only the bounded notice. Loader-boundary tests prove an admin sees content, a
  member never receives the title/body/source in the returned object, and the Portfolio doesn't leak
  restricted titles. *Principle: restricted data is filtered at retrieval, not merely hidden by the
  rendered component.*
- **Detail shows the frozen dispatch snapshot vs current.** `listInjectionsForKnowledge` now returns the
  immutable `trustSnapshot`; the Detail's application history shows dispatch-time provenance alongside
  current, and the exact rendered text — never reconstructing the past from today's record. A test
  proves a source breaking after dispatch leaves the frozen snapshot `inspectable_support` while current
  resolution reads `broken`.
- **Core review actions wired.** Server actions + client forms for the review queue: AI proposals →
  promote (explicit scope/temporal/disclosure/lifecycle; suggested values shown as placeholders only),
  revise, split, reject-with-rationale, and record-source-support-judgment; active records → confirm /
  mark-disputed (reason required) and new-version / archive. The forms preserve every distinction
  (promotion ≠ verification, activation ≠ verification, attaching a source ≠ support, split children stay
  drafts, rejection preserves the record). Document classification is linked to Documents; disclosure
  grants to Governance — a restricted record is never a dead end. Full suite **527/527**, build clean.

**Detail route-loader + non-admin boundary proof (built 2026-07-26):** the Detail page's data loading is
now one gated function, `loadKnowledgeDetail` (`knowledge/detail.ts`): it resolves visibility FIRST and,
for a record the viewer may not see, returns `{ visible: false }` and never runs the item / application /
source queries — so direct navigation to a restricted detail URL cannot return sensitive data in the
payload (denied content is absent, not component-hidden). Exercised with a REAL non-admin identity (a
project `member` ctx) in `knowledge-portfolio.test.ts`: admin → full content; member → bounded notice
only, no `ref`/`applications`/`sources` keys and no restricted strings in the serialized payload; a
non-restricted record IS visible to the member (access is per-record). Full suite **530/530**.

**Portfolio visual-pass corrections (built 2026-07-26):** copy no longer overclaims universal
consultation ("Active Knowledge is *considered* when the Hub assembles context for relevant AI work");
the add-knowledge form no longer silently activates (activate defaults OFF, labelled "as a human
assertion; this does not verify the claim"); Needs-Review renders concise references (title + specific
concern sentence), not duplicated cards; a broken *supplemental* source reads "some supplemental sources
unavailable" (distinct from a broken *relied* source); restricted records report their INSTITUTIONAL
grant state ("disclosure grant on file" vs "no usable grant") rather than being flattened by the
operator page having no consuming agent — a granted restricted record is configured, not a concern;
awaiting-review proposals show "awaiting review" + "originating task is closed (affects suggested
scope)" instead of reading as archival; Historical records keep their specific reason (Expired / Rejected
/ Split into replacement proposals / Superseded / Inactive—scope closed / Archived); qualification copy
softened ("no review date recorded"); the workspace-internal default and the zero-application state are
no longer chipped. Locked by portfolio tests (restricted-with-grant configured; specific historical
reasons). Full suite **532/532**. *Portfolio re-pass + full Detail visual pass still required.*

### ★ KNOWLEDGE CLOSED (2026-07-27)

All six closure conditions met: (1) Needs-Review is a lens, not a selector gate ✓; (2) selection
independent of Portfolio grouping ✓; (3) authenticated viewer access enforced at the data boundary,
exercised by automated route-loader tests with a real non-admin identity ✓; (4) core review controls
wired (promote/split/revise/reject/support-judgment; confirm/dispute; activate/archive) ✓; (5) seeded
authenticated VISUAL acceptance — Portfolio + all four representative Detail pages passed on staging
(operator verdict "Clean"; the Detail pages were also driven and read back through the logged-in
session) ✓; (6) full suite **536/536** + build clean ✓. During the visual pass one real defect was
caught and fixed (a blunt archive left AI proposals in Awaiting because `groupOf` checked pending
before archived — archived is now authoritative, and the archive script rejects pending proposals).
The 15-state `[demo]` matrix (tag ab20) was archived after acceptance. Knowledge visual-corrections copy
tweaks (universal-consultation, honest activation, concise lens, supplemental vs relied wording,
institutional grant state, awaiting≠historical, specific historical reasons, softened qualification,
no zero-application boilerplate) all confirmed live.

**The Knowledge trust ARCHITECTURE and its operator surfaces are complete end to end.** Deferred
follow-ons (not blockers, tracked for their own areas): richer split/support-judgment pickers;
disclosure-grant management UI (Governance); document classification authoring UI + artifact-as-evidence
(Documents); explicit Decision↔Knowledge link semantics.

*Deferred follow-ons (explicitly not built): the newer action controls' UI (promote/split/support-
judgment/restrict/declassify/grant-revoke forms); Decision↔Knowledge link semantics; the Documents
classification authoring UI + artifact-as-evidence. Interactive staging visual acceptance of the two
pages remains to be walked through with an authenticated session.*

---

## AREA: Documents (source-material system) — IN PROGRESS

Primary question: *what source material does this workspace possess, which exact version was used, and
can the Hub inspect and disclose it safely?* Documents preserves evidence; it does not judge truth.
Accepted sub-area sequence: (1) immutable version model → (2) version chunks + current retrieval →
(3) run/Knowledge relationships on version ids → (4) retention/purge safeguards → (5) classification
controls → (6) Detail + reverse trail → (7) viewer access → (8) retrieval/locator/dedup/deletion
hygiene → (9) visual acceptance. Building the version model FIRST; no Documents interface yet.

### Sub-area 1 — immutable versions, STAGE A: additive schema + migration (built 2026-07-27)

The provenance-critical restructure is delivered in verified stages. **Stage A** is purely additive
(migration 0035) — nullable columns + empty new tables, no behavior change, safe to run while current
ingestion/retrieval keep working:
- `documents` becomes the LOGICAL source (+ `current_version_id` — a successfully-indexed version only,
  no hard FK to avoid the documents↔versions cycle; + `last_seen_at`). Old content columns retained
  during the transition, dropped only in a later migration after dual-read verification.
- **`document_versions`** (immutable): sha256, size, mime, `object_key` (content-addressed), 
  `content_fidelity` (`byte_exact` | `reconstructed_text` | `unavailable`), source revision/modified,
  ingested/indexed timestamps, `index_status` (`pending`|`indexed`|`failed`), error, `disclosure_snapshot`
  (classification at ingest, never rewritten), parser version, ingestion-operation id. Unique
  `(document_id, sha256)` = same-content idempotency. A failed version is retained but never current.
- **`document_chunks`** gains `document_version_id` (+ locator, parser version, content hash) — chunks
  belong to a version; a new version makes new chunks, never replacing an old version's.
- **`run_document_versions`** (normalized run→version references) — the referentially-safe complement to
  the immutable JSON `runs.retrieved_sources`; `onDelete: restrict` from the version so a referenced
  version can't be purged. Unique `(run_id, document_version_id, chunk_index)`.
- **`knowledge_sources`** gains `document_version_id` (durable pointer; null = artifact or a legacy
  overwritten citation that resolves "version unavailable", never rebound by path).
- `RunSourceSnapshot` gains optional `documentVersionId`. RLS extended to both new tables.
Applied locally, build clean, full suite **536/536** (no behavior change yet). *Principle: a Document
identifies the source; a Document Version identifies the evidence.*

### Sub-area 1 — immutable versions, STAGE B: object storage + dual-write ingestion (built 2026-07-27)

**Stage B** makes versions real WITHOUT switching retrieval or backfilling — every new observed source
state is now retained as an immutable version alongside the unchanged legacy index:
- **Version service (`versions.ts`)** — the one narrow path that writes versions: reads the exact bytes
  once, hashes them, retains them under the content-addressed key `org/{o}/project/{p}/doc/{documentId}/
  {sha256}`, parses the SAME bytes into version chunks (each with its own content hash + `chunk-v1` parser
  tag), marks the version `indexed`, and repoints `current_version_id` — atomically, in the caller's
  tenant transaction. Same content → `reused` (no new version/chunks/object; only `last_seen_at` moves).
  Changed content → a new immutable version + a new object. A parse failure keeps the version (bytes +
  error) but never makes it current. `setCurrentVersion` is the only writer of the pointer and refuses a
  version that is not `indexed`, not the same document, or not the same workspace.
- **`ensureObject`** — head→get→verify: an existing object with the right hash is reused (idempotent
  across a crash/retry between the object PUT and the DB commit); an object at the same key holding
  different bytes is a `conflict` and is never overwritten.
- **Dual-write wiring** — local `refreshIndex` and the cloud worker `indexCloudDocument` both keep their
  legacy null-version chunk write (replaced wholesale, scoped so version chunks are untouched) and then
  dual-write the version from the same bytes. The version write is best-effort during the transition
  (logged, never fatal to the legacy index). Archival (folder disappearance / `archiveDocument`) now drops
  only null-version chunks, so evidence a citation/run relied on survives the source vanishing.
- **Transition guard** — `retrieveRelevant` / `selectCoreReferences` / `selectProductionStatus` filter
  `document_version_id IS NULL`, so version chunks CANNOT leak into retrieval before the Stage C2 switch.
- **DB backstops (rls.sql)** — `document_versions_immutable` trigger blocks any change to the content-
  identity facts and any non-terminal index-status revert; `document_versions_byte_exact_has_object` CHECK
  forbids `byte_exact` without a retained object.
Applied locally, tsc + build clean, full suite **558/558** (+22 Stage B: exact-byte retention, chunk-hash
correspondence, same-hash reuse, changed→new version, earlier-version immutability, current-pointer
integrity across document/workspace/status, key-collision safety, failed-parse retention, no retrieval
leak, crash-retry idempotency, folder disappearance/reappearance, trigger + CHECK enforcement). Retrieval
is byte-for-byte the same as before. *Principle: historical prompt snapshots preserve representation;
normalized references preserve integrity.*

*Stages remaining in sub-area 1: C1 — backfill existing documents into versions + an audit of fidelity
(cloud object hash-verification; legacy local → reconstructed_text; overwritten citations →
version-unavailable); C2 — shadow-read validation then the current-vs-historical retrieval switch +
evidence version-pointers + resolveKnowledgeSource by version; D — purge safeguards + viewer access at
retrieval + the full 35-test set. Then report the full increment-1 completion. Backfill and the retrieval
switch do NOT start until Stage B is reviewed.*

### Sub-area 1 — immutable versions, STAGE C1: backfill + fidelity audit + reference reconciliation (built 2026-07-27)

**Stage C1** populates the version model for pre-Stage-B (and any missed-dual-write) documents and audits
integrity — WITHOUT switching retrieval, deleting legacy columns, purging orphans, rewriting historical
prompt JSON, or building UI. It is restart-safe and reconciles rather than duplicating.
- **Backfill service (`backfill.ts`)** — per-workspace `backfillProject`: baseline inventory → per-document
  version backfill → evidence-reference reconciliation → integrity/orphan audit → the dual-write
  completeness gate, returning one structured `ProjectBackfillReport`.
- **Fidelity, honestly classified** — `byte_exact` ONLY when raw bytes are readable, hash-verified against
  the recorded document hash, AND retained under the immutable version key (cloud object re-verified;
  local file re-read + hashed). A readable local path whose bytes DON'T match the recorded hash is NOT
  claimed as the legacy version — it becomes `reconstructed_text` from the retained chunks and the changed
  bytes are deferred to normal ingestion. `reconstructed_text` when exact bytes can't be verified but
  legacy chunks preserve inspectable text; `unavailable` (terminal, no preview, never current) when
  neither bytes nor chunks remain. A transient cloud read error is a *retryable defect*, never mislabeled
  unavailable.
- **Chunks copied, never moved** — version chunks are COPIES of the legacy null-version chunks (ordering,
  text, indexes, locator preserved; parser + content-hash added). The null-version set is never touched,
  so legacy retrieval is byte-for-byte unchanged. Migration is idempotent and repairs a partial crash.
- **Conservative current pointers** — a backfilled current is assigned only to an indexed version of an
  active document; `byte_exact` and (transitionally) chunk-backed `reconstructed_text` may be current;
  `unavailable` never is. No valid version ⇒ pointer left unset + a recorded defect (never a silent
  substitution).
- **Evidence reconciliation** — `knowledge_sources.documentVersionId` bound only on an exact
  (org, project, path, hash, single-candidate) match; path-only / hash-mismatch / ambiguous / cross-
  workspace stay unresolved with a reason. Normalized `run_document_versions` rows created from
  `runs.retrieved_sources` only on exact resolution — one version-level row (`chunk_index = -1` sentinel,
  which already gives working uniqueness for chunk-less references) plus per-chunk rows, idempotent. The
  immutable run JSON is never rewritten.
- **Audit, report-only** — byte_exact objects re-hashed; missing/invalid objects, orphan version chunks,
  current-pointer invariant breaks, and orphan storage objects (via a new read-only `ObjectStore.list` —
  local dir-walk + S3 ListObjectsV2 through a backward-compatible SigV4 query extension) are all reported,
  never deleted. The **dual-write completeness gate** counts active-indexed documents with vs. without a
  valid current version — C2 may not begin until that unresolved-active count is zero (or each exception
  is explicitly accepted).
- **Restart-safe runner (`scripts/backfill-document-versions.ts`, `npm run backfill:document-versions`)** —
  stable per-project operation identity via the `ai_operations` idempotency key; each project's
  reconciliation report persisted to its operation row, the aggregate emitted. A rerun reuses versions,
  objects, migrated chunks, and references — no duplicates.
tsc + build clean, full suite **585/585** (+27 C1 tests). No retrieval switch; no columns dropped; no
orphans purged. *Principle: a currently-readable path is not evidence of the earlier indexed state unless
its bytes match the recorded hash.*

**Stage C1 review corrections (2026-07-27).** Applied before closure:
- **Active ⇒ retrievable.** New principle: *a Document cannot be operationally active unless the Hub has a
  valid current version it can retrieve.* A backfill that yields only an `unavailable` version now moves
  the logical Document from `active` to the explicit `source_unavailable` lifecycle state (identity,
  expected hash, adapter/path, audit, and all relationships preserved) — retrieval excludes it by
  lifecycle, not by an undocumented migration exception.
- **Reconnection.** When the source is reachable again, normal ingestion creates a new `byte_exact`
  version and restores the Document to `active`, preserving the immutable `unavailable` version + the
  disconnection history — no manual recreation. Enabled by a **partial unique index**
  (`(document_id, sha256) WHERE content_fidelity <> 'unavailable'`, migration 0036) + ingestion skipping
  `unavailable` placeholders on its reuse check, so a real version can coexist with the placeholder even
  at the same hash.
- **Count reconciliation.** Distinct, unambiguous counters (total version rows after; created by
  fidelity; existing reused split into indexed vs unavailable; docs with no version row vs docs with a
  version but no current pointer; docs source-unavailable) and split idempotency outcomes (skipped
  already-reconciled, duplicate version/chunk/run-ref/knowledge-bind avoided) — no opaque "duplicates".
- **Legacy objects reclassified.** The pre-version filename-keyed cloud objects are RETAINED
  *legacy superseded object candidates* (still referenced by `documents.object_key`), not disposable
  orphans; they stay through shadow-read, the retrieval switch, and the rollback window. The orphan scan
  now treats both `documents.object_key` and version keys as referenced, so true orphans = referenced by
  neither.
- **Reverse-trail dedup (`references.ts`).** A run that cited a version via a version-level (`-1`) row +
  chunk rows counts as ONE run in a version's reverse trail; retention treats either relationship as
  sufficient (purge stays blocked after dedup).
tsc + build clean, full suite **593/593** (+8 review tests: active-requires-current, unavailable excluded
from retrieval, unavailable preserves identity/no-preview, reconnection creates byte_exact + restores
active, reconnection preserves the unavailable row, fidelity counts = real rows, no-version vs no-current
counted separately, reverse-trail dedup).

### Sub-area 1 — immutable versions, STAGE C2: versioned retrieval + shadow + controlled switch (built 2026-07-27)

**Stage C2** builds a separate current-version retrieval path, validates it against legacy in shadow, and
puts the authoritative choice behind a per-workspace flag — no UI, no purge, no legacy deletion.
- **Pre-C2 DB guard (migration 0037).** A second partial unique index on `(document_id, sha256) WHERE
  content_fidelity = 'unavailable'` — so a concurrent/defective writer cannot create duplicate unavailable
  placeholders. Net invariant: ≤1 unavailable placeholder + ≤1 retained version per (doc, hash), coexisting.
- **Versioned retrieval (`retrieval-versioned.ts`).** Version-aware equivalents of every document read:
  start from active docs, join ONLY through `documents.current_version_id`, require the current version
  `indexed`, read ONLY that version's chunks, re-assert org/workspace + indexed on every row, and return
  the `documentVersionId`, version hash, fidelity, index status, chunk content-hash and locator.
  Structurally excludes pending/failed/unavailable versions and archived/source-unavailable docs. *Principle:
  every retrieved Document excerpt belongs to an explicitly identified immutable version* — never inferred
  from the hash after selection. **Deterministic tie-break** (stable identity + chunk index) added to BOTH
  paths (item 3), so tied scores never truncate a different top-N.
- **Shadow comparison (`shadow.ts`).** Runs both paths independently, normalizes into a shared, text-free
  comparison contract (ids + hashes + scores + disclosure only — a report is never a disclosure channel),
  and classifies every difference: exact_match / expected_exclusion / legacy_defect_corrected /
  versioned_defect / unresolved. Read-only: writes no evidence, mutates nothing. The switch is clear only
  at 0 versioned_defect + 0 unresolved; source-unavailable docs are enumerated as named exclusions.
- **Retrieval-mode flag (`retrieval-mode.ts`, `projects.retrieval_mode`, enum migration 0038).** Server-
  authoritative per-workspace mode `legacy | shadow | versioned`, never client-supplied. `assembleDocument
  Sources` dispatches the runner's relevant→core→production assembly on the authoritative path; shadow mode
  compares non-authoritatively with bounded instrumentation (a shadow error never breaks the legacy request
  and writes nothing).
- **Post-switch evidence (`writeRunVersionEvidence`).** Under versioned mode the run's `RunSourceSnapshot`
  carries `documentVersionId`, and normalized `run_document_versions` (version-level `-1` + chunk-level) are
  written in the SAME transaction that creates the run, BEFORE dispatch — a successful run can never end
  with a prompt excerpt but no durable version relationship. Idempotent; reverse trails dedup to one run.
  (`run_document_versions.rank` widened to `real` for the ts_rank score — migration 0039.)
- **Rollback.** The flag returns a workspace to legacy; legacy chunks/columns/objects stay intact; a mode
  switch never rewrites historical run snapshots; versioned runs keep their version ids after rollback.
- **Scripts.** `npm run shadow:retrieval` (per-workspace corpus: one query per retrievable doc + generics,
  reports classification + expected exclusions) and `npm run set:retrieval-mode` (audited per-workspace
  rollout).
tsc + build clean, full suite **615/615** (+22 C2 tests covering all 32 required cases). Retrieval default
stays `legacy`. No columns dropped, no legacy objects deleted, no purge.

**Stage C2 review corrections (2026-07-27).** Applied before closure:
- **Disclosure authorization enforced INSIDE versioned retrieval (Blocker 1).** A restricted Document's
  content now reaches an AI consumer only when every consuming agent holds a live, fingerprint-matched
  grant for the operation's server-derived purpose. New `document_disclosure_grants` (migration 0040, the
  document analogue of the Knowledge grants, reusing the same generic grant-resolution primitive);
  `disclosure.ts` (`resolveDocumentAccess` from a server-derived consumer context — never client-supplied).
  The versioned SQL excludes unauthorized restricted Documents (`disclosure <> 'restricted' OR id ∈
  authorized`), so their text/snippets/locators/labels/object keys are **never materialized** — they don't
  cross the retrieval boundary. The runner derives consumers (primary + reviewer) and purpose (`task_run` →
  `current_operational_fact`) itself. *Principle: a retrieval operation must not return sensitive content
  to a consumer unless that consumer is authorized to receive it.* 10 access tests (workspace-internal
  allowed; cross-workspace empty; restricted withheld without a grant; returned with the exact grant;
  wrong-purpose / wrong-fingerprint / expired / revoked all denied; no text/snippet/locator on denial;
  forged consumer id creates no authorization).
- **Evidence commits before dispatch (Blocker 2).** Confirmed the runner boundary: `preflight` is ONE
  transaction — freeze context → insert run → immutable snapshot (with `documentVersionId`) → normalized
  `run_document_versions` → COMMIT — and provider dispatch (`executeRun`) runs only after it returns. A
  test drives a failing normalized-reference insert and proves the run transaction rolls back and the
  post-commit dispatch is never reached. *Principle: evidence supplied for an attempted operation stays
  inspectable even when provider execution fails, but the system must never imply successful use.*
- **Tie-break reclassified (Correction 1).** Recorded honestly as a *legacy defect corrected*:
  non-deterministic ordering AND selection at equal-score top-N boundaries. Prior behavior: legacy had no
  tie-break, so at the result limit equal-ranked candidates could truncate a different top-N. Contract: a
  stable tie-break by (`relativePath`, `chunkIndex`) after relevance score, applied to BOTH paths, so the
  selected set + order are identical and repeatable. Regression test 18b covers the top-N boundary.
- **Shadow statistics completed (Correction 2).** The report now carries per-retrieval-function and
  overall latency (median + p95, legacy vs versioned, absolute + % overhead), a `shadowErrors` count, and
  unambiguous denominators (`legacyResultPositions` + `versionedResultPositions` = `comparedPositions`).
tsc + build clean, full suite **627/627** (+12: 10 access checks, 2 evidence-boundary, 1 tie-break
regression; C2 test 12 adjusted to the enforced withhold behavior). `empera-international` may remain
versioned (its access path withholds restricted); `accuratebids-com` stays legacy.

### Sub-area 1 — immutable versions, STAGE D: evidence system — historical retrieval, viewer access, purge, integrity (built 2026-07-27)

**Stage D** closes the evidence-system responsibilities so Increment 1 can end — no UI, no legacy deletion,
no auto-purge. *Primary question: can the Hub retrieve the exact historical evidence requested, show it only
to an authorized party, and prevent institutional evidence from being destroyed?*
- **D1/D2 exact historical retrieval (`historical.ts`).** A resolver separate from current retrieval: given
  a version id / Knowledge-source / run-version / run-snapshot / legacy identity+hash, it returns THAT
  immutable version or a precise failure — `resolved | inaccessible | unavailable | missing |
  version_mismatch | unsupported | integrity_failure` — and **never substitutes a newer source**.
  Fidelity-aware: `byte_exact` re-verifies the object hash at retrieval (mismatch → integrity_failure) and
  serves exact bytes/hash/mime/chunks/locators; `reconstructed_text` serves qualified chunks with no
  download ("Reconstructed from indexed text; original source bytes were not retained."); `unavailable`
  exposes identity only, no preview.
- **D3/D4 viewer access (`viewer-access.ts`).** Human viewer authorization, **distinct from AI grants and
  never reusing them**: present access is decided by the CURRENT logical disclosure — the version and
  dispatch snapshots are historical facts, surfaced but not used to gate now (so declassification reopens
  inspection while history is unchanged; re-restriction gates it). Conservative v1: restricted inspection
  is owner/admin-only and audited. One gated decision fronts every direct path.
- **D5/D6 retention (`retention.ts`, tombstone migration 0041).** Archive ≠ purge. Purge is privileged +
  destructive and begins with a retention assessment that blocks on a current-version pointer, any
  institutional evidence (Knowledge citation, normalized run reference, or immutable run snapshot — the
  JSON scanned as a backstop), or a retention hold — returning a precise decision + blocking
  categories/counts (no restricted leak). Execution **re-checks inside the destructive transaction**,
  deletes chunks + the version row, deletes the object only when unshared, clears dangling pointers, and
  writes an immutable tombstone + audit. *Principle: purge authorization is a current judgment, not a
  reusable token.* The 56 legacy objects get a read-only cleanup assessment (all still referenced /
  rollback-required) — none cleaned.
- **D7/D8 integrity + evidence (`integrity.ts` + `historical.ts`).** A read-only audit over 16 defect
  categories with bounded, audited repairs (reverify object; rebuild chunks from exact bytes preserving
  identity+hash; restore a normalized run reference from the immutable snapshot) that never rewrite
  history. Evidence paths keep the two authorities distinct: the run snapshot is authoritative for the
  exact supplied prompt text, the retained version for the source evidence.
tsc + build clean, full suite **658/658** (+31 blocks covering the 40 required Stage D cases). No UI, no
legacy deletion, no auto-purge. **Stage D implementation deployed and staging acceptance exercised; final
closure pending review.**

**Stage D review corrections (2026-07-27).** Applied before closure:
- **Crash-safe two-phase purge (Blocker 1).** Object storage and Postgres can't share a transaction, so
  purge is now a restart-safe state machine. Phase 1 (one DB txn) locks the version + document `FOR
  UPDATE`, re-assesses, writes a tombstone with the assessment snapshot + status `object_cleanup_pending`
  (or `completed_object_retained_shared` if the object is shared, `completed` if none), deletes chunks +
  the version row, and commits — *database revocation is authoritative*. Phase 2 (after commit) reconfirms
  the object is unshared, deletes it, and marks `completed`; a failure keeps `object_cleanup_pending` with
  the error + attempt count for an audited retry — *object cleanup is restartable* and never claims false
  completion. Purge **never clears an evidence relationship or a valid current pointer** to manufacture
  eligibility — those block it (dangling pointers are integrity's job, not purge's).
- **Representation-safe chunk repair (Blocker 2).** A rebuild restores chunk content from the exact bytes
  ONLY when it reproduces the identical historical representation: the existing chunk rows are the expected
  manifest (indexes + content hashes + locators + parser version), and the reparse must match it exactly
  (same count + per-chunk hash). Otherwise nothing is mutated and the version is marked `index_degraded`
  (new column) — no manifest, a parser-version mismatch, or a manifest mismatch all degrade rather than
  rechunk. *Repair may restore an identical representation; it may not replace it with a new
  interpretation.*
- **Restricted viewer matrix + audit-on-release (Blocker 3).** One shared gated loader
  (`loadInspectableVersion`) fronts every direct path (preview / raw bytes / download / chunks / Knowledge
  provenance / run source). Owner + admin permitted, ordinary member denied, non-member denied WITHOUT
  revealing existence (identical bounded message), AI grants never authorize human access. The audit fires
  ONLY on an actual restricted-content release (not on a permission check), recording
  viewer/workspace/doc/version/access-type/purpose/policy — never the content.
tsc + build clean, full suite **678/678** (+20 blocks: 10 purge, 8 repair, 10 viewer). No UI, no legacy
deletion, no auto-purge.

### Documents interface — Portfolio foundation (built 2026-07-27)

Increment 1 of the Documents product surface (no Detail yet). *Primary question: what source material does
this workspace possess, which sources are usable now, and where does its evidence need attention?*
- **Shared assessment (`portfolio.ts` `assessDocument`)** — one pure function the Portfolio (and future
  Detail) consume; retrieval keeps its own contract and never depends on these presentation categories.
- **Canonical groups** (exactly one per doc): **Available** (active + valid indexed current version — a
  restricted/reconstructed doc, or one with a *newer failed* version, stays Available) · **Processing** ·
  **Unavailable** (source-disconnected / initial-indexing-failed / unsupported — distinct reasons) ·
  **Historical** (archived; versions + evidence retained).
- **Attention lenses** (cross-cutting, never a lifecycle/retrieval rule): needs-attention, restricted,
  referenced-by-knowledge, supplied-to-ai, multiple-versions, recently-changed, integrity-concern.
- **Audience-safe loader (`loadDocumentPortfolio`)** — verifies membership; DROPS restricted docs for a
  non-owner/admin viewer BEFORE assessment, and every count is computed from the audience-visible set only.
  Bounded bulk queries (no N+1, no object I/O). Knowledge counts use explicit bound relationships;
  AI-operation counts dedupe to distinct runs. *Principle: audience-specific inventory is calculated from
  audience-visible records.*
- **Honest wording** — operator state labels replace raw enums; fidelity reads "Exact source retained /
  Reconstructed indexed text / Source content unavailable"; header reframed; "Refresh index" → "Refresh
  linked folder" with the host caveat; zero counts + hashes/ids omitted from compact rows.
- **Actions** stay compact + server-gated (upload/link/refresh; per-row retry/replace/archive from the
  assessment). No purge/repair/historical/classification/Detail in this increment.
tsc + build clean, full suite **693/693** (+15 Portfolio blocks covering the 26 required cases).

### ★ Documents Portfolio CLOSED (2026-07-27)

Accepted after three review corrections (all in `portfolio.ts` / `backfill.ts` / `documents.ts`):
- **Processing shows no false fidelity** — backfill no longer manufactures an `unavailable` version for a
  pending upload (`uploaded`/`queued`); "not yet indexed" ≠ "content unavailable".
- **Recently Changed = source change, not migration** — new `document_versions.source_change_at` (migration
  0043), set only by genuine ingestion (prefers the source's own modified time), NULL for backfilled
  versions. *Infrastructure migration does not imply that source material changed.*
- **Adapter-neutral archive + explicit restore** — `archiveDocument`/`restoreDocument` work for cloud AND
  local; `documents.archived_intent_at` (migration 0044) distinguishes an intentional archive (never
  silently restored by refresh) from an implicit disappearance-archive; `restore_requested_at` records an
  explicit local restore the next capable refresh completes. *Source adapters determine ingestion, not
  lifecycle.* Full suite 711/711.

### Documents interface — Detail, PART 1: shared audience-safe loader (built 2026-07-27, CLOSED)

`detail.ts` `loadDocumentDetail(tx, ctx, documentId, selectedVersionId?)` — a read-only view model that
COMPOSES the Stage D surfaces and decides access ONCE (`assessDocumentViewerAccess`; role-based, never an
AI grant); non-member / ordinary-member-vs-restricted get a bounded, existence-neutral denial. Distinct
current / selected / latest-observed / latest-successful facts; a historical selection resolves EXACTLY
(belongs-to-document + workspace) and never substitutes current; Knowledge relationships are `relied_upon`
(only where a support judgment recorded it) / `attached_not_judged` (never inferred supplemental); AI
operations dedupe by run with immutable dispatch provider/model from the PRIMARY `run_steps` row (never the
agent's current config, never the reviewer step); lifecycle history aggregates Document- and version-scoped
events + purge tombstones, deduped + deterministic + content-free. Bounded queries (no N+1).

### ★ Documents Detail PART 2 (read-only route + UI) CLOSED (2026-07-27)

The Detail page (`/p/[projectKey]/documents/[documentId]`) + gated evidence inspection, read-only (no
mutations). Canonical URL selects current; `?version=<id>` selects an exact historical version and is
preserved on refresh/share; missing/foreign/cross-workspace ids render a bounded "not available" with the
current version never substituted. Progressive disclosure for hashes/integrity/dispatch/audit metadata;
responsive shell (nav collapses to a Menu on mobile — the fixed sidebar previously overflowed at 390px).

**Restricted-release rule (invariant):** *Restricted document content and raw bytes may only be released
through a deliberate, origin-validated POST after authorization and exact-version resolution. Restricted
GET requests must fail before byte release and before release auditing.* Concretely: the Detail page GET
auto-releases only NON-restricted content; restricted PREVIEW is a Next.js server action (`detail-actions.ts`
`revealRestrictedVersionAction`, POST/CSRF); restricted DOWNLOAD is a same-origin POST on the download route
(`download/route.ts` — GET refuses restricted before any release/audit via `mayRelease()`, cross-origin POST
→ 403); non-restricted byte-exact keeps its authorized GET download. Restricted release is audited only on
success; responses are `private, no-store`; `Content-Disposition` filenames are ASCII-encoded.

Evidence: full suite **763/763**, tsc + build clean; authenticated Playwright (mobile 390×844 screenshots;
restricted GET→404/no-bytes, deliberate POST→exact bytes/attachment/no-store, cross-origin POST→403,
non-restricted GET download works); authenticated staging visual acceptance (current / historical /
unavailable / degraded / denied / knowledge-states / primary-vs-reviewer execution / lifecycle-history).
Deployed commits: Detail P1 `9d232b0` + corrections `93db383`; P2 route/UI `3e56305`, corrections `28558e0`,
mobile `dd9e0e7`, reveal server action `8486fad` (+ use-server fix `0be58cf`), restricted-download POST
`8ea56dc`. Staging fixtures cleaned back to the pre-fixture operational state (append-only audit history
preserved).

### ★ Documents Detail PART 3 (safe lifecycle actions) CLOSED (2026-07-27)

Six safe, server-gated lifecycle actions on the Detail surface — Restrict, Declassify, Archive, Restore,
Retry indexing, Replace cloud source. **No purge / integrity execution / repair.** Button visibility comes
from the SAME shared `assessDocument` the Portfolio uses; it is never authorization. Every action is a
server action (POST, origin/CSRF) that re-authenticates + re-checks admin authority, and the domain
functions re-check tenancy + lifecycle validity and audit ONLY on success.

Guardrails encoded: declassify REQUIRES a reason and only loosens a restricted source; restrict is
idempotent + can only tighten; classification changes never rewrite historical version/run disclosure
snapshots; `retryDocument` fails closed on a non-retryable state (cloud, failed/source_unavailable only);
`replaceDocument` is cloud-only and **fails closed on an archived source** — replacement is never an
alternate restore path, so `actions.replace=false` while archived and a directly-constructed archived
replacement is rejected before any object write / version / current-pointer change / audit (Restore is the
one way back to active). Archive/restore stay adapter-neutral with distinct audit identities and full
evidence preservation; a folder refresh never silently restores an intentionally-archived local source.

Evidence: full suite **777/777**; typecheck + build clean; authenticated staging acceptance across the
action matrix (active internal cloud → Restrict/Archive/Replace; after Restrict → Declassify/Archive/
Replace, mutation audited + re-assessed; failed cloud → +Retry; **archived cloud → Restrict/Restore, NO
Replace**; **archived local → Restrict/Restore only**); non-admin rejection proven by focused tests; the
no-silent-restore guarantee by the automated refresh test. Deployed commits: `dd3eb9f` (actions) +
`c2c5a66` (archive-intent + archived-local corrections). Fixtures cleaned back to the pre-fixture
operational state (append-only audit history preserved). **Documents Detail increment complete through the
read-only + safe-lifecycle surface; purge / integrity execution / legacy-object cleanup remain a later
increment.**

### ★ Documents Integrity — READ-ONLY AUDIT (built 2026-07-27, at gate)

The first of four SEPARATE, independently-gated maintenance capabilities (order: **integrity audit → repair
→ legacy-object cleanup → purge** — never one general maintenance console). A per-document, READ-ONLY
structural audit surfaced on Detail. `auditDocument` (`integrity.ts`) mirrors the canonical workspace
checks scoped to one document (object existence/hash/size, immutable version identity, current-pointer
validity/ownership/cross-tenant, chunk-manifest agreement, missing/orphaned chunks, duplicate versions,
unavailable-honesty, knowledge/run reference validity) and returns an HONEST result vocabulary —
**healthy / degraded / unavailable / partially_verified / audit_failed** — that never collapses "not
verified" (store unreachable → a limitation) into "failed", never labels an honestly-unavailable,
reconstructed, or intentionally-archived version as degraded, and keeps current-version health, historical
inspectability, and reference integrity as SEPARATE dimensions with exact-version attribution. It mutates
nothing. `runIntegrityAuditAction` (server action, POST/CSRF, admin-only, tenant-scoped) records ONE
append-only `document.integrity_audited` event on successful completion only. A distinct Detail "Integrity"
section shows recorded state + Run-audit + findings/limitations/per-version behind progressive disclosure;
**no repair control appears.** Evidence: 10 audit tests + full suite **787/787**, tsc + build clean;
authenticated staging acceptance (healthy → Healthy; missing-object → Degraded naming the exact version;
restricted → Healthy with NO content exposure and preview still gated; no repair control; Integrity section
distinct from Safe actions). Deployed `a3a5eb3`. Fixtures cleaned to the pre-fixture state (append-only
audit history preserved). **Next: Repair (bounded, representation-safe), then legacy-object cleanup, then
purge — each its own gate.**
