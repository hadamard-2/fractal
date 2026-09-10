'use client';

import { EllipsisVertical, Folder, FolderOpen } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuItem as SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

export type Route = {
  id: string;
  title: string;
  icon?: React.ReactNode;
  link: string;
  subs?: {
    title: string;
    link: string;
    icon?: React.ReactNode;
  }[];
};

export type NavSelection = {
  id: string;
  title: string;
  // Title of the project this item lives under; standalone leaves have
  // none. Feeds the header breadcrumb's ancestor segment.
  section?: string;
};

export default function DashboardNavigation({
  routes,
  selectedId,
  onSelect,
}: {
  routes: Route[];
  selectedId?: string;
  onSelect?: (item: NavSelection) => void;
}) {
  const { state } = useSidebar();
  const isCollapsed = state === 'collapsed';
  // A Set, not a single id: sections are independent, so any number of them
  // can be expanded at once.
  const [openSectionIds, setOpenSectionIds] = useState<Set<string>>(
    () => new Set()
  );

  return (
    <SidebarMenu>
      {routes.map((route) => {
        // The rail carries no per-project UI by design ("the icon-only strip
        // carries no per-item icons"). Rendering the buttons anyway left
        // empty, invisible squares that still lit up on hover.
        if (isCollapsed) return null;

        const isOpen = openSectionIds.has(route.id);
        const hasSubRoutes = !!route.subs?.length;

        return (
          <SidebarMenuItem key={route.id}>
            {hasSubRoutes ? (
              <>
                <Collapsible
                  className="w-full"
                  onOpenChange={(open) =>
                    setOpenSectionIds((prev) => {
                      const next = new Set(prev);
                      if (open) {
                        next.add(route.id);
                      } else {
                        next.delete(route.id);
                      }
                      return next;
                    })
                  }
                  open={isOpen}
                >
                  {/*
                    Adapted from the upstream block: it targets Base UI
                    (`render={...}` + next/link); these primitives are Radix,
                    so triggers compose with `asChild` and links are plain
                    anchors.
                  */}
                  {/* No isActive here on purpose: projects are pure folders
                      — clicking expands/collapses, and only chats carry the
                      selected look. Expansion itself adds no colour. */}
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton className="flex w-full items-center rounded-lg px-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground">
                      {/*
                        Folder idiom: closed section = closed folder, expanded
                        section = open one. The rail renders no items at all,
                        so no collapsed handling is needed here.
                      */}
                      {isOpen ? (
                        <FolderOpen className="size-4" />
                      ) : (
                        <Folder className="size-4" />
                      )}
                      <span className="ml-2 flex-1 truncate font-normal text-sm">
                        {route.title}
                      </span>
                    </SidebarMenuButton>
                  </CollapsibleTrigger>

                  <CollapsibleContent>
                    <SidebarMenuSub className="my-1 ml-3.5">
                      {route.subs?.map((subRoute) => {
                        // Same composite the item is keyed by: subs carry no
                        // id of their own.
                        const subId = `${route.id}-${subRoute.title}`;
                        return (
                          <SidebarMenuSubItem className="h-auto" key={subId}>
                            <SidebarMenuSubButton
                              asChild
                              isActive={selectedId === subId}
                            >
                              <a
                                className="flex items-center rounded-md px-4 py-1.5 font-normal text-muted-foreground text-sm hover:bg-sidebar-accent hover:text-foreground"
                                href={subRoute.link}
                                onClick={() =>
                                  onSelect?.({
                                    id: subId,
                                    title: subRoute.title,
                                    section: route.title,
                                  })
                                }
                              >
                                {/*
                                  Span, not bare text: the sub-button
                                  primitive truncates its last span child,
                                  which is what gives long names their
                                  ellipsis.
                                */}
                                <span>{subRoute.title}</span>
                              </a>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        );
                      })}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </Collapsible>
                {/*
                  Row-level actions chip. A sibling of the trigger rather than
                  a child — a button inside the trigger button would be
                  invalid HTML and Radix Slot would mangle it.
                */}
                <SidebarMenuAction
                  aria-label={`Options for ${route.title}`}
                  // Matches the row's own muted tone; the primitive's
                  // default foreground reads a step too dark next to it.
                  className="text-muted-foreground"
                  onClick={(event) => {
                    // Placeholder for the project menu; nothing to open yet.
                    event.stopPropagation();
                  }}
                >
                  <EllipsisVertical />
                </SidebarMenuAction>
              </>
            ) : (
              <SidebarMenuButton
                asChild
                className={cn(
                  'flex items-center rounded-lg px-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground',
                  isCollapsed && 'justify-center'
                )}
                isActive={selectedId === route.id}
                onClick={() =>
                  onSelect?.({ id: route.id, title: route.title })
                }
                tooltip={route.title}
              >
                <a href={route.link}>
                  {route.icon}
                  {!isCollapsed && (
                    <span className="ml-2 truncate font-normal text-sm">
                      {route.title}
                    </span>
                  )}
                </a>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
