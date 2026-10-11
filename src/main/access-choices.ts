import type { HarnessAdapter } from '@/main/harness/types';
import type { AccessChoiceStore } from '@/main/access-choice-store';
import { conversationKey, type AccessLevel, type AccessState, type ConversationRef, type ProviderId, type TurnAccess } from '@/shared/conversation-contract';
import { accessLevels, findAccessLevel, sameAccess } from '@/shared/access-levels';

type AccessSource = Pick<HarnessAdapter, 'provider' | 'readAccess'>;
type ChoiceStore = Pick<AccessChoiceStore, 'get' | 'set'>;

/**
 * What access each conversation's next turn runs with: the level the user
 * picked, else what its own history last ran with (adopted, so a resumed
 * conversation keeps its mode), else the agent's default (null). A picked
 * level can only be one Settings currently allows. The read-back is cached
 * until the history may have changed (see `forget`).
 */
export class AccessChoices {
  private readonly sources = new Map<ProviderId, AccessSource>();
  private readonly readBacks = new Map<string, AccessState | undefined>();
  /** Bumped whenever the history may have changed, so a read that spans the change is not cached. */
  private readonly generations = new Map<string, number>();

  constructor(
    sources: AccessSource[],
    private readonly store: ChoiceStore,
    private readonly dangerousAllowed: (provider: ProviderId) => boolean,
  ) {
    for (const source of sources) this.sources.set(source.provider, source);
  }

  levels(provider: ProviderId): AccessLevel[] { return accessLevels(provider); }

  /** Settings that cannot be read count as off. */
  allowDangerous(provider: ProviderId): boolean {
    try { return this.dangerousAllowed(provider); } catch { return false; }
  }

  async resolve(ref: ConversationRef): Promise<{ access: TurnAccess | null; observed?: AccessState }> {
    const saved = this.store.get(conversationKey(ref));
    // An unsent pick has not run yet, so the history cannot disagree with it.
    if (saved && !saved.sent) return { access: { state: saved.state, picked: true } };
    const readBack = await this.readBack(ref);
    if (saved) {
      const access = { state: saved.state, picked: true };
      return readBack && !sameAccess(saved.state, readBack) ? { access, observed: readBack } : { access };
    }
    return { access: readBack ? { state: readBack, picked: false } : null };
  }

  choose(ref: ConversationRef, level: string): void {
    const state: AccessState = { kind: 'level', level };
    this.validatePicked(ref.provider, state);
    this.store.set(conversationKey(ref), { state, sent: false });
  }

  /** Any state can reach the agent's command line, so a read-back one is held to the same levels and Settings gate as a pick. */
  validateSend(ref: ConversationRef, access: TurnAccess | undefined): void {
    if (!access) return;
    if (access.picked) return this.validatePicked(ref.provider, access.state);
    const { state } = access;
    if (state.kind === 'level' && !findAccessLevel(ref.provider, state.level)) throw new Error('Unknown access level');
    const effective = findAccessLevel(ref.provider, state.kind === 'level' ? state.level : state.mode ?? '');
    if (effective?.dangerous && !this.allowDangerous(ref.provider)) throw new Error(`${effective.label} is turned off in Settings`);
  }

  /** The send changes what the history records, so the cached read-back is dropped whatever was sent. */
  recordSend(ref: ConversationRef, access: TurnAccess | undefined): void {
    const key = conversationKey(ref);
    if (access?.picked) {
      // A pick made after this send started has not run yet and must survive it.
      const stored = this.store.get(key);
      if (!stored || stored.sent || sameAccess(stored.state, access.state)) this.store.set(key, { state: access.state, sent: true });
    }
    this.forget(ref);
  }

  /** Drops the cached read-back, for when the history may have changed: a turn sent here, or one seen arriving from anywhere. */
  forget(ref: ConversationRef): void {
    const key = conversationKey(ref);
    this.readBacks.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  private async readBack(ref: ConversationRef): Promise<AccessState | undefined> {
    const key = conversationKey(ref);
    if (this.readBacks.has(key)) return this.readBacks.get(key);
    const generation = this.generations.get(key) ?? 0;
    try {
      const result = await this.sources.get(ref.provider)?.readAccess?.(ref);
      // A send or history change that landed while reading may make this result stale; the caller may use it, the cache may not.
      if ((this.generations.get(key) ?? 0) === generation) this.readBacks.set(key, result);
      return result;
    } catch { return undefined; }
  }

  private validatePicked(provider: ProviderId, state: AccessState): void {
    const level = state.kind === 'level' ? findAccessLevel(provider, state.level) : undefined;
    if (!level) throw new Error('Unknown access level');
    if (level.dangerous && !this.allowDangerous(provider)) throw new Error(`${level.label} is turned off in Settings`);
  }
}
