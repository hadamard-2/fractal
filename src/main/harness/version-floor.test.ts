import { describe, expect, test } from 'vitest';
import { versionWarning } from './version-floor';

describe('versionWarning', () => {
  const floor = '2.1.296';

  test('warns about a version older than the floor, naming both', () => {
    expect(versionWarning('claude', '2.1.291 (Claude Code)', floor)).toBe(
      'Claude 2.1.291 is older than 2.1.296, the oldest version Fractal is tested with. Update it if something misbehaves.',
    );
    expect(versionWarning('claude', '1.9.999', floor)).toMatch(/^Claude 1\.9\.999 is older/);
  });

  test('stays quiet at or above the floor, comparing each part as a number', () => {
    expect(versionWarning('claude', '2.1.296 (Claude Code)', floor)).toBeUndefined();
    expect(versionWarning('claude', '2.1.1000', floor)).toBeUndefined();
    expect(versionWarning('claude', '3.0.0', floor)).toBeUndefined();
  });

  test('treats a prerelease as older than its release', () => {
    expect(versionWarning('codex', 'fractal/0.162.1-alpha.3 (Ubuntu 26.4.0; x86_64)', '0.162.1')).toMatch(/^Codex 0\.162\.1-alpha\.3 is older/);
    expect(versionWarning('codex', 'fractal/0.162.1 (Ubuntu 26.4.0; x86_64)', '0.162.1')).toBeUndefined();
  });

  test('reads the first version in the text, so a later OS version is not mistaken for it', () => {
    expect(versionWarning('codex', 'fractal/0.160.0 (Ubuntu 26.4.0; x86_64) unknown', '0.162.1')).toMatch(/^Codex 0\.160\.0 is older/);
  });

  test('says nothing when no version can be read', () => {
    expect(versionWarning('claude', 'Claude Code', floor)).toBeUndefined();
    expect(versionWarning('claude', undefined, floor)).toBeUndefined();
  });
});
