import 'server-only';
import { sql } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { log } from '@/lib/log';
import { getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { getObjectStore } from './object-store';
import { indexCloudDocument, SYSTEM_USER_ID } from './cloud';

/**
 * Durable document-indexing worker path (O-23), the exact shape of the run-job
 * worker (src/domain/jobs/jobs.ts): the one cross-tenant step — claiming the
 * next job — runs through a SECURITY DEFINER dispatcher (app.claim_next_document_
 * job), and indexing itself runs under withTenant() with the job's persisted
 * (org, project). Indexing is a SYSTEM operation (no human actor), so the tenant
 * context uses the nil user id; document RLS keys off (org, project) only.
 */

const LEASE_MS = 10 * 60 * 1000;

export interface ClaimedDocumentJob {
  jobId: string;
  documentId: string;
  orgId: string;
  projectId: string;
}

function firstRow<T>(result: unknown): T | undefined {
  const wrapped = (result as { rows?: T[] }).rows;
  if (Array.isArray(wrapped)) return wrapped[0];
  if (Array.isArray(result)) return (result as T[])[0];
  return undefined;
}

function systemCtx(orgId: string, projectId: string): TenantContext {
  return { userId: SYSTEM_USER_ID, orgId, projectId, orgRole: 'member', projectRole: 'admin' };
}

export async function claimNextDocumentJob(): Promise<ClaimedDocumentJob | null> {
  const result = await getDb().execute(sql`select * from app.claim_next_document_job(${LEASE_MS})`);
  const row = firstRow<{ job_id: string; document_id: string; org_id: string; project_id: string }>(result);
  if (!row) return null;
  return {
    jobId: String(row.job_id),
    documentId: String(row.document_id),
    orgId: String(row.org_id),
    projectId: String(row.project_id),
  };
}

async function finishJob(jobId: string, status: 'done' | 'failed', reason?: string | null): Promise<void> {
  await getDb().execute(sql`select app.finish_document_job(${jobId}, ${status}, ${reason ?? null})`);
}

/** Execute a claimed document-index job. Idempotent; a retry never duplicates
 *  chunks (the index step replaces them wholesale in one tenant transaction). */
export async function runClaimedDocumentJob(job: ClaimedDocumentJob): Promise<void> {
  const ctx = systemCtx(job.orgId, job.projectId);
  const store = await getObjectStore();
  try {
    const result = await withTenant(ctx, (tx) => indexCloudDocument(tx, ctx, store, job.documentId));
    // 'failed' inside the tx already set the document status; reflect on the job.
    await finishJob(job.jobId, result.status === 'active' ? 'done' : 'failed', result.status);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown indexing error';
    await finishJob(job.jobId, 'failed', reason);
    log.error('document index job threw', { jobId: job.jobId, documentId: job.documentId, reason });
  }
}

export interface DocReconcileResult {
  requeued: number;
}

/** Startup reconciliation: a job whose lease expired (worker died mid-index) is
 *  requeued. Indexing is idempotent, so re-running is safe. */
export async function reconcileStaleDocumentJobs(): Promise<DocReconcileResult> {
  const result = await getDb().execute(sql`select * from app.list_stale_document_jobs()`);
  const wrapped = (result as { rows?: unknown[] }).rows;
  const stale = (Array.isArray(wrapped) ? wrapped : (result as unknown[])) as Array<{ job_id: string }>;
  let requeued = 0;
  for (const s of stale) {
    await getDb().execute(sql`select app.requeue_document_job(${s.job_id})`);
    requeued += 1;
  }
  return { requeued };
}
