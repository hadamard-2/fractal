import { cn } from '@/lib/utils';
import { basename } from '@/renderer/file-display';
import type { FilePanelTab } from '@/renderer/panel-tabs';
import { FILES_TREE_WIDTH } from '@/renderer/right-panel-layout';
import { FileTree } from './file-tree';
import { FileViewer } from './file-viewer';

/**
 * Every open file tab's content, plus one tree per project, all kept mounted
 * so folders stay expanded and viewers keep their place while hidden. The
 * tree sits beside the viewer when docked; otherwise it covers the viewer
 * when asked for, and always while the selected tab has no file yet.
 */
export function FilesPane({ tabs, selected, docked, dockedTreeOpen, overlayOpen, onOpenFile, onCloseOverlay }: {
  tabs: FilePanelTab[];
  selected: FilePanelTab | undefined;
  docked: boolean;
  dockedTreeOpen: boolean;
  overlayOpen: boolean;
  onOpenFile: (projectPath: string, path: string, pinned: boolean) => void;
  onCloseOverlay: () => void;
}) {
  const projects = [...new Set(tabs.map((tab) => tab.projectPath))];
  const treeVisible = selected !== undefined && (docked ? dockedTreeOpen : overlayOpen || selected.path === null);
  return (
    <div className="relative flex h-full min-h-0">
      {projects.map((projectPath) => (
        <div
          aria-label={`Files in ${basename(projectPath)}`}
          className={cn('min-h-0 bg-sidebar', docked ? 'shrink-0 border-r border-sidebar-border' : 'absolute inset-0 z-10')}
          hidden={!treeVisible || selected?.projectPath !== projectPath}
          key={projectPath}
          role="region"
          style={docked ? { width: FILES_TREE_WIDTH } : undefined}
        >
          <FileTree
            key={projectPath}
            onOpen={(path, { pinned }) => {
              onOpenFile(projectPath, path, pinned);
              if (!docked) onCloseOverlay();
            }}
            root={projectPath}
            selectedPath={selected?.projectPath === projectPath ? selected.path : null}
          />
        </div>
      ))}
      <div className="min-w-0 flex-1">
        {tabs.map((tab) => (
          <div aria-labelledby={tab.id} className="h-full" hidden={selected?.id !== tab.id} id={`panel-${tab.id}`} key={tab.id} role="tabpanel">
            {tab.path === null
              ? <p className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file</p>
              : <FileViewer key={tab.path} path={tab.path} root={tab.projectPath} />}
          </div>
        ))}
      </div>
    </div>
  );
}
