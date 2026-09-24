"use client";

import * as React from "react";
import { MoonIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Class-based dark mode. The stored choice lives in `localStorage` under
 * `scout-theme`; `app/layout.tsx` applies it before paint so there is no flash.
 * No `next-themes` dependency (section 0 rule 2).
 */
const STORAGE_KEY = "scout-theme";

export function ThemeToggle() {
  // The class on <html> is the source of truth (applied before paint by the inline
  // script in app/layout.tsx), so it is read through an external store rather than
  // mirrored into component state.
  const dark = React.useSyncExternalStore(subscribeToTheme, isDark, () => false);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-pressed={dark}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      onClick={() => {
        const next = !isDark();
        document.documentElement.classList.toggle("dark", next);
        try {
          window.localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
        } catch {
          // Private browsing mode: the toggle still works for this session.
        }
      }}
    >
      {dark ? <MoonIcon /> : <SunIcon />}
    </Button>
  );
}

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

function subscribeToTheme(onStoreChange: () => void): () => void {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
