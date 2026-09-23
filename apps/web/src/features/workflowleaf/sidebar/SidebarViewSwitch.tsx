import * as Schema from "effect/Schema";
import type { ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import WorktreeSidebar from "./WorktreeSidebar";

const SIDEBAR_VIEW_KEY = "workflowleaf:sidebar:view";
const SidebarView = Schema.Literals(["threads", "worktrees"]);
type SidebarView = typeof SidebarView.Type;

const VIEW_LABELS: Record<SidebarView, string> = {
  threads: "Threads",
  worktrees: "Worktrees",
};

/**
 * Renders the default thread sidebar or the worktree view, with a switch
 * under both. The choice is per browser, kept in localStorage.
 */
export function SidebarViewSwitch({ threadsView }: { threadsView: ReactNode }) {
  const [view, setView] = useLocalStorage(SIDEBAR_VIEW_KEY, "threads", SidebarView);
  return (
    <>
      {view === "worktrees" ? <WorktreeSidebar /> : threadsView}
      <div
        role="radiogroup"
        aria-label="Sidebar view"
        className="flex shrink-0 gap-1 px-[var(--sidebar-content-inset)] pb-2"
      >
        {SidebarView.literals.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={view === option}
            onClick={() => setView(option)}
            className={cn(
              "h-6 flex-1 cursor-pointer rounded-md text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              view === option && "bg-sidebar-row-hover font-medium text-sidebar-foreground",
            )}
          >
            {VIEW_LABELS[option]}
          </button>
        ))}
      </div>
    </>
  );
}
