import { findAccessLevel } from '@/shared/access-levels';
import type { AccessState, TurnAccess } from '@/shared/conversation-contract';

// Mirrors the custom-mode rule in conversation-ipc: a recorded value outside it is shown but never passed back to the CLI.
const SENDABLE_MODE = /^[A-Za-z]{1,32}$/;

export function claudePermissionMode(access: TurnAccess | undefined): string | undefined {
  if (!access) return undefined;
  return access.state.kind === 'level' ? access.state.level : access.state.mode;
}

export function claudeAccessState(mode: string): AccessState {
  // Claude records `manual` for what its picker calls default.
  const id = mode === 'manual' ? 'default' : mode;
  if (findAccessLevel('claude', id)) return { kind: 'level', level: id };
  return SENDABLE_MODE.test(mode) ? { kind: 'custom', label: mode, mode } : { kind: 'custom', label: mode };
}
