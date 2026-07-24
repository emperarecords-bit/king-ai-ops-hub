# Executive Brief — the owner's memo to Claude at each sprint boundary

> The counterpart to `SPRINT-NN-REPORT.md`. I report up; this is how direction
> comes down. Copy §Template, fill it, send it. Everything in it is optional
> except §1 and §4 — but each section below notes **what it actually changes
> about how I work**, so you can spend words where they steer.

---

## What each section does operationally

| Section | What it changes |
|---|---|
| **1 · Sprint approval** | Gates the commit. "Approved" means I treat the sprint's work as baseline and stop revisiting it. "Changes requested" means I fix before building forward. |
| **2 · Key strategic observations** | Reweights my judgment on trade-offs I'd otherwise call by default. This is the section that has changed the product most (workforce framing, activity-vs-progress, relationships-not-facts). |
| **3 · Decisions made** | Closes open questions from my report. An unanswered decision keeps its stated default — silence is a choice, and I'll note which default it selected. |
| **4 · Direction for next sprint** | Sets scope. If you name a theme rather than features, I'll propose the features and you'll see them in the plan before I build. |
| **5 · Architectural guidance** | Constrains *how*, not *what*. Anything here I treat as binding and record in DECISIONS.md if it's durable. |
| **6 · Product philosophy** | Tie-breakers for the hundred small calls you'll never see. "Clarity over capability" resolved dozens of them. |
| **7 · New ideas / priorities** | Enters the roadmap as candidates, not commitments — I'll tell you what each would cost and what it would displace. |

**One request:** where you have a preference but not a decision, say so
explicitly ("lean toward X"). I can act on a lean; I can't act on silence,
and I'd rather not guess on your behalf.

---

## Template

```markdown
# Executive Response — Sprint NN

## 1. Sprint approval
[Approved / Approved with changes / Changes requested before proceeding]
[If changes: what specifically must be different, and whether it blocks the
next sprint or can run in parallel.]

## 2. Key strategic observations
[What you noticed — about the product, the market, your own usage, or the
work itself. This is where the most valuable input has historically come
from. Observations about what felt wrong are worth more than validations of
what felt right.]

## 3. Decisions made
[Answer the open questions from the report, by number where possible.
Deferrals are fine — say "defer, default stands" so I know it was seen.]

## 4. Direction for the next sprint
[A theme is enough. If you have a hard constraint — time, scope, "no new
surfaces" — say it here; it's more useful than a feature list.]

## 5. Architectural guidance
[Anything about how the system should be built or must not change. Silence
means "your judgment, within existing invariants."]

## 6. Product philosophy reminders
[Principles to weigh more heavily this sprint. Repetition is useful — these
decay without restatement.]

## 7. New ideas or priorities
[Anything you've been thinking about that isn't yet a plan. Marked as
candidate unless you say otherwise.]
```

---

## Draft for the current boundary (Sprint 10 → 11) — fill in the brackets

*Pre-filled with what my report established; the three `[DECIDE]` items are
genuinely open and I have not assumed answers.*

```markdown
# Executive Response — Sprint 10

## 1. Sprint approval
[Approved / …]

## 2. Key strategic observations
[e.g. how the Hub felt to use this week; whether the briefing is worth
opening; what you still take to a chat window instead.]

## 3. Decisions made
a) Objectives without success criteria — [DECIDE]
   (1) require ≥1 criterion · (2) allow zero but mark "unverifiable" and
   exclude from completion insights · (3) suggest criteria at creation ·
   (4) leave as-is
b) Flagship model — [DECIDE] move to verified gpt-5.4 ($2.50/$15) or keep
   delisted gpt-5.2 (price unverifiable)
c) Sprint 11 shape — [DECIDE] "let it run" validation vs. a build sprint

## 4. Direction for the next sprint
[Recommended: continue validation — real objectives with criteria, one piece
of standing work, weekly harvest, fix only what usage exposes.]

## 5. Architectural guidance
[Silence is fine here; invariants I1–I8 and D-001…D-016 remain binding.]

## 6. Product philosophy reminders
[Standing principles so far: clarity over capability · activity is not
progress · humans decide, AI recommends · insights not dashboards ·
relationships not isolated facts.]

## 7. New ideas or priorities
[Open candidates on the roadmap: Chief of Staff CoS-1 (designed, awaiting
data) · K2 knowledge promotion · Phase 3 executors · A1 job queue.]
```

---

## Related

[SPRINT-10-REPORT.md](SPRINT-10-REPORT.md) (current open decisions) ·
[OBSERVATIONS.md](OBSERVATIONS.md) (what real usage is showing) ·
[DECISIONS.md](DECISIONS.md) (durable decisions, D-001…) ·
[CHIEF-OF-STAFF.md](CHIEF-OF-STAFF.md) · [ROADMAP.md](ROADMAP.md)
