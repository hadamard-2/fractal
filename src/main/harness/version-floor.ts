import type { ProviderId } from '@/shared/conversation-contract';

/**
 * The oldest agent versions Fractal has been run against. Fractal reads each
 * agent's output and protocol as they were at these versions; an older agent
 * may differ in ways nothing else detects, so it gets a warning rather than a
 * refusal. Raise a floor only after checking Fractal against the new version.
 *
 * Claude runs through `@anthropic-ai/claude-agent-sdk`, pinned exactly in
 * package.json. Its `claudeCodeVersion` must not be above the Claude floor, so
 * updating the SDK and raising this floor happen together, after re-running
 * the checks in docs/testing/native-conversation-interoperability.md.
 */
export const TESTED_VERSION_FLOOR: Record<ProviderId, string> = {
  claude: '2.1.296',
  codex: '0.162.1',
};

const NAMES: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex' };

/** A warning when the first version in `text` is older than `floor`; nothing when it is not, or when no version can be read. */
export function versionWarning(provider: ProviderId, text: string | undefined, floor: string = TESTED_VERSION_FLOOR[provider]): string | undefined {
  const found = text ? /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(text)?.[0] : undefined;
  if (!found || compareVersions(found, floor) >= 0) return undefined;
  return `${NAMES[provider]} ${found} is older than ${floor}, the oldest version Fractal is tested with. Update it if something misbehaves.`;
}

function compareVersions(a: string, b: string): number {
  const [aCore, aPre] = a.split('-', 2);
  const [bCore, bPre] = b.split('-', 2);
  const aParts = aCore.split('.').map(Number);
  const bParts = bCore.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (aParts[index] !== bParts[index]) return aParts[index] - bParts[index];
  }
  // Only the release-versus-prerelease order matters for a floor; two prereleases of one version count as equal.
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  return 0;
}
