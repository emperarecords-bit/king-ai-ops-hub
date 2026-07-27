'use client';

import { useActionState } from 'react';
import {
  archiveDocumentAction,
  linkFolderAction,
  refreshIndexAction,
  replaceDocumentAction,
  restoreDocumentAction,
  retryDocumentAction,
  uploadDocumentsAction,
  type DocumentsState,
} from './actions';

const initial: DocumentsState = { error: null, message: null };

const btn =
  'rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50';
const field =
  'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]';

function Note({ state }: { state: DocumentsState }) {
  if (state.error) {
    return (
      <p role="alert" className="mt-2 rounded bg-[#3a2026] px-3 py-2 text-sm text-[var(--danger)]">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p className="mt-2 rounded bg-[#1f3a2a] px-3 py-2 text-sm text-[var(--success)]">
        {state.message}
      </p>
    );
  }
  return null;
}

export function LinkFolderForm({
  projectKey,
  currentPath,
}: {
  projectKey: string;
  currentPath: string | null;
}) {
  const [state, action, pending] = useActionState(linkFolderAction, initial);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <label htmlFor="folderPath" className="block text-sm text-[var(--muted)]">
        Local folder path
      </label>
      <input
        id="folderPath"
        name="folderPath"
        defaultValue={currentPath ?? ''}
        placeholder="C:\\Users\\you\\Documents\\my-business"
        className={field}
      />
      <button type="submit" disabled={pending} className={btn}>
        {pending ? 'Linking…' : currentPath ? 'Update folder' : 'Link folder'}
      </button>
      <Note state={state} />
    </form>
  );
}

export function RefreshIndexButton({ projectKey }: { projectKey: string }) {
  const [state, action, pending] = useActionState(refreshIndexAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="projectKey" value={projectKey} />
      <button type="submit" disabled={pending} className={btn}>
        {pending ? 'Reading folder…' : 'Refresh index'}
      </button>
      <Note state={state} />
    </form>
  );
}

const smallBtn =
  'rounded-md border border-[var(--border)] px-2 py-1 text-xs font-medium hover:border-[var(--accent)] disabled:opacity-50';

/** Cloud upload (O-23): admin uploads one or more Markdown/text files into the
 *  current workspace. The worker indexes them; no local machine required. */
export function UploadForm({ projectKey }: { projectKey: string }) {
  const [state, action, pending] = useActionState(uploadDocumentsAction, initial);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <label htmlFor="files" className="block text-sm text-[var(--muted)]">
        Upload Markdown or text files (.md, .markdown, .txt)
      </label>
      <input
        id="files"
        name="files"
        type="file"
        multiple
        accept=".md,.markdown,.txt,.text,text/markdown,text/plain"
        className={`${field} file:mr-3 file:rounded file:border-0 file:bg-[var(--accent)] file:px-3 file:py-1 file:text-[#0b0e14]`}
      />
      <button type="submit" disabled={pending} className={btn}>
        {pending ? 'Uploading…' : 'Upload files'}
      </button>
      <Note state={state} />
    </form>
  );
}

/** Per-document quick actions, driven by the shared Document assessment (which computed lifecycle
 *  validity). Archive and restore are adapter-neutral (cloud or local); retry and replace are cloud-only
 *  ingestion capabilities. The server actions re-check authorization + lifecycle — these buttons never
 *  bypass gating. */
export function DocumentRowActions({
  projectKey,
  documentId,
  source,
  actions,
}: {
  projectKey: string;
  documentId: string;
  source: string;
  actions: { retry: boolean; replace: boolean; archive: boolean; restore: boolean };
}) {
  const [retryState, retry, retrying] = useActionState(retryDocumentAction, initial);
  const [archiveState, archive, archiving] = useActionState(archiveDocumentAction, initial);
  const [replaceState, replace, replacing] = useActionState(replaceDocumentAction, initial);
  const [restoreState, restore, restoring] = useActionState(restoreDocumentAction, initial);
  const isCloud = source === 'cloud_upload';
  const anyAction = actions.retry || actions.replace || actions.archive || actions.restore;

  const hidden = (
    <>
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="documentId" value={documentId} />
    </>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.retry ? (
        <form action={retry}>
          {hidden}
          <button type="submit" disabled={retrying} className={smallBtn}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </form>
      ) : null}
      {actions.restore ? (
        <form action={restore}>
          {hidden}
          <button type="submit" disabled={restoring} className={smallBtn}>
            {restoring ? 'Restoring…' : 'Restore'}
          </button>
        </form>
      ) : null}
      {actions.archive ? (
        <form action={archive}>
          {hidden}
          <button type="submit" disabled={archiving} className={smallBtn}>
            {archiving ? 'Archiving…' : 'Archive'}
          </button>
        </form>
      ) : null}
      {actions.replace ? (
        <form action={replace} className="flex items-center gap-1">
          {hidden}
          <input
            name="file"
            type="file"
            accept=".md,.markdown,.txt,.text"
            className="w-32 text-xs file:mr-1 file:rounded file:border-0 file:bg-[var(--border)] file:px-1 file:text-xs"
          />
          <button type="submit" disabled={replacing} className={smallBtn}>
            {replacing ? '…' : 'Replace'}
          </button>
        </form>
      ) : null}
      {!anyAction ? <span className="text-xs text-[var(--muted)]">{isCloud ? '—' : 'local folder'}</span> : null}
      {[retryState, restoreState, archiveState, replaceState].map((s, i) =>
        s.error ? (
          <span key={i} role="alert" className="text-xs text-[var(--danger)]">
            {s.error}
          </span>
        ) : s.message ? (
          <span key={i} className="text-xs text-[var(--success)]">
            {s.message}
          </span>
        ) : null,
      )}
    </div>
  );
}
