import {
  type AgentRequest,
  type AgentResponse,
  type AIProvider,
  type AuthoritativeNotExecutedGuarantee,
  type ModelDescriptor,
  ProviderError,
  type ProviderErrorKind,
  type ProviderId,
} from '@/types/provider';

/**
 * Deterministic AIProvider for engine tests. Scripted: each call consumes the
 * next behavior in the queue; when the queue is empty the default reply is
 * returned. Records every request it receives for assertions.
 */

type Behavior =
  | { kind: 'reply'; text: string }
  | { kind: 'error'; errorKind: ProviderErrorKind };

export class FakeProvider implements AIProvider {
  readonly id: ProviderId;
  authoritativeNotExecuted: AuthoritativeNotExecutedGuarantee = {
    support: 'error_kinds',
    errorKinds: new Set(['auth', 'rate_limited', 'invalid_request']),
    basis: 'fake-provider scripted rejection occurs before execute returns',
  };
  readonly requests: AgentRequest[] = [];
  private readonly queue: Behavior[] = [];
  defaultReply = 'ok';

  constructor(id: ProviderId = 'openai') {
    this.id = id;
  }

  reply(text: string): this {
    this.queue.push({ kind: 'reply', text });
    return this;
  }

  fail(errorKind: ProviderErrorKind): this {
    this.queue.push({ kind: 'error', errorKind });
    return this;
  }

  withoutAuthoritativeNotExecutedProof(): this {
    this.authoritativeNotExecuted = { support: 'unsupported' };
    return this;
  }

  async execute(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(request);
    const behavior = this.queue.shift() ?? { kind: 'reply' as const, text: this.defaultReply };
    if (behavior.kind === 'error') {
      throw new ProviderError(this.id, behavior.errorKind, `fake ${behavior.errorKind}`);
    }
    return {
      provider: this.id,
      model: request.model,
      text: behavior.text,
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: 'stop',
      latencyMs: 1,
    };
  }

  listModels(): readonly ModelDescriptor[] {
    return [
      { id: 'fake-model', provider: this.id, displayName: 'Fake', maxOutputTokens: 4096 },
    ];
  }
}

export function makeEngineAgent(provider: FakeProvider, agentId = 'agent-1') {
  return {
    agentId,
    displayName: agentId === 'reviewer-1' ? 'Review Sentinel' : 'Primary Agent',
    provider,
    model: 'fake-model',
    systemPrompt: 'You are a test agent.',
    reviewRubric: null,
    temperature: 0.7,
    maxOutputTokens: 1024,
  };
}
