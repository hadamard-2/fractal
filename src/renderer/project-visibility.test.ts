import { describe, expect, test } from 'vitest';
import type { ProjectVisibility } from '@/shared/settings-contract';
import { projectStatus, visibleProjects, withoutAgents, withProjectStatus } from './project-visibility';

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
});
