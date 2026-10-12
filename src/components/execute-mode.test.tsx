// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ProviderNotices } from './execute-mode';
import type { HarnessStatus } from '@/shared/conversation-contract';

afterEach(() => { cleanup(); });

const capabilities: HarnessStatus['capabilities'] = {
  create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: false,
};

test('tells the user about a working agent whose version is older than Fractal is tested with', () => {
  const warning = 'Codex 0.160.0 is older than 0.162.1, the oldest version Fractal is tested with. Update it if something misbehaves.';
  render(<ProviderNotices providers={[{ provider: 'codex', availability: 'available', warning, capabilities }]} />);
  expect(screen.getByRole('status').textContent).toBe(warning);
});

test('shows nothing for a working agent with nothing to report', () => {
  render(<ProviderNotices providers={[{ provider: 'claude', availability: 'available', capabilities }]} />);
  expect(screen.queryByRole('status')).toBeNull();
});
