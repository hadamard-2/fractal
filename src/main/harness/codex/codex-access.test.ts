import { describe, expect, test } from 'vitest';
import { parseAccessState } from '@/shared/conversation-ipc';
import type { SandboxPolicy } from '@/main/harness/codex/generated/v2/SandboxPolicy';
import { codexAccessOverrides, codexAccessState } from './codex-access';

const ws: SandboxPolicy = { type: 'workspaceWrite', writableRoots: ['/extra'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: false };

describe('codexAccessOverrides', () => {
  test('changes only the sandbox type, carrying network access and workspace fields over', () => {
    expect(codexAccessOverrides('read-only', ws)).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: true } });
    expect(codexAccessOverrides('auto', ws)).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: ws });
    expect(codexAccessOverrides('auto-review', ws)).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: ws });
    expect(codexAccessOverrides('full-access', ws)).toEqual({ approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } });
  });

  test('defaults the workspace fields when coming from full access, and reads an enabled external sandbox as network on', () => {
    expect(codexAccessOverrides('auto', { type: 'dangerFullAccess' }).sandboxPolicy).toEqual({ type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
    expect(codexAccessOverrides('read-only', { type: 'externalSandbox', networkAccess: 'enabled' }).sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: true });
    expect(codexAccessOverrides('auto', { type: 'externalSandbox', networkAccess: 'restricted' }).sandboxPolicy).toMatchObject({ type: 'workspaceWrite', networkAccess: false });
  });

  test('carries network access from a read-only sandbox into workspace-write', () => {
    expect(codexAccessOverrides('auto', { type: 'readOnly', networkAccess: true }).sandboxPolicy).toMatchObject({ type: 'workspaceWrite', networkAccess: true });
  });

  test('rejects an unknown level', () => {
    expect(() => codexAccessOverrides('yolo', ws)).toThrow('Unknown access level');
  });
});

describe('codexAccessState', () => {
  test('reads a matching combination as its level and anything else as custom', () => {
    expect(codexAccessState({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: ws })).toEqual({ kind: 'level', level: 'auto' });
    expect(codexAccessState({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: ws })).toEqual({ kind: 'level', level: 'auto-review' });
    expect(codexAccessState({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } })).toEqual({ kind: 'level', level: 'read-only' });
    expect(codexAccessState({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } })).toEqual({ kind: 'level', level: 'full-access' });
    expect(codexAccessState({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } })).toEqual({ kind: 'custom', label: 'read-only · never ask' });
    expect(codexAccessState({ approvalPolicy: 'on-request', approvalsReviewer: 'guardian_subagent', sandbox: ws })).toEqual({ kind: 'custom', label: 'workspace-write · ask on request · guardian review' });
  });

  test('labels every sandbox, approval policy and reviewer', () => {
    const granular = { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } } as const;
    expect(codexAccessState({ approvalPolicy: granular, approvalsReviewer: 'auto_review', sandbox: { type: 'externalSandbox', networkAccess: 'enabled' } })).toEqual({ kind: 'custom', label: 'external sandbox · granular · auto-review' });
    expect(codexAccessState({ approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } })).toEqual({ kind: 'custom', label: 'full access · untrusted', dangerous: true });
  });

  test('marks any combination without a sandbox as dangerous, and nothing else', () => {
    expect(codexAccessState({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } })).toEqual({ kind: 'custom', label: 'full access · ask on request', dangerous: true });
    expect(codexAccessState({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: ws })).not.toHaveProperty('dangerous');
    expect(codexAccessState({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'externalSandbox', networkAccess: 'enabled' } })).not.toHaveProperty('dangerous');
  });

  test('produces states the IPC contract accepts, without a mode', () => {
    const state = codexAccessState({ approvalPolicy: 'never', approvalsReviewer: 'guardian_subagent', sandbox: ws });
    expect(parseAccessState(state)).toEqual(state);
    expect(state).not.toHaveProperty('mode');
  });
});
