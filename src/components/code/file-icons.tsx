import { FileIcon, FolderIcon } from '@react-symbols/icons/utils';
import { basename } from '@/renderer/file-display';

// Coloured file-type icons from the Symbols set. Decorative: the name always
// sits beside them, so they stay out of the accessibility tree.

/** The icon for a file, picked from its name (`vite.config.ts`, then the extension). */
export function FileTypeIcon({ path, className }: { path: string; className?: string }) {
  return <FileIcon aria-hidden autoAssign className={className} fileName={basename(path)} />;
}

/** The icon for a folder, picked from its name (`src`, `node_modules`, …). */
export function FolderTypeIcon({ name, className }: { name: string; className?: string }) {
  return <FolderIcon aria-hidden className={className} folderName={name} />;
}
