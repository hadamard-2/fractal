import type { SVGProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * Fractal's mark: the lucide "blocks" glyph that assets/icon.svg is drawn
 * from, inlined so its detached block can take the brand colour while the
 * rest follows `currentColor`; `monochrome` draws the block in `currentColor`
 * too. Keep the paths in step with that file.
 */
export function FractalMark({ className, monochrome = false, ...props }: SVGProps<SVGSVGElement> & { monochrome?: boolean }) {
  return (
    <svg
      aria-hidden
      className={cn('size-6', className)}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2" />
      <rect className={monochrome ? undefined : 'stroke-primary-text'} height="8" rx="1" width="8" x="14" y="2" />
    </svg>
  );
}
