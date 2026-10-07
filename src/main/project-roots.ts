export class UnknownProjectError extends Error {
  override name = 'UnknownProjectError';
}

export function createRootCheck(knowsProject: (projectPath: string) => Promise<boolean>): (root: string) => Promise<void> {
  const knownRoots = new Set<string>();
  return async (root: string) => {
    if (knownRoots.has(root)) return;
    if (!(await knowsProject(root))) throw new UnknownProjectError('Unknown project');
    knownRoots.add(root);
  };
}
