"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  InboxIcon,
  LayoutDashboardIcon,
  MessageSquareIcon,
  RadarIcon,
  SettingsIcon,
  TargetIcon,
  UsersIcon,
} from "lucide-react";

import { SignOutButton } from "@/components/shell/sign-out-button";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { cn } from "@/lib/utils";

/**
 * The console's left sidebar (section 10: `(app)/nav.tsx`).
 *
 * Dense on purpose: 32px rows, monospace micro-labels, one signal-green marker
 * for the active screen. Keyboard-friendly all the way down — every row is a
 * real link with visible focus, and `g` followed by a letter jumps to a screen
 * (for example `g` then `i` for the approval inbox). Shortcuts are ignored while
 * a text field has focus.
 */

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  shortcut: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: "Pipeline",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboardIcon, shortcut: "d" },
      { href: "/offers", label: "Offers & ICPs", icon: TargetIcon, shortcut: "o" },
      { href: "/leads", label: "Leads", icon: UsersIcon, shortcut: "l" },
    ],
  },
  {
    title: "Outreach",
    items: [
      { href: "/inbox", label: "Inbox", icon: InboxIcon, shortcut: "i" },
      { href: "/replies", label: "Replies", icon: MessageSquareIcon, shortcut: "r" },
    ],
  },
  {
    title: "System",
    items: [{ href: "/settings", label: "Settings", icon: SettingsIcon, shortcut: "s" }],
  },
];

const SHORTCUT_TARGETS: Record<string, string> = Object.fromEntries(
  NAV_SECTIONS.flatMap((section) => section.items.map((item) => [item.shortcut, item.href])),
);

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** `g` then a letter navigates, unless the person is typing. */
function useGoShortcuts(): void {
  const router = useRouter();

  React.useEffect(() => {
    let awaitingSecondKey = false;
    let resetTimer: number | undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
      ) {
        return;
      }

      if (awaitingSecondKey) {
        awaitingSecondKey = false;
        if (resetTimer) window.clearTimeout(resetTimer);
        const destination = SHORTCUT_TARGETS[event.key.toLowerCase()];
        if (destination) {
          event.preventDefault();
          router.push(destination);
        }
        return;
      }

      if (event.key.toLowerCase() === "g") {
        awaitingSecondKey = true;
        resetTimer = window.setTimeout(() => {
          awaitingSecondKey = false;
        }, 900);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (resetTimer) window.clearTimeout(resetTimer);
    };
  }, [router]);
}

export function AppNav({ email }: { email: string }) {
  const pathname = usePathname();
  useGoShortcuts();

  return (
    <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border sticky top-0 flex h-svh w-56 shrink-0 flex-col border-r">
      <div className="border-sidebar-border flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <RadarIcon className="text-primary size-4 shrink-0" />
        <Link href="/dashboard" className="micro-label focus-visible:ring-ring/50 rounded-sm outline-none focus-visible:ring-[3px]">
          Scout
        </Link>
        <span className="text-muted-foreground ml-auto font-mono text-[10px]">v1</span>
      </div>

      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto p-2">
        {NAV_SECTIONS.map((section) => (
          <div key={section.title} className="space-y-1">
            <p className="micro-label text-muted-foreground px-3 pt-2">{section.title}</p>
            {section.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  title={`${item.label} — press g then ${item.shortcut}`}
                  className={cn(
                    "group focus-visible:ring-ring/50 relative flex h-8 items-center gap-2 rounded-md pr-2 pl-3 text-[13px] font-medium transition-colors outline-none focus-visible:ring-[3px]",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                >
                  {active ? (
                    <span aria-hidden className="bg-primary absolute inset-y-1 left-0 w-0.5 rounded-full" />
                  ) : null}
                  <item.icon className="size-4 shrink-0 opacity-90" />
                  <span className="truncate">{item.label}</span>
                  <kbd className="text-muted-foreground ml-auto font-mono text-[10px] opacity-0 transition-opacity group-hover:opacity-100">
                    {item.shortcut}
                  </kbd>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-sidebar-border shrink-0 border-t p-2">
        <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <span aria-hidden className="bg-primary size-1.5 shrink-0 rounded-full" />
          <span className="text-muted-foreground truncate font-mono text-[11px]" title={email}>
            {email}
          </span>
          <div className="ml-auto flex items-center">
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </div>
    </aside>
  );
}
