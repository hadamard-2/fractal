'use client';

import { motion } from 'motion/react';
import { Blocks, FolderPlus, MessageCirclePlus, Search } from 'lucide-react';
import { useRef } from 'react';
import { NavSettings } from '@/components/nav-settings';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import type { NavSelection, Route } from '@/components/sidebar-03/nav-main';
import DashboardNavigation from '@/components/sidebar-03/nav-main';

const dashboardRoutes: Route[] = [
  {
    id: 'web-dashboard',
    title: 'Web Dashboard',
    link: '#',
    subs: [
      {
        title: 'Layout refactor',
        link: '#',
      },
      {
        title: 'Dark mode rollout',
        link: '#',
      },
      {
        title: 'Performance audit',
        link: '#',
      },
    ],
  },
  {
    id: 'mobile-app',
    title: 'Mobile App',
    link: '#',
    subs: [
      {
        title: 'Offline sync',
        link: '#',
      },
      {
        title: 'Push notifications',
        link: '#',
      },
    ],
  },
  {
    id: 'api-gateway',
    title: 'API Gateway',
    link: '#',
    subs: [
      {
        title: 'Rate limiting',
        link: '#',
      },
      {
        title: 'Auth migration',
        link: '#',
      },
      {
        title: 'v2 endpoints',
        link: '#',
      },
    ],
  },
  {
    id: 'docs-site',
    title: 'Docs Site',
    link: '#',
    subs: [
      { title: 'Getting-started rewrite', link: '#' },
      { title: 'Search indexing', link: '#' },
    ],
  },
  {
    id: 'infra',
    title: 'Infra',
    link: '#',
    subs: [
      { title: 'K8s migration', link: '#' },
      { title: 'Cost review', link: '#' },
      { title: 'On-call handoff', link: '#' },
    ],
  },
];

/*
 * Widths for the drag-to-resize handle, in px. The sidebar's own geometry is
 * CSS-var driven (`--sidebar-width`, 16rem default), so a chosen size is
 * injected as a pixel value and every consumer — gap, fixed container, inset
 * margin — follows.
 */
const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_MAX_WIDTH = 480;
// Released narrower than this, the drag ends in a collapse instead of a size.
const SIDEBAR_COLLAPSE_BELOW = 200;
// Hard floor while actively dragging so the panel stays visible and grabbable.
const SIDEBAR_DRAG_FLOOR = 120;

const clampSidebarWidth = (width: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_DRAG_FLOOR, width));

/**
 * A grab strip on the sidebar's right edge. Lives inside the fixed sidebar
 * container (its nearest positioned ancestor), so it tracks that container's
 * true right side — including the floating variant's outer padding gutter.
 *
 * While dragging it reports sizes upward live and flags resizing via
 * `onResizingChange`; ExecuteMode hangs a data attribute off the provider
 * from that flag to suspend the width transitions, which would otherwise
 * lag 200ms behind the cursor.
 */
function SidebarResizeHandle({
  width,
  onWidthChange,
  onCollapse,
  onResizingChange,
}: {
  width?: number | null;
  onWidthChange?: (width: number) => void;
  onCollapse?: () => void;
  onResizingChange?: (resizing: boolean) => void;
}) {
  const { state, isMobile } = useSidebar();
  // Set on pointerdown, read on move/up; also the "is a drag active" marker.
  const dragOrigin = useRef<{ x: number; width: number } | null>(null);

  // No resize affordance on the mobile sheet or the collapsed icon rail.
  if (isMobile || state === 'collapsed') return null;

  const currentWidth = width ?? SIDEBAR_DEFAULT_WIDTH;

  return (
    <div
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none select-none transition-colors hover:bg-sidebar-border/60"
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onWidthChange?.(clampSidebarWidth(currentWidth - 16));
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          onWidthChange?.(clampSidebarWidth(currentWidth + 16));
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const container = event.currentTarget.closest(
          '[data-slot="sidebar-container"]'
        );
        dragOrigin.current = {
          x: event.clientX,
          width:
            container?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT_WIDTH,
        };
        // Keep move/up events flowing to this element even when the cursor
        // leaves the strip.
        event.currentTarget.setPointerCapture(event.pointerId);
        onResizingChange?.(true);
      }}
      onPointerMove={(event) => {
        const origin = dragOrigin.current;
        if (!origin) return;
        onWidthChange?.(
          clampSidebarWidth(origin.width + event.clientX - origin.x)
        );
      }}
      onPointerUp={(event) => {
        const origin = dragOrigin.current;
        if (!origin) return;
        dragOrigin.current = null;
        onResizingChange?.(false);
        const finalWidth = origin.width + event.clientX - origin.x;
        // Below the threshold the drag ends in a collapse, and the stored
        // size is cleared rather than kept: the live-dragged value down here
        // is the too-small width that caused the collapse, and re-expanding
        // should land on the default, not on that.
        if (finalWidth < SIDEBAR_COLLAPSE_BELOW) {
          onWidthChange?.(null);
          onCollapse?.();
        } else {
          onWidthChange?.(clampSidebarWidth(finalWidth));
        }
      }}
      role="separator"
      tabIndex={0}
    />
  );
}

export function DashboardSidebar({
  onOpenSettings,
  selectedId,
  onItemSelect,
  onNewChat,
  width,
  onWidthChange,
  onResizingChange,
  onCollapse,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  // The one Fractal-specific wiring: the footer's entry point into the global
  // settings dialog, passed down from App via ExecuteMode.
  onOpenSettings: () => void;
  // Which nav item is currently picked, owned by ExecuteMode so the header
  // can show its title.
  selectedId?: string;
  // Not named `onSelect`: that would collide with the native DOM prop the
  // `...props` spread hands to <Sidebar>.
  onItemSelect?: (item: NavSelection) => void;
  // Creates a conversation and switches this mode to it; ExecuteMode owns
  // the conversationId state.
  onNewChat?: () => void;
  // Chosen sidebar width in px, owned by App for the same reason as the
  // open/collapsed state. Null means the 16rem default.
  width?: number | null;
  onWidthChange?: (width: number | null) => void;
  onResizingChange?: (resizing: boolean) => void;
  onCollapse?: () => void;
}) {
  const { state } = useSidebar();
  const isCollapsed = state === 'collapsed';

  return (
    <Sidebar collapsible="icon" variant="floating" {...props}>
      <SidebarHeader
        className={cn(
          'flex md:pt-3.5',
          // Collapsed rail: drop the wordmark and centre what's left, so the
          // logo mark lines up with the icon column below it.
          //
          // Expanded: the header's own p-2 gives 8px, but the nav icons below
          // sit at 16px (SidebarContent px-2 + button px-2), so bump the
          // header to pl-4 to line the logo mark up with them.
          isCollapsed
            ? 'flex-row items-center justify-center gap-y-4 md:flex-col'
            : 'flex-row items-center justify-between pl-4'
        )}
      >
        <a className="flex items-center gap-2" href="#">
          <Blocks className="size-5" />
          <span
            className={cn(
              'font-semibold text-foreground',
              isCollapsed && 'hidden'
            )}
          >
            Fractal
          </span>
        </a>

        <motion.div
          animate={{ opacity: 1 }}
          className={cn(
            'flex items-center gap-2',
            isCollapsed ? 'flex-row md:flex-col-reverse' : 'flex-row'
          )}
          initial={{ opacity: 0 }}
          key={isCollapsed ? 'header-collapsed' : 'header-expanded'}
          transition={{ duration: 0.8 }}
        >
          {/*
            Placeholder for search — a command palette lives here eventually.
            size-4 to match the nav items' icon treatment below.
          */}
          <Button
            aria-label="Search"
            className="rounded-full"
            size="icon"
            title="Search"
            variant="ghost"
          >
            <Search className="size-4" />
          </Button>
        </motion.div>
      </SidebarHeader>
      {/* scrollbar-minimal: same thin-thumb treatment as the conversation
          panel — the OS default reads as a heavy grey slab against these
          surfaces (see index.css). */}
      <SidebarContent className="scrollbar-minimal gap-4 px-2 py-4">
        {/*
          Quick actions above the navigation. New Chat is wired to real
          conversation creation via `onNewChat` from ExecuteMode; New
          Project is still a placeholder, same as the search button
          upstairs. The menu-button primitive handles the collapsed rail on
          its own: label truncates away, icon centres, and the tooltip
          carries the name.
        */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="New Project">
              <FolderPlus />
              <span>New Project</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onNewChat} tooltip="New Chat">
              <MessageCirclePlus />
              <span>New Chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {/*
          px-0: the group's own p-2 would stack on SidebarContent's px-2 and
          push the item icons past the 16px inset the logo header matches.
        */}
        <SidebarGroup className="px-0">
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <DashboardNavigation
              onSelect={onItemSelect}
              routes={dashboardRoutes}
              selectedId={selectedId}
            />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-2">
        <NavSettings onOpenSettings={onOpenSettings} />
      </SidebarFooter>
      <SidebarResizeHandle
        onCollapse={onCollapse}
        onResizingChange={onResizingChange}
        onWidthChange={onWidthChange}
        width={width}
      />
    </Sidebar>
  );
}
