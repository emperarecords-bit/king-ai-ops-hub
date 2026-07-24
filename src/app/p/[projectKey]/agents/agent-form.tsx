'use client';

import { useActionState } from 'react';
import { saveAgent, type AgentFormState } from './actions';

const initialState: AgentFormState = { error: null, saved: false };

export interface AgentFormData {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  systemPrompt: string;
  temperatureMilli: number;
  maxOutputTokens: number;
  enabled: boolean;
}

export function AgentForm({
  projectKey,
  agent,
  models,
}: {
  projectKey: string;
  agent: AgentFormData;
  models: readonly { id: string; displayName: string }[];
}) {
  const [state, formAction, pending] = useActionState(saveAgent, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="agentId" value={agent.id} />

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--muted)]">Model</span>
          <select
            name="model"
            defaultValue={agent.model}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--muted)]">Temperature (0–1000 = 0.0–1.0)</span>
          <input
            name="temperatureMilli"
            type="number"
            min={0}
            max={1000}
            defaultValue={agent.temperatureMilli}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--muted)]">Max output tokens</span>
          <input
            name="maxOutputTokens"
            type="number"
            min={1}
            max={65536}
            defaultValue={agent.maxOutputTokens}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block text-[var(--muted)]">System prompt</span>
        <textarea
          name="systemPrompt"
          rows={4}
          maxLength={8000}
          defaultValue={agent.systemPrompt}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs"
        />
      </label>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={agent.enabled}
            className="accent-[var(--accent)]"
          />
          Enabled
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        {state.saved ? <span className="text-xs text-[var(--success)]">Saved.</span> : null}
        {state.error ? <span className="text-xs text-[var(--danger)]">{state.error}</span> : null}
      </div>
    </form>
  );
}
