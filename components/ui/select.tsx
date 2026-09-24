"use client";

import * as React from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Select (new-york style), hand-written without
 * `@radix-ui/react-select` (section 0 rule 2: no new dependencies).
 *
 * The API stays close to shadcn's: `Select`, `SelectTrigger`, `SelectValue`,
 * `SelectContent`, `SelectItem`, plus `SelectGroup`/`SelectLabel`/`SelectSeparator`.
 * `SelectValue` resolves the selected item's label by walking the element tree,
 * so no extra props are needed. Only single selection is supported.
 */
interface SelectContextValue {
  value: string | undefined;
  setValue: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  disabled: boolean;
  labels: ReadonlyMap<string, React.ReactNode>;
  triggerId: string;
  contentId: string;
}

const SelectContext = React.createContext<SelectContextValue | null>(null);

function useSelectContext(component: string): SelectContextValue {
  const context = React.useContext(SelectContext);
  if (!context) throw new Error(`${component} must be used inside <Select>.`);
  return context;
}

function collectLabels(children: React.ReactNode, labels: Map<string, React.ReactNode>): void {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === SelectItem) {
      const item = child.props as SelectItemProps;
      if (typeof item.value === "string") labels.set(item.value, item.children);
      return;
    }
    if (child.type === React.Fragment) {
      collectLabels((child.props as { children?: React.ReactNode }).children, labels);
      return;
    }
    const nested = (child.props as { children?: React.ReactNode }).children;
    if (nested) collectLabels(nested, labels);
  });
}

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  children?: React.ReactNode;
  className?: string;
}

function Select({ value, defaultValue, onValueChange, disabled = false, children, className }: SelectProps) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState<string | undefined>(defaultValue);
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const reactId = React.useId();
  const resolvedValue = value ?? uncontrolledValue;

  const setValue = React.useCallback(
    (next: string) => {
      if (value === undefined) setUncontrolledValue(next);
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  const labels = React.useMemo(() => {
    const map = new Map<string, React.ReactNode>();
    collectLabels(children, map);
    return map;
  }, [children]);

  React.useEffect(() => {
    if (!open) return;
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
  }, [open]);

  const contextValue = React.useMemo<SelectContextValue>(
    () => ({
      value: resolvedValue,
      setValue,
      open,
      setOpen,
      disabled,
      labels,
      triggerId: `${reactId}-trigger`,
      contentId: `${reactId}-content`,
    }),
    [resolvedValue, setValue, open, disabled, labels, reactId],
  );

  return (
    <SelectContext.Provider value={contextValue}>
      <div ref={rootRef} data-slot="select" data-state={open ? "open" : "closed"} className={cn("relative w-fit", className)}>
        {children}
      </div>
    </SelectContext.Provider>
  );
}

export interface SelectTriggerProps extends React.ComponentProps<"button"> {
  asChild?: boolean;
}

function SelectTrigger({ className, children, onClick, onKeyDown, ...props }: SelectTriggerProps) {
  const { open, setOpen, disabled, triggerId, contentId } = useSelectContext("SelectTrigger");
  return (
    <button
      type="button"
      id={triggerId}
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-controls={contentId}
      data-slot="select-trigger"
      data-state={open ? "open" : "closed"}
      disabled={disabled}
      className={cn(
        "border-input focus-visible:border-ring focus-visible:ring-ring/50 data-[placeholder]:text-muted-foreground flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setOpen(!open);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setOpen(true);
        }
      }}
      {...props}
    >
      {children}
      <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
    </button>
  );
}

function SelectValue({ className, children, placeholder, ...props }: React.ComponentProps<"span"> & { placeholder?: string }) {
  const { value, labels } = useSelectContext("SelectValue");
  const label = value === undefined ? undefined : labels.get(value);
  return (
    <span
      data-slot="select-value"
      data-placeholder={value === undefined ? "" : undefined}
      className={cn("data-[placeholder]:text-muted-foreground line-clamp-1 flex items-center gap-2", className)}
      {...props}
    >
      {children ?? label ?? placeholder ?? value}
    </span>
  );
}

export interface SelectContentProps extends React.ComponentProps<"div"> {
  sideOffset?: number;
}

function SelectContent({ className, children, sideOffset = 4, ...props }: SelectContentProps) {
  const { open, triggerId, contentId } = useSelectContext("SelectContent");
  const contentRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const selected = contentRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]:not([data-disabled])');
    const first = contentRef.current?.querySelector<HTMLElement>('[role="option"]:not([data-disabled])');
    (selected ?? first)?.focus();
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>('[role="option"]:not([data-disabled])') ?? [],
    );
    const index = options.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      options[(index + 1) % options.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      options[(index - 1 + options.length) % options.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      options[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      options[options.length - 1]?.focus();
    }
  };

  return (
    <div
      ref={contentRef}
      id={contentId}
      role="listbox"
      aria-labelledby={triggerId}
      data-slot="select-content"
      data-state="open"
      style={{ top: `calc(100% + ${sideOffset}px)` }}
      className={cn(
        "bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 absolute left-0 z-50 max-h-96 w-full min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md",
        className,
      )}
      onKeyDown={onKeyDown}
      {...props}
    >
      {children}
    </div>
  );
}

function SelectGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div role="group" data-slot="select-group" className={className} {...props} />;
}

function SelectLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="select-label" className={cn("text-muted-foreground px-2 py-1.5 text-xs", className)} {...props} />;
}

export interface SelectItemProps extends React.ComponentProps<"div"> {
  value: string;
}

function SelectItem({ className, value, children, onClick, onKeyDown, ...props }: SelectItemProps) {
  const { value: selectedValue, setValue, setOpen } = useSelectContext("SelectItem");
  const isSelected = selectedValue === value;

  const select = () => {
    setValue(value);
    setOpen(false);
  };

  return (
    <div
      role="option"
      tabIndex={-1}
      aria-selected={isSelected}
      data-slot="select-item"
      data-state={isSelected ? "checked" : "unchecked"}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) select();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      }}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        {isSelected ? <CheckIcon className="size-4" /> : null}
      </span>
      {children}
    </div>
  );
}

function SelectSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      data-slot="select-separator"
      className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue };
