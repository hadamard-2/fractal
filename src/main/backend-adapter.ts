import type { PartPatch, Provenance, WorkPart } from '@/shared/agent-contract';

export type AdapterStep =
  | { kind: 'text'; delta: string }
  | { kind: 'work-start'; part: WorkPart }
  | { kind: 'work-end'; partId: string; patch: PartPatch }
  | { kind: 'need-permission'; partId: string }
  | { kind: 'provenance'; provenance: Provenance };

export interface BackendAdapter {
  run(input: {
    text: string;
    emit: (step: AdapterStep) => void;
    signal: AbortSignal;
  }): Promise<void>;
}

export function createEchoAdapter(): BackendAdapter {
  return {
    async run({ text, emit, signal }) {
      if (signal.aborted) return;
      emit({ kind: 'text', delta: `You said: ${text}. ` });
      if (signal.aborted) return;
      const partId = 'work-1';
      emit({
        kind: 'work-start',
        part: { id: partId, kind: 'file-read', path: 'README.md', startedAt: Date.now(), phase: 'running' },
      });
      emit({ kind: 'work-end', partId, patch: { phase: 'done', endedAt: Date.now() } });
      emit({ kind: 'text', delta: 'Done.' });
      emit({ kind: 'provenance', provenance: { filesSkipped: [], uncertainties: [], complete: true } });
    },
  };
}
