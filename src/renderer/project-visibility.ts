import type { ProjectFilter, ProjectVisibility } from '@/shared/settings-contract';

export type ProjectStatus = 'active' | 'archived' | 'removed';

/**
 * Which projects a surface shows. The sidebar uses its filter; search shows
 * archived projects too (archiving tucks a project away, it doesn't hide its
 * conversations); starting a conversation offers active projects only.
 * Removed projects are in none of them.
 */
export type ProjectScope = ProjectFilter | 'searchable' | 'startable';

export function projectStatus(visibility: ProjectVisibility, projectPath: string): ProjectStatus {
  if (visibility.removed.includes(projectPath)) return 'removed';
  if (visibility.archived.includes(projectPath)) return 'archived';
  return 'active';
}

/** `visibility` with `projectPath` in exactly one state. Returns the same object when nothing changes. */
export function withProjectStatus(visibility: ProjectVisibility, projectPath: string, status: ProjectStatus): ProjectVisibility {
  if (projectStatus(visibility, projectPath) === status) return visibility;
  const without = (paths: string[]) => paths.filter((path) => path !== projectPath);
  return {
    archived: status === 'archived' ? [...without(visibility.archived), projectPath] : without(visibility.archived),
    removed: status === 'removed' ? [...without(visibility.removed), projectPath] : without(visibility.removed),
  };
}

const SHOWN: Record<ProjectScope, readonly ProjectStatus[]> = {
  active: ['active'],
  archived: ['archived'],
  all: ['active', 'archived'],
  searchable: ['active', 'archived'],
  startable: ['active'],
};

export function visibleProjects<T extends { projectPath: string }>(projects: T[], visibility: ProjectVisibility, scope: ProjectScope): T[] {
  return projects.filter((project) => SHOWN[scope].includes(projectStatus(visibility, project.projectPath)));
}
