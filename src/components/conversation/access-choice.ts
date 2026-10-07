import type { AccessLevel, AccessState, ProviderId, TurnAccess } from '@/shared/conversation-contract';

const PROVIDER_NAME: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex' };

/** A level's label, or `Custom: …` for a setting no level matches. */
export function accessStateLabel(state: AccessState, levels: AccessLevel[]): string {
  if (state.kind === 'custom') return `Custom: ${state.label}`;
  return levels.find((level) => level.id === state.level)?.label ?? state.level;
}

export function accessTriggerLabel(provider: ProviderId, access: TurnAccess | null, levels: AccessLevel[]): string {
  return access ? accessStateLabel(access.state, levels) : `${PROVIDER_NAME[provider]}'s default`;
}

function currentLevelId(access: TurnAccess | null): string | undefined {
  return access?.state.kind === 'level' ? access.state.level : undefined;
}

/** Dangerous levels are listed only when Settings allows them or one is already current. */
export function visibleAccessLevels(levels: AccessLevel[], allowDangerous: boolean, access: TurnAccess | null): AccessLevel[] {
  const current = currentLevelId(access);
  return levels.filter((level) => !level.dangerous || allowDangerous || level.id === current);
}

/** The level after the current one among the non-dangerous levels, wrapping; the first when nothing in that list is current. */
export function nextAccessLevel(levels: AccessLevel[], access: TurnAccess | null): string | undefined {
  const safe = levels.filter((level) => !level.dangerous);
  const index = safe.findIndex((level) => level.id === currentLevelId(access));
  return safe[(index + 1) % safe.length]?.id;
}
