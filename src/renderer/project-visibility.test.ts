import { describe, expect, test } from 'vitest';
import type { ProjectVisibility } from '@/shared/settings-contract';
import { projectStatus, visibleProjects, sidebarProjects, withoutAgents, withProjectStatus } from './project-visibility';

const empty: ProjectVisibility = { archived: [], removed: [] };
const projects = [{ projectPath: '/a' }, { projectPath: '/b' }, { projectPath: '/c' }];
const visibility = { archived: ['/b'], removed: ['/c'] };

describe('project visibility', () => {
  test('reads a project status from the two lists', () => {
    expect(projectStatus(visibility, '/a')).toBe('active');
    expect(projectStatus(visibility, '/b')).toBe('archived');
    expect(projectStatus(visibility, '/c')).toBe('removed');
  });

  test('moves a path between states without duplicating it', () => {
    const archived = withProjectStatus(empty, '/a', 'archived');
    expect(archived).toEqual({ archived: ['/a'], removed: [] });
    expect(withProjectStatus(archived, '/a', 'archived')).toBe(archived);
    expect(withProjectStatus(archived, '/a', 'removed')).toEqual({ archived: [], removed: ['/a'] });
    expect(withProjectStatus(visibility, '/c', 'active')).toEqual({ archived: ['/b'], removed: [] });
  });

  test('filters by status, never showing removed projects', () => {
    const paths = (filter: 'active' | 'archived' | 'all' | 'searchable' | 'startable') => visibleProjects(projects, visibility, filter).map((project) => project.projectPath);
    expect(paths('active')).toEqual(['/a']);
    expect(paths('archived')).toEqual(['/b']);
    expect(paths('all')).toEqual(['/a', '/b']);
    expect(paths('searchable')).toEqual(['/a', '/b']);
    expect(paths('startable')).toEqual(['/a']);
  });

  test('hides the chosen agents\' chats and drops projects left empty', () => {
    const chat = (provider: 'claude' | 'codex') => ({ ref: { provider } });
    const groups = [
      { projectPath: '/mixed', conversations: [chat('claude'), chat('codex')] },
      { projectPath: '/codex', conversations: [chat('codex')] },
    ];
    expect(withoutAgents(groups, [])).toBe(groups);
    expect(withoutAgents(groups, ['codex'])).toEqual([{ projectPath: '/mixed', conversations: [chat('claude')] }]);
    expect(withoutAgents(groups, ['claude']).map((group) => group.conversations.length)).toEqual([1, 1]);
    expect(withoutAgents(groups, ['claude', 'codex'])).toEqual([]);
  });

  test('shows archived chats under Archived only, keeping an archived project whole and never a removed one', () => {
    const chat = (id: string) => ({ ref: { provider: 'codex' as const, nativeSessionId: id, projectPath: '' } });
    const groups = [
      { projectPath: '/a', conversations: [chat('kept'), chat('tucked')] },
      { projectPath: '/b', conversations: [chat('old')] },
      { projectPath: '/c', conversations: [chat('removed')] },
      { projectPath: '/d', conversations: [chat('gone')] },
    ];
    const ids = (filter: 'active' | 'archived' | 'all', archived = ['codex:tucked', 'codex:gone']) => sidebarProjects(groups, visibility, archived, filter).map((group) => [group.projectPath, group.conversations.map((item) => item.ref.nativeSessionId)]);
    expect(sidebarProjects(groups, empty, [], 'active')).toBe(groups);
    expect(sidebarProjects(groups, empty, ['codex:tucked'], 'all')).toBe(groups);
    expect(ids('all').map(([projectPath]) => projectPath)).toEqual(['/a', '/b', '/d']);
    // An active project with every chat archived keeps its row.
    expect(ids('active')).toEqual([['/a', ['kept']], ['/d', []]]);
    expect(ids('archived')).toEqual([['/a', ['tucked']], ['/b', ['old']], ['/d', ['gone']]]);
    expect(ids('archived', [])).toEqual([['/b', ['old']]]);
    expect(ids('active', [])).toEqual([['/a', ['kept', 'tucked']], ['/d', ['gone']]]);
  });
});
