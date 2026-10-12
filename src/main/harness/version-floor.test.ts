import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { TESTED_VERSION_FLOOR, versionWarning } from './version-floor';

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

describe('the pinned Agent SDK', () => {
  test('bundles a Claude Code version no newer than the Claude floor, which is the newest Fractal has been checked against', async () => {
    const manifest = JSON.parse(await readFile(path.join(import.meta.dirname, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { claudeCodeVersion?: string };
    const parts = (version: string | undefined): number[] => {
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
      if (!match) throw new Error(`Not a plain x.y.z version: ${version}`);
      return match.slice(1).map(Number);
    };
    const bundled = parts(manifest.claudeCodeVersion);
    const floor = parts(TESTED_VERSION_FLOOR.claude);
    const differing = bundled.findIndex((part, index) => part !== floor[index]);
    const above = differing !== -1 && bundled[differing] > floor[differing];
    expect(above, `the SDK bundles Claude Code ${manifest.claudeCodeVersion}, above the floor ${TESTED_VERSION_FLOOR.claude}`).toBe(false);
  });
});
