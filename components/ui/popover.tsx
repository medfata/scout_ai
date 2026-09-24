"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Slot } from "@/components/ui/slot";

/**
 * shadcn/ui Popover (new-york style), hand-written without
 * `@radix-ui/react-popover` (section 0 rule 2: no new dependencies).
 * Rendering is inline (no portal): the content is absolutely positioned inside
 * a relative wrapper, closes on outside click and Escape, and focuses the first
 * focusable element when it opens. No collision detection.
 */
interface PopoverContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

function usePopoverContext(component: string): PopoverContextValue {
  const context = React.useContext(PopoverContext);
  if (!context) throw new Error(`${component} must be used inside <Popover>.`);
  return context;
}

export interface PopoverProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
  className?: string;
}

function Popover({ open, defaultOpen = false, onOpenChange, children, className }: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;
  const rootRef = React.useRef<HTMLDivElement>(null);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (open === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange],
  );

  React.useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, setOpen]);

  const value = React.useMemo(() => ({ open: isOpen, setOpen }), [isOpen, setOpen]);
  return (
    <PopoverContext.Provider value={value}>
      <div ref={rootRef} data-slot="popover" className={cn("relative inline-flex", className)}>
        {children}
      </div>
    </PopoverContext.Provider>
  );
}

export interface PopoverTriggerProps extends React.ComponentProps<"button"> {
  asChild?: boolean;
}

function PopoverTrigger({ asChild = false, children, onClick, ...props }: PopoverTriggerProps) {
  const { open, setOpen } = usePopoverContext("PopoverTrigger");
  const handleClick: React.MouseEventHandler<HTMLElement> = (event) => {
    onClick?.(event as React.MouseEvent<HTMLButtonElement>);
    if (!event.defaultPrevented) setOpen(!open);
  };

  if (asChild) {
    return (
      <Slot
        data-slot="popover-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-state={open ? "open" : "closed"}
        onClick={handleClick}
      >
        {children}
      </Slot>
    );
  }
  return (
    <button
      type="button"
      data-slot="popover-trigger"
      aria-haspopup="dialog"
      aria-expanded={open}
      data-state={open ? "open" : "closed"}
      onClick={handleClick}
      {...props}
    >
      {children}
    </button>
  );
}

export interface PopoverContentProps extends React.ComponentProps<"div"> {
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  sideOffset?: number;
}

function PopoverContent({
  className,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  children,
  ...props
}: PopoverContentProps) {
  const { open } = usePopoverContext("PopoverContent");
  const contentRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const focusable = contentRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, button, [href], [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={contentRef}
      data-slot="popover-content"
      data-state="open"
      style={{ [side === "bottom" ? "top" : "bottom"]: `calc(100% + ${sideOffset}px)` }}
      className={cn(
        "bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 absolute z-50 w-72 rounded-md border p-4 shadow-md outline-none",
        align === "start" && "left-0",
        align === "center" && "left-1/2 -translate-x-1/2",
        align === "end" && "right-0",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
