import {
  type AgentEvent,
  type AgentRequest,
  type AgentResponse,
  ProviderError,
  type ProviderErrorKind,
} from '@/types/provider';
import { FakeProvider } from './fake-provider';

/**
 * FakeProvider that also implements stream(): replies are emitted as
 * word-by-word deltas followed by a 'done' event. `failMidStream` makes the
 * NEXT streamed call emit two deltas and then throw — for testing the
 * no-retry-after-partial-output rule.
 */
export class FakeStreamingProvider extends FakeProvider {
  private midStreamFailure: ProviderErrorKind | null = null;

  failMidStream(errorKind: ProviderErrorKind): this {
    this.midStreamFailure = errorKind;
    return this;
  }

  async *stream(request: AgentRequest): AsyncIterable<AgentEvent> {
    if (this.midStreamFailure) {
      const kind = this.midStreamFailure;
      this.midStreamFailure = null;
      this.requests.push(request);
      yield { kind: 'delta', text: 'partial ' };
      yield { kind: 'delta', text: 'output' };
      throw new ProviderError(this.id, kind, `fake mid-stream ${kind}`);
    }

    // Reuse execute() so scripted replies/errors behave identically.
    const response: AgentResponse = await this.execute(request);
    const words = response.text.split(' ');
    for (let i = 0; i < words.length; i += 1) {
      yield { kind: 'delta', text: i === 0 ? words[i]! : ` ${words[i]!}` };
    }
    yield { kind: 'done', response };
  }
}
