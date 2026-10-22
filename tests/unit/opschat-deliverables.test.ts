import { describe, expect, it } from 'vitest';
import { allStems, briefDeliverables, deliverablesNotFound, notFoundHeadings, notFoundSentence } from '@/domain/opschat/deliverables';
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
    expect(notFoundHeadings(ds, found)).toEqual(deliverablesNotFound(BRIEF, RESULT));
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
