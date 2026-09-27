import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { ConversationImage } from '@/shared/conversation-contract';

const imageSource = (image: ConversationImage): string => `data:${image.mediaType};base64,${image.data}`;

/** Image thumbnails that open full size in a dialog when clicked. */
export function ConversationImages({ images, className }: { images: ConversationImage[]; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {images.map((image, index) => (
        <Dialog key={index}>
          <DialogTrigger
            aria-label={`View image ${index + 1} of ${images.length}`}
            className="overflow-hidden rounded-lg border bg-muted/30 transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <img alt="" className="max-h-28 max-w-52 object-contain" src={imageSource(image)} />
          </DialogTrigger>
          <DialogContent className="w-auto max-w-none border-0 bg-transparent p-0 shadow-none sm:max-w-none">
            <DialogTitle className="sr-only">Image {index + 1} of {images.length}</DialogTitle>
            <DialogDescription className="sr-only">Full-size view</DialogDescription>
            <img alt="" className="max-h-[92vh] max-w-[94vw] rounded-lg border border-foreground/15 object-contain" src={imageSource(image)} />
          </DialogContent>
        </Dialog>
      ))}
    </div>
  );
}
