import { findAccessLevel } from '@/shared/access-levels';
import type { AccessState, TurnAccess } from '@/shared/conversation-contract';
import { isSendableAccessMode } from '@/shared/conversation-ipc';

// The IPC contract caps a custom label at 200 characters.
const MAX_LABEL_LENGTH = 200;

export function claudePermissionMode(access: TurnAccess | undefined): string | undefined {
  if (!access) return undefined;
  return access.state.kind === 'level' ? access.state.level : access.state.mode;
}

export function claudeAccessState(mode: string): AccessState {
  // Claude records `manual` for what its picker calls default.
  const id = mode === 'manual' ? 'default' : mode;
  if (findAccessLevel('claude', id)) return { kind: 'level', level: id };
  const label = mode.slice(0, MAX_LABEL_LENGTH);
  return isSendableAccessMode(mode) ? { kind: 'custom', label, mode } : { kind: 'custom', label };
}
