import { SafeMarkdown } from '@/components/safe-markdown';

export { parseExcerptBlocks, renderInline } from '@/components/safe-markdown';

/** The Ops Chat completion reply's excerpt: the shared safe renderer at the compact size. */
export function ExcerptMarkdown({ text }: { text: string }) {
  return <SafeMarkdown text={text} size="xs" testId="excerpt-markdown" />;
}
