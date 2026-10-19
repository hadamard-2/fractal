import { Panel, useReactFlow } from '@xyflow/react';
import { Maximize, Minus, Plus, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { MapView } from '@/shared/map-contract';

function ControlButton({ label, Icon, onClick }: { label: string; Icon: LucideIcon; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} className="size-7" onClick={onClick} size="icon" type="button" variant="ghost">
          <Icon aria-hidden className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Zoom, fit and the Preview / Full toggle, in the canvas's bottom-left corner, clear of the mode toggle. */
export function MapControls({ view, onViewChange }: { view: MapView; onViewChange: (view: MapView) => void }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <Panel className="flex items-center gap-1 rounded-lg border bg-card p-1 shadow-xs" position="bottom-left">
      <TooltipProvider>
        <ControlButton Icon={Plus} label="Zoom in" onClick={() => { void zoomIn(); }} />
        <ControlButton Icon={Minus} label="Zoom out" onClick={() => { void zoomOut(); }} />
        <ControlButton Icon={Maximize} label="Fit to view" onClick={() => { void fitView(); }} />
      </TooltipProvider>
      <div aria-hidden className="mx-1 h-4 w-px bg-border" />
      <ToggleGroup
        aria-label="Message text"
        onValueChange={(value) => { if (value === 'preview' || value === 'full') onViewChange(value); }}
        size="sm"
        type="single"
        value={view}
      >
        <ToggleGroupItem className="h-7 px-2.5 text-xs" value="preview">Preview</ToggleGroupItem>
        <ToggleGroupItem className="h-7 px-2.5 text-xs" value="full">Full</ToggleGroupItem>
      </ToggleGroup>
    </Panel>
  );
}
