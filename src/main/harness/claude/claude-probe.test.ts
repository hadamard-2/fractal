import { describe, expect, test, vi } from 'vitest';
import { detectClaudeRuntime, probeClaude, type ClaudeExec } from './claude-probe';

const ref = { provider: 'claude' as const, nativeSessionId: 'session-1', projectPath: '/work/fractal' };

function fakeExec(results: Record<string, { exitCode: number; stdout?: string; stderr?: string }>): ClaudeExec {
  return vi.fn(async (_file, args) => results[args.join(' ')] ?? { exitCode: 127, stdout: '', stderr: '' });
}

describe('probeClaude', () => {
  test('reports unavailable when the executable cannot be invoked', async () => {
    const exec = fakeExec({});
    await expect(probeClaude(exec)).resolves.toMatchObject({ provider: 'claude', availability: 'unavailable' });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenCalledWith('claude', ['--version'], { timeoutMs: 5_000 });
  });

  test('derives each capability independently and accepts only documented noninteractive authentication evidence', async () => {
    const exec = fakeExec({
      '--version': { exitCode: 0, stdout: '2.1.0\n' },
      '--help': { exitCode: 0, stdout: '--resume --session-id --output-format stream-json --mcp-config\nAskUserQuestion\n' },
      'agents --json': { exitCode: 0, stdout: '[]' },
      'auth status --json': { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' },
    });
    const status = await probeClaude(exec, '/usr/bin/claude');
    expect(status).toMatchObject({
      availability: 'available', version: '2.1.0',
      evidence: { resume: true, sessionId: true, streamJson: true, partialMessages: false, mcpConfig: true, permissionPromptTool: false, permissionPrompts: false, askUserQuestion: true, authenticated: true },
    });
  });

  test('does not infer authentication from a successful version command', async () => {
    const exec = fakeExec({
      '--version': { exitCode: 0, stdout: '2.1.0' }, '--help': { exitCode: 0, stdout: '--resume' },
      'agents --json': { exitCode: 1, stderr: 'unsupported' },
    });
    await expect(probeClaude(exec)).resolves.toMatchObject({ availability: 'unauthenticated', evidence: { authenticated: false } });
  });

  test('does not infer authentication from an empty documented agent array', async () => {
    const exec = fakeExec({ '--version': { exitCode: 0, stdout: '2.1.263' }, '--help': { exitCode: 0, stdout: '--resume' }, 'agents --json': { exitCode: 0, stdout: '[]' } });
    await expect(probeClaude(exec)).resolves.toMatchObject({ availability: 'unauthenticated', evidence: { authenticated: false } });
  });

  test('does not confuse permission-tool routing with ordinary permission prompt support', async () => {
    const exec = fakeExec({
      '--version': { exitCode: 0, stdout: '2.1.0' },
      '--help': { exitCode: 0, stdout: '--permission-prompt-tool <name>' },
      'agents --json': { exitCode: 0, stdout: '[]' },
      'auth status --json': { exitCode: 0, stdout: '{"loggedIn":true}' },
    });
    await expect(probeClaude(exec)).resolves.toMatchObject({
      evidence: { permissionPromptTool: true, permissionPrompts: false },
    });
  });
});

describe('detectClaudeRuntime', () => {
  test('owned registry wins over external discovery', async () => {
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => true, exec: fakeExec({}) })).resolves.toBe('active-in-fractal');
  });

  test('reports an externally active matching agent', async () => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout: '{"agents":[{"sessionId":"session-1","cwd":"/work/fractal","status":"running"}]}' } });
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec })).resolves.toBe('active-externally');
  });

  test('recognizes snake-case session IDs in an agent array without treating unknown status as idle', async () => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout: '[{"session_id":"session-1","cwd":"/work/fractal","status":"running"}]' } });
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec })).resolves.toBe('active-externally');
  });

  test('cannot prove idle when agent discovery is unsupported and transcript inactivity is unproven', async () => {
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec: fakeExec({}), transcriptGrew: async () => false })).resolves.toBe('unknown');
  });

  test('returns idle only from supported native inactivity evidence', async () => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout: '{"agents":[]}' } });
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec, transcriptGrew: async () => false })).resolves.toBe('idle');
  });

  test('accepts the documented agents JSON array as native idle evidence', async () => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout: '[]' } });
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec, transcriptGrew: async () => false })).resolves.toBe('idle');
  });

  test.each([
    '{"agents":[{"sessionId":"session-1","cwd":"/work/fractal"}]}',
    '{"agents":[{"sessionId":"session-1","cwd":"/work/fractal","status":"teleporting"}]}',
    '{"agents":[{"sessionId":4,"cwd":"/work/fractal","status":"running"}]}',
    '{"agents":{}}',
  ])('treats malformed or unrecognized native agent evidence as unknown: %s', async (stdout) => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout } });
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec, transcriptGrew: async () => false })).resolves.toBe('unknown');
  });

  test('treats transcript-growth inspection failure conservatively', async () => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout: '{"agents":[]}' } });
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec, transcriptGrew: async () => { throw new Error('stat failed'); } })).resolves.toBe('unknown');
  });
});
