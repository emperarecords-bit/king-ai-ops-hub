import { config as loadEnv } from 'dotenv';
// Secrets and DATABASE_URL live in .env.local locally; in the cloud they come
// from the environment, so loading a missing file is harmless.
loadEnv({ path: '.env.local' });
loadEnv();

import { claimNextJob, reconcileStaleJobs, runClaimedJob } from '../src/domain/jobs/jobs';
import {
  claimNextDocumentJob,
  reconcileStaleDocumentJobs,
  runClaimedDocumentJob,
} from '../src/domain/documents/document-jobs';

/**
 * Durable run worker (O-21). The process that actually executes queued runs in
 * the cloud — independent of any browser or terminal. On boot it reconciles
 * jobs orphaned by a previous crash, then polls the queue, claiming one job at
 * a time atomically and executing it through the ordinary gated run path.
 *
 * Run: `npm run worker`. Deploy as a separate long-lived service (see
 * DEPLOYMENT.md). Idle-polls; a real deployment can lower the interval or use
 * LISTEN/NOTIFY, but polling keeps the stack dependency-free.
 */

const IDLE_MS = 2_000;
let stopping = false;

async function loop(): Promise<void> {
  const recon = await reconcileStaleJobs();
  const docRecon = await reconcileStaleDocumentJobs();
  if (recon.requeued || recon.recovered || docRecon.requeued) {
    console.log(
      `worker: reconciled ${recon.requeued} run requeued, ${recon.recovered} recovered, ${docRecon.requeued} doc requeued`,
    );
  }
  console.log('worker: ready, polling for run + document jobs');

  while (!stopping) {
    let claimed = false;
    try {
      const job = await claimNextJob();
      if (job) {
        claimed = true;
        console.log(`worker: claimed run job ${job.jobId} (task ${job.taskId})`);
        const outcome = await runClaimedJob(job);
        console.log(`worker: run job ${job.jobId} → ${outcome?.status ?? 'recovered/failed'}`);
      }
      // Document-index jobs share the same worker; claim one per idle pass too.
      const docJob = await claimNextDocumentJob();
      if (docJob) {
        claimed = true;
        console.log(`worker: claimed document job ${docJob.jobId} (document ${docJob.documentId})`);
        await runClaimedDocumentJob(docJob);
        console.log(`worker: document job ${docJob.jobId} → done`);
      }
    } catch (err) {
      console.error('worker: loop error', err instanceof Error ? err.message : err);
    }
    if (!claimed && !stopping) await sleep(IDLE_MS);
  }
  console.log('worker: stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`worker: ${sig} received, finishing current job then exiting`);
    stopping = true;
  });
}

loop()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('worker crashed:', err);
    process.exit(1);
  });
