import path from 'node:path';
import { conversationKey } from '@/shared/conversation-contract';
import type { ConversationSummary, ProjectConversationGroup } from '@/shared/conversation-contract';

export type Realpath = (path: string) => Promise<string>;

export async function canonicalizeProjectPath(input: string, realpath: Realpath): Promise<string> {
  return path.normalize(await realpath(input));
}

export function projectDisplayName(projectPath: string): string {
  return path.basename(projectPath);
}

export async function groupConversationsByProject(
  summaries: ConversationSummary[],
  realpath: Realpath,
): Promise<ProjectConversationGroup[]> {
  const groups = new Map<string, ConversationSummary[]>();

  for (const summary of summaries) {
    const projectPath = await canonicalizeProjectPath(summary.ref.projectPath, realpath);
    const canonicalSummary: ConversationSummary = {
      ...summary,
      ref: { ...summary.ref, projectPath },
    };
    const conversations = groups.get(projectPath);
    if (conversations) {
      conversations.push(canonicalSummary);
    } else {
      groups.set(projectPath, [canonicalSummary]);
    }
  }

  const result = Array.from(groups, ([projectPath, conversations]) => ({
    projectPath,
    displayName: projectDisplayName(projectPath),
    conversations: conversations.sort((a, b) => b.updatedAt - a.updatedAt || conversationKey(a.ref).localeCompare(conversationKey(b.ref))),
  }));

  return result.sort((a, b) => b.conversations[0].updatedAt - a.conversations[0].updatedAt || a.projectPath.localeCompare(b.projectPath));
}
