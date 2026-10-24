/**
 * Suggested quote prices (owner-approved 2026-10-23: "suggested prices approved"). Ops Chat may now put ITS OWN
 * estimates or researched prices into a draft quote — but only ones the owner has seen in the conversation, and every
 * line says where its price came from, so the confirm card makes the suggested ones impossible to miss.
 *
 * The AccurateBids payload schema is strict (and is what AccurateBids receives), so the labels never go into it: they
 * are split off here and stored beside the payload on the card. Pure, no imports — shared by server and browser.
 */

export type PriceSource = 'owner' | 'estimate' | 'research';
export type PricedSection = 'materials' | 'labor' | 'additional_charges';

export interface PricedLine {
  readonly section: PricedSection;
  readonly description: string;
  readonly source: PriceSource;
  /** For research: where the figure came from (site / page); for an estimate: the basis. */
  readonly note?: string;
}

const SECTIONS: readonly PricedSection[] = ['materials', 'labor', 'additional_charges'];
const SOURCES: ReadonlySet<string> = new Set(['owner', 'estimate', 'research']);
const MAX_NOTE = 200;

/**
 * Strip `source` / `source_note` from every line of a quote (so the strict payload schema accepts it) and return the
 * labels separately. A line with no (or an unknown) source is the owner's.
 */
export function splitPriceSources(quote: Record<string, unknown>): { cleaned: Record<string, unknown>; pricing: PricedLine[] } {
  const cleaned: Record<string, unknown> = { ...quote };
  const pricing: PricedLine[] = [];
  for (const section of SECTIONS) {
    const lines = quote[section];
    if (!Array.isArray(lines)) continue;
    cleaned[section] = lines.map((line) => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) return line;
      const { source, source_note: note, ...rest } = line as Record<string, unknown>;
      const src: PriceSource = typeof source === 'string' && SOURCES.has(source) ? (source as PriceSource) : 'owner';
      const n = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : '';
      pricing.push({
        section,
        description: typeof rest.description === 'string' ? rest.description : '',
        source: src,
        ...(n ? { note: n } : {}),
      });
      return rest;
    });
  }
  return { cleaned, pricing };
}

/** How many lines carry a price Ops Chat suggested (estimate or research) rather than the owner's own. */
export function suggestedCount(pricing: readonly PricedLine[] | undefined | null): number {
  return (pricing ?? []).filter((p) => p.source !== 'owner').length;
}
