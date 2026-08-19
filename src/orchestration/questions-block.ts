import { z } from 'zod';

/**
 * Ask-the-owner (TB-4 sibling of artifacts-block.ts; owner directive 2026-08-17: "is it eventually
 * gonna ask me about stuff like that?"). ANY employee's run may end with an `owner-questions`
 * block; each valid entry becomes an open question on the owner's Inbox at finalization. When the
 * owner answers, the answer is written into this workspace's knowledge — so asking is how an
 * employee closes their own knowledge gaps.
 *
 * Everything here is hostile until it survives the Zod parse: malformed entries are reported,
 * never repaired, and never fail the run.
 */

export const QUESTIONS_BLOCK_OPEN = '```owner-questions';
export const MAX_QUESTIONS_PER_RUN = 3;
export const MAX_QUESTION_CHARS = 1_000;

const questionSchema = z.string().trim().min(10).max(MAX_QUESTION_CHARS);

export interface QuestionExtraction {
  readonly questions: readonly string[];
  readonly rejected: readonly string[];
}

/** Last block wins (one consolidated ask per reply, like delegations). */
export function extractOwnerQuestions(modelText: string): QuestionExtraction {
  const rejected: string[] = [];
  const fenceStart = modelText.lastIndexOf(QUESTIONS_BLOCK_OPEN);
  if (fenceStart === -1) return { questions: [], rejected };

  const afterFence = modelText.slice(fenceStart + QUESTIONS_BLOCK_OPEN.length);
  const fenceEnd = afterFence.indexOf('```');
  if (fenceEnd === -1) {
    rejected.push('Unterminated owner-questions block.');
    return { questions: [], rejected };
  }
  const raw = afterFence.slice(0, fenceEnd).trim();
  if (raw.length === 0) return { questions: [], rejected };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    rejected.push('owner-questions block is not valid JSON.');
    return { questions: [], rejected };
  }
  if (!Array.isArray(parsed)) {
    rejected.push('owner-questions block must be a JSON array of strings.');
    return { questions: [], rejected };
  }
  if (parsed.length > MAX_QUESTIONS_PER_RUN) {
    rejected.push(`Model asked ${parsed.length} questions; only the first ${MAX_QUESTIONS_PER_RUN} were considered.`);
  }

  const questions: string[] = [];
  for (const [index, candidate] of parsed.slice(0, MAX_QUESTIONS_PER_RUN).entries()) {
    const result = questionSchema.safeParse(candidate);
    if (!result.success) {
      rejected.push(`Question ${index} rejected: ${result.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    questions.push(result.data);
  }
  return { questions, rejected };
}

// ---------------------------------------------------------------------------
// Ask-HQ (owner directive 2026-08-19): a business General Manager may raise a
// question to HEADQUARTERS (the Chief of Staff) instead of the owner. Same
// hostile-until-parsed treatment as owner questions; separate fence so the two
// audiences can never blur.
// ---------------------------------------------------------------------------

export const HQ_QUESTIONS_BLOCK_OPEN = '```hq-questions';
export const MAX_HQ_QUESTIONS_PER_RUN = 2;

/** Last block wins; mirrors extractOwnerQuestions with its own fence and cap. */
export function extractHqQuestions(modelText: string): QuestionExtraction {
  const rejected: string[] = [];
  const fenceStart = modelText.lastIndexOf(HQ_QUESTIONS_BLOCK_OPEN);
  if (fenceStart === -1) return { questions: [], rejected };
  const afterFence = modelText.slice(fenceStart + HQ_QUESTIONS_BLOCK_OPEN.length);
  const fenceEnd = afterFence.indexOf('```');
  if (fenceEnd === -1) {
    rejected.push('Unterminated hq-questions block.');
    return { questions: [], rejected };
  }
  const raw = afterFence.slice(0, fenceEnd).trim();
  if (raw.length === 0) return { questions: [], rejected };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    rejected.push('hq-questions block is not valid JSON.');
    return { questions: [], rejected };
  }
  if (!Array.isArray(parsed)) {
    rejected.push('hq-questions block must be a JSON array of strings.');
    return { questions: [], rejected };
  }
  if (parsed.length > MAX_HQ_QUESTIONS_PER_RUN) {
    rejected.push(`Model asked ${parsed.length} HQ questions; only the first ${MAX_HQ_QUESTIONS_PER_RUN} were considered.`);
  }
  const questions: string[] = [];
  for (const [index, candidate] of parsed.slice(0, MAX_HQ_QUESTIONS_PER_RUN).entries()) {
    const result = questionSchema.safeParse(candidate);
    if (!result.success) {
      rejected.push(`HQ question ${index} rejected: ${result.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    questions.push(result.data);
  }
  return { questions, rejected };
}

/** Appended ONLY to non-headquarters General Managers' system prompts (runner-conditional). */
export const HQ_QUESTION_RULES = `
- You may also ask HEADQUARTERS. The Chief of Staff at headquarters sees across every business in the company. For questions about ANOTHER business, company-wide status, or anything a sister team would know, ask the Chief of Staff instead of the owner by ending your reply with (at most ${MAX_HQ_QUESTIONS_PER_RUN}, each specific):
${HQ_QUESTIONS_BLOCK_OPEN}
["<question 1>"]
\`\`\`
  The answer arrives in this workspace's knowledge as "HQ answer: ...". Reserve owner-questions for decisions and facts ONLY the owner holds (money, taste, personal facts, approvals of direction) — cross-business information goes to headquarters.`;

/** Appended to EVERY employee's system prompt alongside the artifact rules. */
export const QUESTION_RULES = `
- When you are blocked by a fact or decision ONLY the owner can supply (pricing, service area, brand choices, budgets, approvals of direction), ASK for it by ending your reply with a single fenced block (at most ${MAX_QUESTIONS_PER_RUN} questions, each specific and answerable in a sentence or two):
${QUESTIONS_BLOCK_OPEN}
["<question 1>", "<question 2>"]
\`\`\`
  Questions go to the owner's Inbox; the answer arrives in this workspace's knowledge. Never ask what workspace knowledge already answers, and never use this for routine status.`;
