import { validateSandboxRequest, type IsolatedSandbox, type SandboxCancellation, type SandboxRequest, type SandboxResult } from './sandbox-boundary';

/** Test-only in-memory adapter. It performs no execution or I/O. */
export class FakeSandbox implements IsolatedSandbox {
  readonly requests: SandboxRequest[] = [];
  constructor(private readonly configuredResult: SandboxResult) {}
  async execute(request: SandboxRequest, cancellation: SandboxCancellation): Promise<SandboxResult> {
    validateSandboxRequest(request);
    this.requests.push(request);
    if (cancellation.cancelled) return { ...this.configuredResult, outcome: 'cancelled', evidence: { ...this.configuredResult.evidence, reconciliationRequired: false } };
    if (this.configuredResult.outputBytes > request.limits.maxOutputBytes) throw new Error('sandbox output limit exceeded');
    return this.configuredResult;
  }
}
