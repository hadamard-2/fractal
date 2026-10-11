import type { AccessLevel, AccessState, ProviderId } from '@/shared/conversation-contract';

// Ordered by increasing autonomy. A Claude id is the value passed to `--permission-mode`.
const CATALOG: Record<ProviderId, readonly AccessLevel[]> = {
  claude: [
    { id: 'plan', label: 'Plan', description: 'Reads and proposes a plan; no edits until you approve it.', dangerous: false },
    { id: 'default', label: 'Ask', description: 'Reads freely; asks before edits and commands.', dangerous: false },
    { id: 'acceptEdits', label: 'Accept edits', description: 'Edits files without asking; asks before other commands.', dangerous: false },
    { id: 'auto', label: 'Auto', description: 'Acts without asking; a safety check reviews each action.', dangerous: false },
    { id: 'bypassPermissions', label: 'Bypass', description: 'Acts without asking and without any safety check.', dangerous: true },
  ],
  codex: [
    { id: 'read-only', label: 'Read-only', description: 'Reads and runs read-only commands; asks to do more.', dangerous: false },
    { id: 'auto', label: 'Auto', description: 'Edits and runs commands in the workspace; asks to go outside it.', dangerous: false },
    { id: 'auto-review', label: 'Auto-review', description: 'Like Auto, but a reviewer agent answers its requests instead of you.', dangerous: false },
    { id: 'full-access', label: 'Full access', description: 'Runs any command with no sandbox and never asks.', dangerous: true },
  ],
};

export function accessLevels(provider: ProviderId): AccessLevel[] {
  return CATALOG[provider].map((level) => ({ ...level }));
}

export function findAccessLevel(provider: ProviderId, id: string): AccessLevel | undefined {
  return accessLevels(provider).find((level) => level.id === id);
}

export function sameAccess(a: AccessState, b: AccessState): boolean {
  if (a.kind === 'level') return b.kind === 'level' && a.level === b.level;
  return b.kind === 'custom' && a.label === b.label && a.mode === b.mode && Boolean(a.dangerous) === Boolean(b.dangerous);
}
