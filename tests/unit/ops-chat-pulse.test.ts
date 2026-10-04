import { describe, expect, it } from 'vitest';
import {
  needsYouCount,
  openingMessage,
  pulseContext,
  type OpsPulse,
} from '@/domain/opschat/pulse';
import { type WorkspaceBriefing } from '@/domain/briefing/briefing';
import { type OpenOwnerQuestion } from '@/domain/questions/questions';

/**
 * Ops Chat v1 pulse — pure formatter + count behavior. No DB, no provider, no
 * auth: these functions take a prepared pulse and must be deterministic.
 */

/** A WorkspaceBriefing with sane defaults; only the fields the pulse reads matter here. */
function ws(overrides: Partial<WorkspaceBriefing> & { projectKey: string; projectName: string }): WorkspaceBriefing {
  return {
    prepared: [],
    insights: [],
    pendingApprovals: 0,
    oldestPendingApprovalAt: null,
    runsCompleted: 0,
    runsFailed: 0,
    reviewInterventions: 0,
    objectivesAtRisk: 0,
    activeObjectives: 0,
    spentPct: 0,
    workingNow: 0,
    overall: 'healthy',
    outcome: null,
    ...overrides,
  } as unknown as WorkspaceBriefing;
}

function q(workspaceName: string, question: string): OpenOwnerQuestion {
  return {
    questionId: `q-${Math.random().toString(36).slice(2)}`,
    projectKey: workspaceName.toLowerCase(),
    workspaceName,
    askedBy: null,
    question,
    createdAt: new Date('2026-10-04T12:00:00Z'),
  };
}

function pulse(overrides: Partial<OpsPulse> = {}): OpsPulse {
  const workspaces = overrides.workspaces ?? [ws({ projectKey: 'accuratebids', projectName: 'AccurateBids' })];
  const openQuestions = overrides.openQuestions ?? [];
  const totals = overrides.totals ?? {
    pendingApprovals: 0,
    runsCompleted: 0,
    runsFailed: 0,
    reviewInterventions: 0,
    objectivesAtRisk: 0,
    workingNow: 0,
    budgetAlerts: 0,
  };
  return {
    displayName: 'Orville King',
    email: 'orville@accuratebids.com',
    greeting: 'Good morning',
    totals,
    openQuestions,
    workspaces,
    ...overrides,
  };
}

describe('Ops Chat pulse — needs-you count', () => {
  it('counts approvals + open questions together', () => {
    expect(
      needsYouCount(pulse({ totals: { ...pulse().totals, pendingApprovals: 3 }, openQuestions: [q('A', 'x'), q('B', 'y')] })),
    ).toBe(5);
  });

  it('is NOT a misleading approvals-only zero when only questions are waiting', () => {
    // The old page showed "Inbox (pendingApprovals)" = "Inbox (0)" here; the fixed count is 2.
    const p = pulse({ totals: { ...pulse().totals, pendingApprovals: 0 }, openQuestions: [q('A', 'x'), q('A', 'y')] });
    expect(p.totals.pendingApprovals).toBe(0);
    expect(needsYouCount(p)).toBe(2);
  });

  it('is zero only when nothing is waiting', () => {
    expect(needsYouCount(pulse())).toBe(0);
  });
});

describe('Ops Chat pulse — data minimization in model context', () => {
  it('pulseContext does NOT include the owner email', () => {
    const ctx = pulseContext(pulse({ email: 'orville@accuratebids.com' }));
    expect(ctx).not.toContain('orville@accuratebids.com');
    expect(ctx).not.toMatch(/@/); // no email address of any form leaves to the provider
  });

  it('pulseContext DOES include the owner display name (needed for natural address)', () => {
    expect(pulseContext(pulse({ displayName: 'Orville King' }))).toContain('OWNER: Orville King');
  });
});

describe('Ops Chat pulse — only the pulse workspaces appear (no leakage)', () => {
  it('pulseContext lists exactly the workspaces in the pulse and no others', () => {
    const ctx = pulseContext(
      pulse({
        workspaces: [
          ws({ projectKey: 'accuratebids', projectName: 'AccurateBids' }),
          ws({ projectKey: 'stressprobe', projectName: 'StressProbe' }),
        ],
      }),
    );
    expect(ctx).toContain('key=accuratebids');
    expect(ctx).toContain('key=stressprobe');
    expect(ctx).not.toContain('key=kodisnap'); // a workspace the owner was NOT given does not appear
  });

  it('open questions are attributed to their workspace only', () => {
    const ctx = pulseContext(pulse({ openQuestions: [q('AccurateBids', 'ship it?')] }));
    expect(ctx).toContain('[AccurateBids] "ship it?"');
  });
});

describe('Ops Chat pulse — deterministic opening (no model call)', () => {
  it('openingMessage is a pure function of the pulse (same input → same output)', () => {
    const p = pulse({ totals: { ...pulse().totals, pendingApprovals: 1 }, openQuestions: [q('AccurateBids', 'x')] });
    expect(openingMessage(p)).toBe(openingMessage(p));
  });

  it('surfaces the needs-you line from real counts, never inventing', () => {
    const p = pulse({ totals: { ...pulse().totals, pendingApprovals: 0 }, openQuestions: [q('AccurateBids', 'x'), q('AccurateBids', 'y')] });
    expect(openingMessage(p)).toContain('Needs you');
    expect(openingMessage(p)).toContain('2 questions');
  });

  it('reassures calmly when nothing needs the owner', () => {
    expect(openingMessage(pulse())).toContain('Nothing needs you right now');
  });
});
