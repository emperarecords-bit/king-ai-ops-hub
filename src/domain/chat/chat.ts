import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { agents, conversations, messages, tasks } from '@/db/schema';
import { createTask } from '@/domain/tasks/tasks';
import { enqueueRun } from '@/domain/jobs/jobs';
import { getAssignableAgentById } from '@/domain/agents/agents';

/**
 * Employee Chat (EV-004) — talk to an employee like texting, while every
 * exchange remains an ordinary, fully-governed task/run underneath.
 *
 * Shape: one standing conversation per (workspace, employee). Each owner
 * message becomes a task pinned to that employee whose INPUT is a bounded
 * transcript window plus the new message, so the employee remembers the
 * conversation without the engine needing multi-turn support. The task runs
 * through the normal queue: same budgets, same approval gates, same audit.
 *
 * Message rows serve two audiences and are told apart by run_id:
 *   * run_id IS NULL  → a CLEAN owner chat message, written here at send time
 *     (what the thread UI shows, and what the transcript is rebuilt from).
 *   * run_id NOT NULL → the runner's records: the full transcript-prompt user
 *     row and the employee's assistant reply. The thread shows only the
 *     assistant ones of these.
 */

/** Keep the rolling context bounded so a long-lived thread cannot grow unbounded cost. */
const TRANSCRIPT_WINDOW_CHARS = 8_000;
/** Task input hard cap is 32k (createTaskSchema); leave generous headroom. */
const MAX_CHAT_MESSAGE_CHARS = 8_000;

export interface ChatThreadEntry {
  readonly id: string;
  readonly role: 'owner' | 'employee';
  readonly content: string;
  readonly createdAt: Date;
}

export interface ChatThread {
  readonly conversationId: string | null;
  readonly agentId: string;
  readonly agentName: string;
  readonly entries: readonly ChatThreadEntry[];
  /** True while the latest exchange's task has not reached a terminal status. */
  readonly awaitingReply: boolean;
}

export async function getOrCreateConversation(tx: DbTx, ctx: TenantContext, agentId: string): Promise<string> {
  const existing = (
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.projectId, ctx.projectId), eq(conversations.agentId, agentId)))
      .limit(1)
  )[0];
  if (existing) return existing.id;
  const inserted = await tx
    .insert(conversations)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, agentId, createdBy: ctx.userId })
    .onConflictDoNothing()
    .returning({ id: conversations.id });
  if (inserted.length) return inserted[0]!.id;
  // Lost a concurrent race — the row now exists.
  const raced = (
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.projectId, ctx.projectId), eq(conversations.agentId, agentId)))
      .limit(1)
  )[0];
  return raced!.id;
}

/**
 * Pure: render prior thread entries into the bounded transcript block included
 * in the next task input. Most-recent-fitting-window, oldest dropped first.
 */
export function buildTranscriptWindow(entries: readonly Pick<ChatThreadEntry, 'role' | 'content'>[]): string {
  const lines = entries.map((e) => (e.role === 'owner' ? 'Owner: ' : 'You: ') + e.content);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = lines[i]!.length + 1;
    if (used + cost > TRANSCRIPT_WINDOW_CHARS) break;
    kept.unshift(lines[i]!);
    used += cost;
  }
  return kept.join('\n');
}

export function buildChatTaskInput(transcript: string, newMessage: string): string {
  if (!transcript) {
    return `The owner sent you this message in your ongoing conversation. Reply directly and conversationally — no headings, no preamble, just your reply.\n\nOwner: ${newMessage}`;
  }
  return `You are in an ongoing conversation with the owner. The transcript so far (oldest first; "You" is you):\n\n${transcript}\n\nThe owner's new message is below. Reply directly and conversationally — no headings, no preamble, just your reply.\n\nOwner: ${newMessage}`;
}

export interface SendChatMessageResult {
  readonly conversationId: string;
  readonly taskId: string;
}

/** Send one chat message: clean message row + transcript-window task + enqueued run, atomically. */
export async function sendChatMessage(
  tx: DbTx,
  ctx: TenantContext,
  input: { agentId: string; content: string },
): Promise<SendChatMessageResult> {
  const content = input.content.trim();
  if (!content) throw new ValidationError(['Message is empty.']);
  if (content.length > MAX_CHAT_MESSAGE_CHARS) {
    throw new ValidationError([`Message is too long (max ${MAX_CHAT_MESSAGE_CHARS} characters).`]);
  }
  const agent = await getAssignableAgentById(tx, ctx, input.agentId, 'primary');
  if (!agent) throw new ValidationError(['That employee is not an enabled primary agent in this workspace.']);

  const conversationId = await getOrCreateConversation(tx, ctx, agent.id);
  const thread = await loadThreadEntries(tx, ctx, conversationId);
  const taskInput = buildChatTaskInput(buildTranscriptWindow(thread), content);

  const taskId = await createTask(tx, ctx, {
    title: `Chat: ${agent.name}`,
    input: taskInput,
    providerSelection: agent.provider,
    reviewEnabled: false,
    modelTier: 'standard',
    flagshipCategory: null,
    objectiveId: null,
    scheduleId: null,
    conversationId,
    primaryAgentId: agent.id,
    reviewerAgentId: null,
  });

  // The CLEAN owner message (run_id null) — the thread's display + transcript source of truth.
  await tx.insert(messages).values({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    taskId,
    role: 'user',
    content,
  });

  await enqueueRun(tx, ctx, taskId);
  return { conversationId, taskId };
}

async function loadThreadEntries(tx: DbTx, ctx: TenantContext, conversationId: string): Promise<ChatThreadEntry[]> {
  const threadTasks = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.projectId), eq(tasks.conversationId, conversationId)));
  if (threadTasks.length === 0) return [];
  const taskIds = threadTasks.map((t) => t.id);
  const rows = await tx
    .select({ id: messages.id, role: messages.role, runId: messages.runId, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.projectId, ctx.projectId), inArray(messages.taskId, taskIds)))
    .orderBy(asc(messages.createdAt));
  return rows
    .filter((m) => (m.role === 'user' && m.runId === null) || m.role === 'assistant')
    .map((m) => ({
      id: m.id,
      role: m.role === 'user' ? ('owner' as const) : ('employee' as const),
      content: m.content,
      createdAt: m.createdAt,
    }));
}

/** Load the displayable thread for an employee (empty thread if no conversation yet). */
export async function loadChatThread(tx: DbTx, ctx: TenantContext, agentId: string): Promise<ChatThread> {
  const agent = (
    await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.projectId, ctx.projectId), eq(agents.id, agentId)))
      .limit(1)
  )[0];
  if (!agent) throw new ValidationError(['No such employee in this workspace.']);

  const conv = (
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.projectId, ctx.projectId), eq(conversations.agentId, agentId)))
      .limit(1)
  )[0];
  if (!conv) return { conversationId: null, agentId, agentName: agent.name, entries: [], awaitingReply: false };

  const entries = await loadThreadEntries(tx, ctx, conv.id);
  const latest = (
    await tx
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.projectId, ctx.projectId), eq(tasks.conversationId, conv.id)))
      .orderBy(desc(tasks.createdAt))
      .limit(1)
  )[0];
  const awaitingReply = latest != null && !['completed', 'failed', 'cancelled', 'superseded'].includes(latest.status);
  return { conversationId: conv.id, agentId, agentName: agent.name, entries, awaitingReply };
}

