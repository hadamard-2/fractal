import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { providerName } from '@/components/sidebar-03/nav-main';
import type { SideChatSummary } from '@/shared/conversation-contract';

/**
 * Asks before deleting `sideChat` and the `nested` side chats inside it, then deletes them. Mount it to open it.
 * `onDeleted` runs once the delete has gone through, and `onClose` after it, or when the user cancels.
 */
export function DeleteSideChatDialog({ sideChat, nested, onDeleted, onClose }: {
  sideChat: SideChatSummary;
  nested: number;
  onDeleted(): void | Promise<void>;
  onClose(): void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    setFailed(false);
    try {
      await window.fractal.conversations.deleteSideChat(sideChat.ref);
    } catch {
      setFailed(true);
      setDeleting(false);
      return;
    }
    await onDeleted();
    onClose();
  };

  const inside = nested === 0 ? 'the side chat' : `the side chat and the ${nested} side ${nested === 1 ? 'chat' : 'chats'} inside it`;
  return (
    <Dialog onOpenChange={(open) => { if (!open && !deleting) onClose(); }} open>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete side chat?</DialogTitle>
          <DialogDescription>{`This deletes ${inside} from the map and from ${providerName(sideChat.ref.provider)}'s own history. It can't be undone.`}</DialogDescription>
        </DialogHeader>
        {failed && <p className="text-sm text-destructive" role="alert">Couldn't delete the side chat.</p>}
        <DialogFooter>
          <Button disabled={deleting} onClick={onClose} type="button" variant="outline">Cancel</Button>
          <Button disabled={deleting} onClick={() => { void confirm(); }} type="button" variant="destructive">Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
