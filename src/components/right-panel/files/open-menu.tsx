import { ChevronDown, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { EditorInfo, FileOpenerId, OpenAction, OpenResult } from '@/shared/files-contract';

const SYSTEM_LABEL = 'System default';

// Main detects editors once per launch; the first menu to ask keeps the answer.
let editorsOnce: Promise<EditorInfo[]> | undefined;
const loadEditors = () => (editorsOnce ??= window.fractal.files.editors().catch((): EditorInfo[] => []));

/** What the Open button runs: the remembered choice while it is still available, else the first editor, else the default app. */
export function defaultOpener(remembered: FileOpenerId | null, editors: EditorInfo[]): FileOpenerId {
  if (remembered === 'system' || (remembered !== null && editors.some((editor) => editor.id === remembered))) return remembered;
  return editors[0]?.id ?? 'system';
}

export function OpenMenu({ root, path, line }: { root: string; path: string; line?: number }) {
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [remembered, setRemembered] = useState<FileOpenerId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void loadEditors().then((list) => { if (current) setEditors(list); });
    window.fractal.settings.get().then(
      (settings) => { if (current) setRemembered(settings.fileOpener); },
      (): void => undefined,
    );
    return () => { current = false; };
  }, []);

  // A failure belongs to the file it happened on.
  useEffect(() => { setMessage(null); }, [root, path]);

  const opener = defaultOpener(remembered, editors);
  const labelFor = (id: FileOpenerId) => (id === 'system' ? SYSTEM_LABEL : editors.find((editor) => editor.id === id)?.label ?? id);
  const run = async (action: OpenAction) => {
    setMessage(null);
    const result = await window.fractal.files.open(action, root, path, line).catch((): OpenResult => ({ ok: false, message: 'Couldn\'t open this file' }));
    if (result.ok === false) { setMessage(result.message); return; }
    // Show in folder does not open the file, so it never becomes the button's action.
    if (action !== 'reveal' && action !== remembered) {
      setRemembered(action);
      window.fractal.settings.set({ fileOpener: action }).catch((): void => undefined);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      {message && <span className="text-xs text-destructive" role="status">{message}</span>}
      <ButtonGroup>
        <Button aria-label={`Open in ${labelFor(opener)}`} className="h-7 gap-1.5 px-2 text-xs" onClick={() => { void run(opener); }} size="sm" type="button" variant="outline">
          <ExternalLink aria-hidden className="size-3.5" />
          Open
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label="Choose how to open" className="h-7 px-1.5" size="sm" type="button" variant="outline">
              <ChevronDown aria-hidden className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {editors.map((editor) => (
              <DropdownMenuItem key={editor.id} onSelect={() => { void run(editor.id); }}>{editor.label}</DropdownMenuItem>
            ))}
            {editors.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => { void run('system'); }}>{SYSTEM_LABEL}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { void run('reveal'); }}>Show in folder</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
    </div>
  );
}
