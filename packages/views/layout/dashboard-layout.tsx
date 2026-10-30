"use client";

import type { ReactNode } from "react";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@multica/ui/components/ui/sidebar";
import { ModalRegistry } from "../modals/registry";
import { SourceBackfillModal } from "../onboarding";
import { AppSidebar } from "./app-sidebar";
import { DashboardGuard } from "./dashboard-guard";
import { NavigationProgress } from "./navigation-progress";
import { WorkspacePresencePrefetch } from "./workspace-presence-prefetch";
import { GlobalShortcuts } from "./global-shortcuts";

/**
 * Web's own collapse control, parked at the right edge of the sidebar's
 * workspace-switcher row.
 *
 * The desktop shell keeps a `SidebarTrigger` in its window toolbar (beside the
 * traffic lights) and therefore passes `hasExternalTrigger`, which suppresses
 * the page-header fallback. Web has no window chrome to host one, so without
 * this trigger the only way to collapse the nav above `xl` was the invisible
 * rail — the page-header trigger is `xl:hidden` because that is where the
 * in-flow sidebar starts. It sits on the title row rather than in its own strip
 * above the header: collapsing then costs no vertical space, and the icon rail
 * stacks it under the workspace tile.
 */
function SidebarCollapseTrigger() {
  return (
    <SidebarTrigger className="size-7 text-faint-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" />
  );
}

interface DashboardLayoutProps {
  children: ReactNode;
  /** Rendered inside SidebarInset (e.g. ChatWindow, ChatFab — absolute-positioned overlays) */
  extra?: ReactNode;
  /** Rendered inside sidebar header as a search trigger */
  searchSlot?: ReactNode;
  /** Loading indicator */
  loadingIndicator?: ReactNode;
}

export function DashboardLayout({
  children,
  extra,
  searchSlot,
  loadingIndicator,
}: DashboardLayoutProps) {
  return (
    <DashboardGuard
      loadingFallback={
        <div className="flex h-svh items-center justify-center">
          {loadingIndicator}
        </div>
      }
    >
      <SidebarProvider className="h-svh bg-app-shell">
        <GlobalShortcuts />
        <WorkspacePresencePrefetch />
        <AppSidebar headerActionSlot={<SidebarCollapseTrigger />} searchSlot={searchSlot} />
        <SidebarInset className="relative overflow-hidden">
          <NavigationProgress />
          {children}
          <ModalRegistry />
          <SourceBackfillModal />
          {extra}
        </SidebarInset>
      </SidebarProvider>
    </DashboardGuard>
  );
}
