import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { projectContextItems } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { AUTHORITY, type ContextItemForPrompt } from '@/orchestration/prompts';

/**
 * Repository content ingestion (Phase 6). Repo files are an INJECTION SOURCE (ROADMAP Phase 6, SECURITY.md T2),
 * so they enter the platform through two existing gates, never around them:
 *
 *  1. APPROVAL — an imported file lands as a `project_context_items` row with `status='pending'`. A human
 *     approves it before it can ever be offered to a run ("file tree and blob fetch into project context,
 *     subject to approval").
 *  2. UNTRUSTED WRAPPING — at prompt time every context item passes through `wrapUntrusted`
 *     (src/orchestration/prompts.ts), which strips forged delimiter tags and encloses the content in
 *     `<untrusted-context>` markers the system prompt declares to be data, never instructions.
 *
 * Nothing here calls GitHub — the caller supplies content it already fetched (in this phase, only tests can,
 * since the client fails closed without owner credentials).
 */

const MAX_REPO_FILE_BYTES = 256 * 1024;

const importSchema = z.object({
  repoFullName: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/, 'repository must be canonical owner/repo'),
  /** Commit SHA or branch the blob was read at — recorded in the title for provenance. */
  ref: z.string().trim().min(1).max(100),
  path: z
    .string()
    .min(1)
    .max(300)
    .refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => s === '' || s === '.' || s === '..'), {
      message: 'path must be repo-relative with no traversal segments',
    }),
  content: z.string().refine((c) => Buffer.byteLength(c, 'utf8') <= MAX_REPO_FILE_BYTES, {
    message: `file exceeds the ${MAX_REPO_FILE_BYTES}-byte import limit`,
  }),
});

export type ImportRepoFileInput = z.input<typeof importSchema>;

/** The provenance-carrying title an imported repo file gets, e.g. `github:acme/app@abc123:src/index.ts`. */
export function repoContextTitle(repoFullName: string, ref: string, path: string): string {
  return `github:${repoFullName}@${ref}:${path}`;
}

/**
 * Import one already-fetched repo file as a PENDING context item. It is not visible to any run until a human
 * approves it. Returns the new context-item id.
 */
export async function importRepoFileAsPendingContext(
  tx: DbTx,
  ctx: TenantContext,
  input: ImportRepoFileInput,
): Promise<string> {
  const parsed = importSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));
  const { repoFullName, ref, path, content } = parsed.data;

  const inserted = await tx
    .insert(projectContextItems)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      title: repoContextTitle(repoFullName, ref, path),
      content,
      status: 'pending', // the approval gate: never offered to a run until approved
      createdBy: ctx.userId,
    })
    .returning({ id: projectContextItems.id });
  const id = inserted[0]!.id;

  await writeAudit(tx, ctx, {
    action: 'github.file_imported',
    entityType: 'context_item',
    entityId: id,
    // Provenance only — never the file content (it is untrusted and may be large).
    detail: { repoFullName, ref, path, bytes: Buffer.byteLength(content, 'utf8'), status: 'pending' },
  });
  return id;
}

/**
 * Shape an (approved) repo file for prompt assembly. PROJECT_DOCUMENT authority: repo content is reference
 * material, never operational truth — and like every context item it is still untrusted-wrapped downstream.
 */
export function repoFileToContextItem(args: { repoFullName: string; ref: string; path: string; content: string }): ContextItemForPrompt {
  return {
    title: repoContextTitle(args.repoFullName, args.ref, args.path),
    content: args.content,
    authority: AUTHORITY.PROJECT_DOCUMENT,
    kind: 'GitHub repository file',
  };
}
