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

*Next steps (deferred, not built, never presented as if they exist): the minimum provenance /
epistemic-basis / verification / freshness / scope / sensitivity model; presenting Knowledge as
evidence-not-directive in the prompt; an AI extraction/promotion path (propose-only, source-identified,
human-activated, never self-trusted); conflict/dispute surfacing; then the operating-partner
conversation across the representative states, and only then the Knowledge page redesign. Do not
redesign the page yet.*
