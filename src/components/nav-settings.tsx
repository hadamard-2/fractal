import { Settings } from "lucide-react"

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

/**
 * The sidebar footer's single entry: global settings. Replaces the scaffold
 * user menu (accounts don't exist in Fractal). `tooltip` is what shows when
 * the sidebar is collapsed to the icon rail — the label below is hidden by
 * the button's own icon-collapse styles.
 */
export function NavSettings({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="Settings" onClick={onOpenSettings}>
          <Settings />
          <span>Settings</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
