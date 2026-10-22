import type { ReactNode } from 'react';

/**
 * A deliberately SMALL markdown renderer for untrusted model output: the run-result excerpt in an Ops Chat completion
 * reply and the task page's Answer tab (Hub prod 2026-10-22: both showed raw `###`, `**`, `*   ` and `>` —
 * readable only to a developer).
 *
 * Safe by construction: it builds React elements from text (React escapes every string), never injects raw
 * HTML (the env-hygiene test forbids the raw-HTML prop anywhere in src), renders NO links or images ([text](url) shows only its text — the URL is dropped, so
 * untrusted output cannot plant a clickable link), and supports only headings, bullet / numbered lists, quotes,
 * fenced code, bold, italic and inline code. Anything else is shown as the plain text it is.
 */

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; items: { depth: number; text: string; ordered: string | null }[] }
  | { kind: 'code'; text: string };

export function parseExcerptBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i += 1; // closing fence (or end of a cut-off excerpt)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: 'heading', text: h[1]!.replace(/\s+#+\s*$/, '') });
      i += 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) q.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ kind: 'quote', lines: q });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: { depth: number; text: string; ordered: string | null }[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i]!)) {
        const m = LIST_ITEM.exec(lines[i]!)!;
        items.push({ depth: Math.min(3, Math.floor(m[1]!.replace(/\t/g, '    ').length / 2)), ordered: /\d/.test(m[2]!) ? m[2]! : null, text: m[3]! });
        i += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^\s*```/.test(lines[i]!) &&
      !/^\s{0,3}#{1,6}\s/.test(lines[i]!) &&
      !/^\s{0,3}>/.test(lines[i]!) &&
      !LIST_ITEM.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    blocks.push({ kind: 'para', text: para.join('\n') });
  }
  return blocks;
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|!?\[[^\]\n]*\]\([^)\n]*\)|\*[^*\s\n][^*\n]*\*|_[^_\s\n][^_\n]*_)/g;

/** Inline formatting → React nodes. Links and images keep only their text. */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (tok.startsWith('**') || tok.startsWith('__')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k++} className="rounded bg-[var(--background)] px-1">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('[') || tok.startsWith('![')) out.push(tok.replace(/^!?\[([^\]]*)\]\([^)]*\)$/, '$1'));
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const SIZE = {
  xs: { body: 'space-y-1.5 text-xs', heading: 'pt-1 text-[13px] font-semibold', code: 'max-h-40 text-[11px]' },
  sm: { body: 'space-y-2 text-sm', heading: 'pt-2 text-base font-semibold', code: 'max-h-96 text-xs' },
} as const;

export function SafeMarkdown({ text, size = 'sm', testId = 'safe-markdown' }: { text: string; size?: keyof typeof SIZE; testId?: string }) {
  const z = SIZE[size];
  return (
    <div data-testid={testId} className={`break-words leading-relaxed ${z.body}`}>
      {parseExcerptBlocks(text).map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return <p key={i} className={z.heading}>{renderInline(b.text)}</p>;
          case 'para':
            return <p key={i} className="whitespace-pre-wrap">{renderInline(b.text)}</p>;
          case 'quote':
            return (
              <blockquote key={i} className="border-l-2 border-[var(--border)] pl-2 text-[var(--muted)]">
                {b.lines.map((l, j) => <p key={j}>{renderInline(l)}</p>)}
              </blockquote>
            );
          case 'list':
            return (
              <ul key={i} className="space-y-0.5">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-1.5" style={{ paddingLeft: `${it.depth * 0.9}rem` }}>
                    <span aria-hidden className="text-[var(--muted)]">{it.ordered ?? '•'}</span>
                    <span>{renderInline(it.text)}</span>
                  </li>
                ))}
              </ul>
            );
          case 'code':
            return (
              <pre key={i} className={`overflow-auto whitespace-pre-wrap rounded bg-[var(--background)] p-2 font-mono ${z.code}`}>
                {b.text}
              </pre>
            );
        }
      })}
    </div>
  );
}
