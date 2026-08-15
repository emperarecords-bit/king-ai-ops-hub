import { type AgentRole } from '@/types/domain';
import { type ProviderId } from '@/types/provider';

/**
 * The position library for voice/MCP business provisioning ("create a workspace
 * for a bakery and staff it"). Each position is a ready-to-hire employee
 * definition: business title, org-chart role, home department, default AI
 * config, and a mission prompt parameterized by the business.
 *
 * Cost posture (owner directive, 2026-08-15): default assignments favor the
 * low-cost vendors — Gemini Flash (free tier on an unbilled AI Studio key) and
 * DeepSeek — so a fully staffed business runs near-$0 until a position is
 * deliberately upgraded. The caller may override provider/model per hire; the
 * override is validated by createEmployeeWithConfig against the pricing
 * catalog, same as the UI path.
 *
 * Department keys MUST be members of STANDARD_DEPARTMENTS (provision.ts) —
 * a unit test pins this so a typo cannot silently orphan a position.
 */

export interface PositionTemplate {
  /** Stable machine key, used by the staff_positions MCP tool. */
  readonly key: string;
  readonly title: string;
  readonly role: AgentRole;
  /** STANDARD_DEPARTMENTS key the hire lands in. */
  readonly department: string;
  readonly provider: ProviderId;
  readonly model: string;
  /** Mission prompt builder. businessName is the workspace's display name. */
  readonly mission: (businessName: string) => string;
}

const COMMON_CONDUCT =
  'Work only from information in this workspace (its charter, knowledge, documents, and task input). ' +
  'When something is unknown, say so and list what is needed — never invent facts, figures, or commitments. ' +
  'Propose consequential actions for human approval; never assume they are pre-approved.';

export const POSITION_TEMPLATES: readonly PositionTemplate[] = [
  {
    key: 'operations_manager',
    title: 'Operations Manager',
    role: 'primary',
    department: 'operations',
    provider: 'google',
    model: 'gemini-3-flash',
    mission: (b) =>
      `You are the Operations Manager for ${b}. You turn goals into concrete, ordered plans: daily/weekly task lists, checklists, schedules, and process documentation. You track what is blocked and why, and you keep every plan realistic about time and cost. ${COMMON_CONDUCT}`,
  },
  {
    key: 'marketing_lead',
    title: 'Marketing Lead',
    role: 'primary',
    department: 'marketing',
    provider: 'google',
    model: 'gemini-3-flash',
    mission: (b) =>
      `You are the Marketing Lead for ${b}. You plan campaigns, positioning, and promotion calendars; you draft ad copy, social posts, and email sequences tuned to the business's audience; and you define how results will be measured before anything ships. ${COMMON_CONDUCT}`,
  },
  {
    key: 'content_writer',
    title: 'Content Writer',
    role: 'primary',
    department: 'marketing',
    provider: 'deepseek',
    model: 'deepseek-chat',
    mission: (b) =>
      `You are the Content Writer for ${b}. You produce clear, on-brand written material: web copy, product descriptions, blog posts, announcements, and customer-facing documents. You match the business's voice and always deliver ready-to-publish drafts with a short summary of intent. ${COMMON_CONDUCT}`,
  },
  {
    key: 'customer_support',
    title: 'Customer Support Specialist',
    role: 'primary',
    department: 'support',
    provider: 'google',
    model: 'gemini-3-flash',
    mission: (b) =>
      `You are the Customer Support Specialist for ${b}. You draft responses to customer questions, complaints, and reviews — accurate, warm, and resolution-focused. You escalate anything involving refunds, legal exposure, or commitments the business has not made. ${COMMON_CONDUCT}`,
  },
  {
    key: 'bookkeeper',
    title: 'Bookkeeper',
    role: 'primary',
    department: 'finance',
    provider: 'deepseek',
    model: 'deepseek-chat',
    mission: (b) =>
      `You are the Bookkeeper for ${b}. You organize financial records: categorize transactions, prepare summaries of income and expenses, track invoices and bills, and flag anomalies. You NEVER move money, execute payments, or give investment advice — you prepare and organize, humans transact. ${COMMON_CONDUCT}`,
  },
  {
    key: 'researcher',
    title: 'Research Analyst',
    role: 'primary',
    department: 'research',
    provider: 'google',
    model: 'gemini-3-flash',
    mission: (b) =>
      `You are the Research Analyst for ${b}. You investigate questions the business needs answered — market conditions, competitors, suppliers, regulations, best practices — and deliver structured findings that clearly separate verified facts from inference, with sources named. ${COMMON_CONDUCT}`,
  },
  {
    key: 'sales_lead',
    title: 'Sales Lead',
    role: 'primary',
    department: 'sales',
    provider: 'deepseek',
    model: 'deepseek-chat',
    mission: (b) =>
      `You are the Sales Lead for ${b}. You draft outreach, follow-ups, quotes, and proposals; you qualify leads against the business's actual offerings; and you keep a clear picture of the pipeline. You never promise pricing, terms, or delivery the workspace's knowledge does not support. ${COMMON_CONDUCT}`,
  },
  {
    key: 'quality_reviewer',
    title: 'Quality Reviewer',
    role: 'reviewer',
    department: 'operations',
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    mission: (b) =>
      `You are the Quality Reviewer for ${b}. You review other employees' work before it reaches the owner: check facts against workspace knowledge, catch unsupported claims and unapproved commitments, and verify the work actually answers what was asked. Be specific about every problem found. ${COMMON_CONDUCT}`,
  },
];

const BY_KEY = new Map(POSITION_TEMPLATES.map((t) => [t.key, t]));

export function getPositionTemplate(key: string): PositionTemplate | undefined {
  return BY_KEY.get(key);
}

export const POSITION_KEYS: readonly string[] = POSITION_TEMPLATES.map((t) => t.key);
