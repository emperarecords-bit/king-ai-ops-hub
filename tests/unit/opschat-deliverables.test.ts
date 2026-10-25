import { describe, expect, it } from 'vitest';
import { allStems, briefDeliverables, deliverablesNotFound, notFoundHeadings, notFoundSentence, RESULT_HEADING_SQL_PATTERN, resultHeadings } from '@/domain/opschat/deliverables';
import { describeLinkedRun } from '@/domain/opschat/linked-run-view';
import { completionReplyLead } from '@/domain/opschat/conversation-continuity';

/**
 * "Finished" is not "complete". Fixture = Hub prod, server-cooling, read-only 2026-10-22: update task c6f6a923's brief
 * (numbered items 1–6) and run 2db706f8's 1,113-char punch list, which has no CFM / duct sizing, no open items and no
 * vendor material list.
 */

const BRIEF = `=== ORIGINAL INSTRUCTIONS ===
Using the attached "Server Cabinet Cooling Layout" plan (Rev F) as reference, draft a formal punch list for the revised design. Cover:
1. Clearances — manufacturer service/clearance requirements for each unit given the L-formation (original plan required 3' clearance).
2. Structural — design requirements for the NEW freestanding wall built specifically to carry two units.
3. Ductwork sizing — re-size or add supply/return duct runs (original single-unit spec: 26x12 supply, 28x14 return).
4. Control sequencing — update the failover logic into a lead-lag or parallel-run sequencing strategy.
5. Open items carried over — confirm Bard HR58AP specs (weight, opening sizes) x2 units.
6. Vendor-ready material list — compile a finalized material list formatted so it is ready to send to the HVAC vendor.
Output should be a clean, formally formatted punch list document.

=== OWNER DECISIONS SINCE THE PREVIOUS RUN (authoritative — recorded in the Hub) ===
- Question (answered 2026-10-20 12:51 UTC): 1. Lead-Lag or Parallel?
  Owner's answer: Lead-Lag (alternating)`;

const RESULT = `# Punch List: Dual FUSION-TEC Server Cooling (L-Formation)
## 1. Structural Requirements
- **Wall Design:** Freestanding, reinforced L-frame wall. Must accommodate the 1,400 lb combined load of two Bard HR58AP units.
## 2. Shared Ductwork (Shared Trunk)
*Constraint: Max height 18". Width flexible.*
- **Option A:** 36" x 16"
## 3. Mechanical & Controls
- **Sequencing:** Lead-Lag (alternating) logic via site controller.
## 4. Site Considerations
- **Clearances:** Maintain 3' clearance at gas meter.
## 5. Vendor
- **Installer:** Empera Air Conditioning and Heating (Internal).`;

describe('briefDeliverables', () => {
  it('reads the numbered list of the ORIGINAL INSTRUCTIONS only (headings before " — "), not later sections', () => {
    const ds = briefDeliverables(BRIEF);
    expect(ds.map((d) => d.heading)).toEqual(['Clearances', 'Structural', 'Ductwork sizing', 'Control sequencing', 'Open items carried over', 'Vendor-ready material list']);
    expect(ds.find((d) => d.heading === 'Vendor-ready material list')!.stems).toEqual(['vendo', 'ready', 'mater']); // "list" is a stopword
  });

  it('works on a one-paragraph brief and on "1)" / ":" forms', () => {
    expect(briefDeliverables('Do this: 1) Load calc: size it. 2) Duct options: three of them.').map((d) => d.heading)).toEqual(['Load calc', 'Duct options']);
  });

  it('no check when there is no clean numbered list (fewer than 2 items, or not 1, 2, 3 …)', () => {
    expect(briefDeliverables('Size the ducts for the server cabinet.')).toEqual([]);
    expect(briefDeliverables('1. Only one deliverable — here.')).toEqual([]);
    expect(briefDeliverables('Rev 3. Draft it. Rev 5. Again.')).toEqual([]);
  });
});

describe('deliverablesNotFound — the production fixture', () => {
  it('flags exactly what run 2db706f8 left out', () => {
    expect(deliverablesNotFound(BRIEF, RESULT)).toEqual(['Ductwork sizing', 'Open items carried over', 'Vendor-ready material list']);
  });

  it('a result that covers every heading → nothing flagged (stems match inflections: Controls ⊇ control)', () => {
    const full = `${RESULT}\nDuctwork sizing: 3,200 CFM. Open items carried over: none. Vendor-ready material list: attached.`;
    expect(deliverablesNotFound(BRIEF, full)).toEqual([]);
  });

  it('no brief list or no result → nothing to say', () => {
    expect(deliverablesNotFound('Just do it.', RESULT)).toEqual([]);
    expect(deliverablesNotFound(BRIEF, '')).toEqual([]);
    expect(deliverablesNotFound(BRIEF, null)).toEqual([]);
  });

  it('the SQL path (found stems) agrees with the in-memory path', () => {
    const ds = briefDeliverables(BRIEF);
    const lower = RESULT.toLowerCase();
    const found = new Set(allStems(ds).filter((s) => lower.includes(s)));
    expect(notFoundHeadings(ds, found, resultHeadings(RESULT))).toEqual(deliverablesNotFound(BRIEF, RESULT));
  });
});

/**
 * Hub prod 2026-10-24, run b7e7522e (read-only): a COMPLETE result was reported "not found" for all three items,
 * because every incidental word had to appear ("capacity", "unresolved", "needing", "component"). Its own sections are
 * "3. CFM Calculation & Duct Sizing Options", "7. Vendor Material List (Quantities)" and "8. Open Items (…)".
 */
const BRIEF_B7 = `=== ORIGINAL INSTRUCTIONS ===
Finalize the punch list and vendor quote prep. Deliver:
1. CFM calculation with 2–3 sizing options, each with tradeoffs (capacity, ductwork implications, cost/complexity)
2. A clear open-items list (anything still unresolved or needing owner input)
3. A vendor material list (units, ductwork, dampers, controls, structural components, etc. with quantities)

=== WHAT TO DO ===
Update the job.`;

const RESULT_B7 = `# Server Cabinet Cooling — Dual Bard FUSION-TEC Punch List & Vendor Quote Prep (Finalized)
## 2. System Design Summary
Clearances per manufacturer; two units, lead-lag.
## 3. CFM Calculation & Duct Sizing Options
**Load conversion:** 20 kW × 3.412 = **68,243 BTU/hr** (5.69 tons)
| Option | Design ΔT | CFM | Duct size (H×W) | Actual velocity | Tradeoffs |
## 7. Vendor Material List (Quantities)
| Item | Qty | Notes |
| Bard FUSION-TEC unit | 2 | wall-mount |
| Motorized damper | 2 | isolation |
| Lead-lag controller | 1 | 24-hr rotation |
## 8. Open Items (Owner / Field Input Still Needed)
1. Pick duct Option 1, 2 or 3.
2. Confirm exact model numbers.`;

describe('deliverablesNotFound — main words and section headings (run b7e7522e)', () => {
  it('main words come from the item heading before "(" or ","', () => {
    const ds = briefDeliverables(BRIEF_B7);
    expect(ds.map((d) => d.mainStems)).toEqual([['calcu', 'sizin', 'optio'], ['clear', 'open'], ['vendo', 'mater']]);
  });

  it('reads the result headings (markdown and whole-line bold), not table rows or body text', () => {
    expect(resultHeadings(RESULT_B7)).toEqual([
      '# Server Cabinet Cooling — Dual Bard FUSION-TEC Punch List & Vendor Quote Prep (Finalized)',
      '## 2. System Design Summary',
      '## 3. CFM Calculation & Duct Sizing Options',
      '## 7. Vendor Material List (Quantities)',
      '## 8. Open Items (Owner / Field Input Still Needed)',
    ]);
    expect(resultHeadings('**Bold heading**\r\nbody **not** a heading')).toEqual(['**Bold heading**']);
  });

  it('the complete result is no longer flagged', () => {
    expect(deliverablesNotFound(BRIEF_B7, RESULT_B7)).toEqual([]);
  });

  it('still flags an item whose main words are absent', () => {
    const noVendorList = RESULT_B7.replace(/## 7\. Vendor Material List[\s\S]*?(?=## 8\.)/, '');
    expect(deliverablesNotFound(BRIEF_B7, noVendorList)).toEqual(['A vendor material list (units, ductwork, dampers, controls, structural component']);
  });

  it('body match needs all main words AND at least three quarters of all words', () => {
    const ds = briefDeliverables(BRIEF_B7);
    const open = ds[1]!; // stems: clear, open, anyth, still, unres, needi, owner, input
    const has = (...s: string[]) => new Set(s);
    expect(notFoundHeadings([open], has('clear', 'open', 'anyth', 'still', 'owner', 'input'))).toEqual([]); // 6 of 8
    expect(notFoundHeadings([open], has('clear', 'open', 'anyth', 'still', 'owner'))).toEqual([open.heading]); // 5 of 8
    expect(notFoundHeadings([open], has('anyth', 'still', 'unres', 'needi', 'owner', 'input', 'clear'))).toEqual([open.heading]); // main "open" missing
  });

  it('the SQL path (found stems + headings) agrees with the in-memory path', () => {
    const ds = briefDeliverables(BRIEF_B7);
    const lower = RESULT_B7.toLowerCase();
    const found = new Set(allStems(ds).filter((s) => lower.includes(s)));
    expect(notFoundHeadings(ds, found, resultHeadings(RESULT_B7))).toEqual(deliverablesNotFound(BRIEF_B7, RESULT_B7));
  });

  it('the SQL heading pattern is the same expression as resultHeadings', () => {
    expect(new RegExp(RESULT_HEADING_SQL_PATTERN, 'gm').source).toBe(/^(#{1,6} [^\r\n]{1,200}|\*\*[^\r\n]{1,200}\*\*)\r?$/gm.source);
  });
});

describe('what the owner is told', () => {
  const missing = ['Ductwork sizing', 'Vendor-ready material list'];

  it('the linked-run sentence says "not found in the result", never that it is complete', () => {
    const v = describeLinkedRun({
      proposalId: 'p',
      taskId: 't',
      job: null,
      run: { id: 'r', status: 'completed', reviewOutcome: 'required_unmet', startedAt: new Date('2026-10-22T01:59:56Z'), finishedAt: new Date('2026-10-22T02:00:52Z'), resultChars: 1113, errorMessage: null, notFound: missing },
      pendingApprovals: 0,
    });
    expect(v.text).toContain('Not found in the result: "Ductwork sizing", "Vendor-ready material list" — it may be incomplete; check before relying on it.');
    expect(v.notFound).toEqual(missing);
    expect(notFoundSentence([])).toBe('');
  });

  it('the chat completion reply says it right after "finished"', () => {
    expect(completionReplyLead({ label: '"Server cooling"', resultLabel: 'UNREVIEWED DRAFT', excerpt: 'x', notFound: missing })).toBe(
      'Your request "Server cooling" has finished — it is an UNREVIEWED DRAFT (review was required but did not happen), so it is not final. Not found in the result: "Ductwork sizing", "Vendor-ready material list" — it may be incomplete; check before relying on it. Here\'s the start of what came back:',
    );
    expect(completionReplyLead({ label: '"X"', resultLabel: 'FINAL', excerpt: null })).toBe('Your request "X" has finished.');
  });
});
