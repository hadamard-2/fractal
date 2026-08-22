import type { PartPatch, PermissionDecision, Provenance, WorkPart } from '@/shared/agent-contract';

export type AdapterStep =
  | { kind: 'text'; delta: string }
  | { kind: 'work-start'; part: WorkPart }
  | { kind: 'work-end'; partId: string; patch: PartPatch }
  | { kind: 'provenance'; provenance: Provenance };

export interface BackendAdapter {
  run(input: {
    text: string;
    emit: (step: AdapterStep) => void;
    requestPermission: (partId: string) => Promise<PermissionDecision>;
    signal: AbortSignal;
  }): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEchoAdapter(): BackendAdapter {
  return {
    async run({ text, emit, signal }) {
      if (signal.aborted) return;
      emit({ kind: 'text', delta: `You said: ${text}. ` });
      await sleep(30);
      if (signal.aborted) return;
      const partId = 'work-1';
      emit({
        kind: 'work-start',
        part: { id: partId, kind: 'file-read', path: 'README.md', startedAt: Date.now(), phase: 'running' },
      });
      await sleep(30);
      if (signal.aborted) return;
      emit({ kind: 'work-end', partId, patch: { phase: 'done', endedAt: Date.now() } });
      await sleep(30);
      if (signal.aborted) return;
      emit({ kind: 'text', delta: 'Done.' });
      await sleep(30);
      if (signal.aborted) return;
      // `complete: false` because this stub only ever reads one hardcoded
      // file — it has not established that it saw everything the turn
      // touched, and asserting `true` here would be exactly the lie the
      // field exists to prevent for the first real adapter author to copy.
      emit({ kind: 'provenance', provenance: { filesSkipped: [], uncertainties: [], complete: false } });
    },
  };
}
