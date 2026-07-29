import { describe, expect, it } from 'vitest';
import {
  classificationRank,
  computeActivityClassification,
  isNonLive,
  resolveRecordClassification,
  resolveRunClassification,
  resolveUsageClassification,
} from '@/domain/classification/classification';

/**
 * HUB-009 — pure classification rules. Precedence seed > demo > live; effective classification is the
 * highest non-live among the sources; activity considers project + task + performer; the performer is
 * never reclassified. These helpers accept classifications ONLY — never a title/name/path/key — so they
 * cannot infer demo-ness from text.
 */

describe('HUB-009 classification precedence', () => {
  it('ranks seed > demo > live', () => {
    expect(classificationRank('seed')).toBeGreaterThan(classificationRank('demo'));
    expect(classificationRank('demo')).toBeGreaterThan(classificationRank('live'));
    expect(isNonLive('live')).toBe(false);
    expect(isNonLive('demo')).toBe(true);
    expect(isNonLive('seed')).toBe(true);
  });

  it('record: project classification dominates the child (a non-live project makes children non-live)', () => {
    expect(resolveRecordClassification('live', 'demo')).toEqual({ classification: 'demo', provenance: 'project' });
    expect(resolveRecordClassification('live', 'seed')).toEqual({ classification: 'seed', provenance: 'project' });
  });

  it('record: a live project may contain an explicitly demo/seed child', () => {
    expect(resolveRecordClassification('demo', 'live')).toEqual({ classification: 'demo', provenance: 'record' });
    expect(resolveRecordClassification('seed', 'live')).toEqual({ classification: 'seed', provenance: 'record' });
  });

  it('record: seed dominates demo; both live → live', () => {
    expect(resolveRecordClassification('demo', 'seed').classification).toBe('seed');
    expect(resolveRecordClassification('seed', 'demo').classification).toBe('seed');
    expect(resolveRecordClassification('live', 'live')).toEqual({ classification: 'live', provenance: 'record' });
    expect(resolveRecordClassification(null, undefined)).toEqual({ classification: 'live', provenance: 'record' });
  });
});

describe('HUB-009 activity (work-and-performer) classification', () => {
  it('a live agent performing a demo task creates demo activity (from the task)', () => {
    const eff = computeActivityClassification({ projectClassification: 'live', taskClassification: 'demo', performerClassifications: ['live', 'live'] });
    expect(eff).toEqual({ classification: 'demo', provenance: 'record' });
  });

  it('a demo agent performing a live task creates demo activity (from the performer)', () => {
    const eff = computeActivityClassification({ projectClassification: 'live', taskClassification: 'live', performerClassifications: ['demo', 'live'] });
    expect(eff).toEqual({ classification: 'demo', provenance: 'performer' });
  });

  it('seed anywhere dominates; all-live stays live', () => {
    expect(computeActivityClassification({ projectClassification: 'seed', taskClassification: 'demo', performerClassifications: ['live'] }).classification).toBe('seed');
    expect(computeActivityClassification({ projectClassification: 'live', taskClassification: 'live', performerClassifications: ['live', null] })).toEqual({ classification: 'live', provenance: 'record' });
  });
});

describe('HUB-009 run + usage resolution (snapshot vs legacy-derived)', () => {
  it('a run with a stored snapshot reads as snapshot provenance, ignoring current parents', () => {
    const eff = resolveRunClassification('demo', { projectClassification: 'live', taskClassification: 'live', performerClassifications: ['live'] });
    expect(eff).toEqual({ classification: 'demo', provenance: 'snapshot' });
  });

  it('a run with a null snapshot derives from current parents and is labelled legacy-derived', () => {
    const eff = resolveRunClassification(null, { projectClassification: 'live', taskClassification: 'demo', performerClassifications: ['live'] });
    expect(eff).toEqual({ classification: 'demo', provenance: 'legacy-derived' });
  });

  it('usage inherits its run snapshot; a run-less usage derives from the project (legacy-derived)', () => {
    expect(resolveUsageClassification('seed', { runSnapshot: 'live', projectClassification: 'live' })).toEqual({ classification: 'seed', provenance: 'snapshot' });
    expect(resolveUsageClassification(null, { runSnapshot: 'demo', projectClassification: 'live' })).toEqual({ classification: 'demo', provenance: 'legacy-derived' });
    expect(resolveUsageClassification(null, { projectClassification: 'seed' })).toEqual({ classification: 'seed', provenance: 'legacy-derived' });
    expect(resolveUsageClassification(null, { projectClassification: null })).toEqual({ classification: 'live', provenance: 'legacy-derived' });
  });
});
