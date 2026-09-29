import { describe, expect, test, vi } from 'vitest';
import { defaultClaudeExec, detectClaudeRuntime, probeClaude, type ClaudeExec, type ClaudeExecResult } from './claude-probe';

const ref = { provider: 'claude' as const, nativeSessionId: 'session-1', projectPath: '/work/fractal' };

function fakeExec(results: Record<string, ClaudeExecResult>): ClaudeExec {
  return vi.fn(async (_file, args) => results[args.join(' ')] ?? { exitCode: 127, stdout: '', stderr: '' });
}

describe('probeClaude', () => {
  test('reports unavailable when the executable cannot be invoked', async () => {
    const exec = fakeExec({});
    await expect(probeClaude(exec)).resolves.toMatchObject({ provider: 'claude', availability: 'unavailable' });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenCalledWith('claude', ['--version'], { timeoutMs: 5_000 });
  });

  test('names the executable it could not find', async () => {
    const exec = fakeExec({ '--version': { exitCode: 1, launchError: 'ENOENT' } });
    await expect(probeClaude(exec)).resolves.toMatchObject({
      availability: 'unavailable', message: "Couldn't find \"claude\" on the PATH Fractal searches. Set its location in Settings.",
    });
    await expect(probeClaude(exec, '/opt/claude')).resolves.toMatchObject({ message: "Couldn't find /opt/claude. Check its location in Settings." });
  });

  test('keeps the general message when the executable exists but fails', async () => {
    const exec = fakeExec({ '--version': { exitCode: 127, stderr: "env: 'node': No such file or directory" } });
    await expect(probeClaude(exec)).resolves.toMatchObject({ availability: 'unavailable', message: 'Claude executable is unavailable.' });
  });

  test('the default exec reports a missing executable as a launch error', async () => {
    await expect(defaultClaudeExec('/nonexistent/fractal-claude', ['--version'], { timeoutMs: 5_000 })).resolves.toMatchObject({ launchError: 'ENOENT' });
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
  test('shares one in-flight agent query across a large history while classifying each session separately', async () => {
    let finish!: (result: ClaudeExecResult) => void;
    const exec = vi.fn<ClaudeExec>(() => new Promise((resolve) => { finish = resolve; }));
    const dependencies = { hasOwnedProcess: () => false, exec };
    const reads = Array.from({ length: 456 }, (_, index) => detectClaudeRuntime({ ...ref, nativeSessionId: `session-${index}` }, dependencies));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('claude', ['agents', '--json'], { timeoutMs: 5_000 });
    finish({ exitCode: 0, stdout: '[{"sessionId":"session-1","cwd":"/work/fractal","status":"running"}]' });
    const states = await Promise.all(reads);
    expect(states[1]).toBe('active-externally');
    expect(states.filter((state) => state === 'idle')).toHaveLength(455);

    // Once the query settles, a later check must use fresh native evidence.
    const next = detectClaudeRuntime(ref, dependencies);
    expect(exec).toHaveBeenCalledTimes(2);
    finish({ exitCode: 0, stdout: '[]' });
    await expect(next).resolves.toBe('idle');
  });

  test('shares query failures conservatively and retries instead of caching unavailable evidence', async () => {
    let fail!: (error: Error) => void;
    const exec = vi.fn<ClaudeExec>(() => new Promise((_resolve, reject) => { fail = reject; }));
    const dependencies = { hasOwnedProcess: () => false, exec };
    const reads = [detectClaudeRuntime(ref, dependencies), detectClaudeRuntime(ref, dependencies)];
    expect(exec).toHaveBeenCalledTimes(1);
    fail(new Error('Cannot spawn Claude'));
    await expect(Promise.all(reads)).resolves.toEqual(['unknown', 'unknown']);
    exec.mockResolvedValueOnce({ exitCode: 0, stdout: '[]' });
    await expect(detectClaudeRuntime(ref, dependencies)).resolves.toBe('idle');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  test('does not share in-flight evidence between different executables or execution backends', async () => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout: '[]' } });
    const otherExec = fakeExec({});
    const states = await Promise.all([
      detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec, executable: '/one/claude' }),
      detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec, executable: '/two/claude' }),
      detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec: otherExec, executable: '/one/claude' }),
    ]);
    expect(states).toEqual(['idle', 'idle', 'unknown']);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(otherExec).toHaveBeenCalledTimes(1);
  });

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

  test.each(['idle', 'busy', 'waiting'])('treats a matching foreground %s status as external ownership', async (status) => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout: JSON.stringify([{ sessionId: 'unrelated', cwd: '/elsewhere', status: 'busy' }, { sessionId: 'session-1', cwd: '/work/fractal', status }]) } });
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec })).resolves.toBe('active-externally');
  });

  test.each(['working', 'blocked'])('treats a matching background %s state as external activity', async (state) => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout: JSON.stringify([{ session_id: 'session-1', cwd: '/work/fractal', state }]) } });
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec })).resolves.toBe('active-externally');
  });

  test.each(['done', 'failed', 'stopped'])('accepts a matching terminal background %s state as idle proof', async (state) => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout: JSON.stringify([{ session_id: 'unrelated', cwd: '/other', status: 'waiting' }, { session_id: 'session-1', cwd: '/work/fractal', state }]) } });
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec })).resolves.toBe('idle');
  });

  test('unrelated recognized busy and waiting rows do not poison an absent session idle proof', async () => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout: '[{"sessionId":"other-1","cwd":"/other","status":"busy"},{"sessionId":"other-2","cwd":"/other","status":"waiting"}]' } });
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec })).resolves.toBe('idle');
  });

  test('unknown matching state remains unknown despite unrelated valid rows', async () => {
    const exec = fakeExec({ 'agents --json': { exitCode: 0, stdout: '[{"sessionId":"other","cwd":"/other","status":"busy"},{"sessionId":"session-1","cwd":"/work/fractal","state":"teleporting"}]' } });
    await expect(detectClaudeRuntime(ref, { hasOwnedProcess: () => false, exec, transcriptGrew: async () => false })).resolves.toBe('unknown');
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
