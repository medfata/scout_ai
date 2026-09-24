"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Slot } from "@/components/ui/slot";

/**
 * shadcn/ui DropdownMenu (new-york style), hand-written without
 * `@radix-ui/react-dropdown-menu` (section 0 rule 2: no new dependencies).
 *
 * Supports the API Scout uses: controlled/uncontrolled open state, `asChild`
 * triggers, labelled items, separators, shortcuts, `align`/`side` and basic
 * keyboard navigation (Escape, ArrowUp/Down, Home/End, Enter/Space).
 * Sub-menus and checkbox/radio items are not implemented.
 */
interface DropdownMenuContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const DropdownMenuContext = React.createContext<DropdownMenuContextValue | null>(null);

function useDropdownMenuContext(component: string): DropdownMenuContextValue {
  const context = React.useContext(DropdownMenuContext);
  if (!context) throw new Error(`${component} must be used inside <DropdownMenu>.`);
  return context;
}

export interface DropdownMenuProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
  className?: string;
}

function DropdownMenu({ open, defaultOpen = false, onOpenChange, children, className }: DropdownMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (open === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange],
  );

  const value = React.useMemo(() => ({ open: isOpen, setOpen }), [isOpen, setOpen]);
  return (
    <DropdownMenuContext.Provider value={value}>
      <div data-slot="dropdown-menu" className={cn("relative inline-flex", className)}>
        {children}
      </div>
    </DropdownMenuContext.Provider>
  );
}

export interface DropdownMenuTriggerProps extends React.ComponentProps<"button"> {
  asChild?: boolean;
}

function DropdownMenuTrigger({ asChild = false, children, onClick, ...props }: DropdownMenuTriggerProps) {
  const { open, setOpen } = useDropdownMenuContext("DropdownMenuTrigger");
  const handleClick: React.MouseEventHandler<HTMLElement> = (event) => {
    onClick?.(event as React.MouseEvent<HTMLButtonElement>);
    if (!event.defaultPrevented) setOpen(!open);
  };

  if (asChild) {
    return (
      <Slot
        data-slot="dropdown-menu-trigger"
        aria-haspopup="menu"
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
      data-slot="dropdown-menu-trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      data-state={open ? "open" : "closed"}
      onClick={handleClick}
      {...props}
    >
      {children}
    </button>
  );
}

export interface DropdownMenuContentProps extends React.ComponentProps<"div"> {
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  sideOffset?: number;
}

function DropdownMenuContent({
  className,
  align = "start",
  side = "bottom",
  sideOffset = 4,
  children,
  ...props
}: DropdownMenuContentProps) {
  const { open, setOpen } = useDropdownMenuContext("DropdownMenuContent");
  const contentRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      // The wrapper (trigger + content) is the positioned ancestor, so clicks on
      // the trigger do not count as "outside".
      const wrapper = contentRef.current?.parentElement;
      if (target && wrapper && !wrapper.contains(target)) setOpen(false);
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
  }, [open, setOpen]);

  React.useEffect(() => {
    if (!open) return;
    const first = contentRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])');
    first?.focus();
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])') ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  return (
    <div
      ref={contentRef}
      role="menu"
      data-slot="dropdown-menu-content"
      data-state="open"
      style={{ [side === "bottom" ? "top" : "bottom"]: `calc(100% + ${sideOffset}px)` }}
      className={cn(
        "bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 absolute z-50 max-h-96 min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md",
        align === "start" && "left-0",
        align === "center" && "left-1/2 -translate-x-1/2",
        align === "end" && "right-0",
        className,
      )}
      onKeyDown={onKeyDown}
      {...props}
    >
      {children}
    </div>
  );
}

function DropdownMenuGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div role="group" data-slot="dropdown-menu-group" className={className} {...props} />;
}

export interface DropdownMenuItemProps extends React.ComponentProps<"div"> {
  inset?: boolean;
  variant?: "default" | "destructive";
  onSelect?: (event: React.MouseEvent<HTMLDivElement>) => void;
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  onSelect,
  onClick,
  onKeyDown,
  ...props
}: DropdownMenuItemProps) {
  const { setOpen } = useDropdownMenuContext("DropdownMenuItem");
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      data-slot="dropdown-menu-item"
      data-inset={inset ? "" : undefined}
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[inset]:pl-8 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        onSelect?.(event);
        setOpen(false);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      {...props}
    />
  );
}

function DropdownMenuLabel({ className, inset, ...props }: React.ComponentProps<"div"> & { inset?: boolean }) {
  return (
    <div
      data-slot="dropdown-menu-label"
      data-inset={inset ? "" : undefined}
      className={cn("px-2 py-1.5 text-sm font-medium data-[inset]:pl-8", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      data-slot="dropdown-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("text-muted-foreground ml-auto text-xs tracking-widest", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
};
