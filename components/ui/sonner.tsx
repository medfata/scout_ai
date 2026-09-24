"use client";

import * as React from "react";
import { CheckCircle2Icon, InfoIcon, TriangleAlertIcon, XCircleIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Toast host in the shape of shadcn/ui's `Toaster` + `sonner` (new-york style).
 *
 * `sonner` is not in section 4's stack and section 0 rule 2 forbids adding it, so
 * this is a dependency-free stand-in with the small API Scout needs:
 * `toast.success("Saved")`, `toast.error(...)`, `toast.warning(...)`,
 * `toast.message(...)`, `toast.dismiss(id)` and `<Toaster />` in a layout.
 * If the owner ever approves `sonner`, only this file changes.
 *
 * The store is a module-level array read through `useSyncExternalStore`, so a
 * toast fired from anywhere in the client tree renders in the single `<Toaster />`.
 */

export type ToastVariant = "default" | "success" | "warning" | "error";

export interface ToastItem {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  variant: ToastVariant;
  duration: number;
}

export interface ToastOptions {
  description?: React.ReactNode;
  /** Milliseconds before auto-dismiss. `0` keeps the toast until dismissed. */
  duration?: number;
  id?: string;
}

let items: ToastItem[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  items = [...items];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function dismiss(id: string): void {
  items = items.filter((item) => item.id !== id);
  emit();
}

function push(variant: ToastVariant, title: React.ReactNode, options: ToastOptions = {}): string {
  const id = options.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const duration = options.duration ?? (variant === "error" ? 8000 : 5000);
  items = [...items.filter((item) => item.id !== id), { id, title, description: options.description, variant, duration }];
  emit();
  if (duration > 0) window.setTimeout(() => dismiss(id), duration);
  return id;
}

export const toast = {
  message: (title: React.ReactNode, options?: ToastOptions) => push("default", title, options),
  success: (title: React.ReactNode, options?: ToastOptions) => push("success", title, options),
  warning: (title: React.ReactNode, options?: ToastOptions) => push("warning", title, options),
  error: (title: React.ReactNode, options?: ToastOptions) => push("error", title, options),
  info: (title: React.ReactNode, options?: ToastOptions) => push("default", title, options),
  dismiss,
};

const ICONS: Record<ToastVariant, React.ComponentType<{ className?: string }>> = {
  default: InfoIcon,
  success: CheckCircle2Icon,
  warning: TriangleAlertIcon,
  error: XCircleIcon,
};

export type ToasterPosition = "top-right" | "bottom-right" | "bottom-left" | "top-left";

const POSITION_CLASSES: Record<ToasterPosition, string> = {
  "top-right": "top-0 right-0",
  "bottom-right": "right-0 bottom-0",
  "bottom-left": "bottom-0 left-0",
  "top-left": "top-0 left-0",
};

export interface ToasterProps {
  position?: ToasterPosition;
  className?: string;
}

function Toaster({ position = "bottom-right", className }: ToasterProps) {
  const current = React.useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  );

  return (
    <div
      data-slot="toaster"
      data-position={position}
      aria-live="polite"
      aria-label="Notifications"
      className={cn(
        "pointer-events-none fixed z-[100] flex max-h-svh w-full flex-col gap-2 p-4 sm:max-w-[420px]",
        POSITION_CLASSES[position],
        className,
      )}
    >
      {current.map((item) => {
        const Icon = ICONS[item.variant];
        return (
          <div
            key={item.id}
            data-slot="toast"
            data-variant={item.variant}
            className={cn(
              "bg-popover text-popover-foreground animate-in fade-in-0 slide-in-from-bottom-2 pointer-events-auto flex items-start gap-3 rounded-lg border p-4 shadow-lg",
              item.variant === "error" && "border-destructive/40",
            )}
          >
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                item.variant === "success" && "text-primary",
                item.variant === "warning" && "text-amber-500",
                item.variant === "error" && "text-destructive",
              )}
            />
            <div className="flex-1 space-y-1">
              <div className="text-sm font-medium">{item.title}</div>
              {item.description ? <div className="text-muted-foreground text-sm">{item.description}</div> : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(item.id)}
              className="text-muted-foreground hover:text-foreground -m-1 rounded-md p-1 transition-colors"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export { Toaster };
