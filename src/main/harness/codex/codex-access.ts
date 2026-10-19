import type { AccessState } from '@/shared/conversation-contract';
import type { ApprovalsReviewer } from '@/main/harness/codex/generated/v2/ApprovalsReviewer';
import type { AskForApproval } from '@/main/harness/codex/generated/v2/AskForApproval';
import type { SandboxPolicy } from '@/main/harness/codex/generated/v2/SandboxPolicy';
import type { ThreadResumeResponse } from '@/main/harness/codex/generated/v2/ThreadResumeResponse';

export interface CodexAccessOverrides {
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  sandboxPolicy: SandboxPolicy;
}

type SandboxType = SandboxPolicy['type'];
type ThreadAccess = Pick<ThreadResumeResponse, 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'>;

const LEVELS: Record<string, { approvalPolicy: AskForApproval; approvalsReviewer: ApprovalsReviewer; sandbox: SandboxType }> = {
  'read-only': { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'readOnly' },
  auto: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspaceWrite' },
  'auto-review': { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspaceWrite' },
  'full-access': { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'dangerFullAccess' },
};

const SANDBOX_LABELS: Record<SandboxType, string> = {
  readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'full access', externalSandbox: 'external sandbox',
};

const REVIEWER_LABELS: Record<ApprovalsReviewer, string | undefined> = {
  user: undefined, auto_review: 'auto-review', guardian_subagent: 'guardian review',
};

function hasNetwork(sandbox: SandboxPolicy): boolean {
  if (sandbox.type === 'dangerFullAccess') return false;
  return sandbox.type === 'externalSandbox' ? sandbox.networkAccess === 'enabled' : sandbox.networkAccess;
}

function sandboxFor(type: SandboxType, current: SandboxPolicy): SandboxPolicy {
  if (type === 'dangerFullAccess') return { type };
  if (type === 'readOnly') return { type, networkAccess: hasNetwork(current) };
  if (current.type === 'workspaceWrite') return current;
  return { type: 'workspaceWrite', writableRoots: [], networkAccess: hasNetwork(current), excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

// Only the sandbox type changes: the thread's network access and workspace
// settings are kept so picking a level does not silently drop them.
export function codexAccessOverrides(level: string, current: SandboxPolicy): CodexAccessOverrides {
  if (!Object.hasOwn(LEVELS, level)) throw new Error(`Unknown access level: ${level}`);
  const spec = LEVELS[level];
  return { approvalPolicy: spec.approvalPolicy, approvalsReviewer: spec.approvalsReviewer, sandboxPolicy: sandboxFor(spec.sandbox, current) };
}

// A side chat can't answer an approval prompt, so it runs read-only with approvals off: a command the sandbox blocks fails instead of asking.
// Network access is pinned off whatever the thread had, so a side chat can't reach out from a command it runs.
export function codexReadOnlyOverrides(): CodexAccessOverrides {
  return { ...codexAccessOverrides('read-only', { type: 'readOnly', networkAccess: false }), approvalPolicy: 'never' };
}

function approvalLabel(policy: AskForApproval): string {
  if (typeof policy === 'object') return 'granular';
  return { 'on-request': 'ask on request', never: 'never ask', untrusted: 'untrusted' }[policy];
}

export function codexAccessState(thread: ThreadAccess): AccessState {
  for (const [id, spec] of Object.entries(LEVELS)) {
    if (spec.approvalPolicy === thread.approvalPolicy && spec.approvalsReviewer === thread.approvalsReviewer && spec.sandbox === thread.sandbox.type) {
      return { kind: 'level', level: id };
    }
  }
  const reviewer = REVIEWER_LABELS[thread.approvalsReviewer];
  const label = [SANDBOX_LABELS[thread.sandbox.type], approvalLabel(thread.approvalPolicy), ...(reviewer ? [reviewer] : [])].join(' · ');
  // Without a sandbox, any command Codex runs unasked can do anything; asking for some of them does not make up for it.
  return thread.sandbox.type === 'dangerFullAccess' ? { kind: 'custom', label, dangerous: true } : { kind: 'custom', label };
}
