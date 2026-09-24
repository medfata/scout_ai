"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Tabs (new-york style), hand-written without `@radix-ui/react-tabs`
 * (section 0 rule 2: no new dependencies). Controlled/uncontrolled value,
 * ARIA tablist semantics and Arrow/Home/End keyboard navigation are included.
 */
interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
  orientation: "horizontal" | "vertical";
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error(`${component} must be used inside <Tabs>.`);
  return context;
}

export interface TabsProps extends React.ComponentProps<"div"> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: "horizontal" | "vertical";
}

function Tabs({
  className,
  value,
  defaultValue = "",
  onValueChange,
  orientation = "horizontal",
  children,
  ...props
}: TabsProps) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue);
  const resolvedValue = value ?? uncontrolledValue;

  const setValue = React.useCallback(
    (next: string) => {
      if (value === undefined) setUncontrolledValue(next);
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  const contextValue = React.useMemo(
    () => ({ value: resolvedValue, setValue, orientation }),
    [resolvedValue, setValue, orientation],
  );

  return (
    <TabsContext.Provider value={contextValue}>
      <div data-slot="tabs" data-orientation={orientation} className={cn("flex flex-col gap-2", className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

function TabsList({ className, ...props }: React.ComponentProps<"div">) {
  const { orientation } = useTabsContext("TabsList");
  return (
    <div
      role="tablist"
      aria-orientation={orientation}
      data-slot="tabs-list"
      className={cn(
        "bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]",
        orientation === "vertical" && "h-fit flex-col",
        className,
      )}
      {...props}
    />
  );
}

export interface TabsTriggerProps extends React.ComponentProps<"button"> {
  value: string;
}

function TabsTrigger({ className, value, onClick, onKeyDown, ...props }: TabsTriggerProps) {
  const { value: selectedValue, setValue, orientation } = useTabsContext("TabsTrigger");
  const isSelected = selectedValue === value;

  const moveFocus = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const list = event.currentTarget.parentElement;
    if (!list) return;
    const triggers = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'));
    const index = triggers.indexOf(event.currentTarget);
    const forward = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
    const backward = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";

    let next: HTMLElement | undefined;
    if (event.key === forward) next = triggers[(index + 1) % triggers.length];
    else if (event.key === backward) next = triggers[(index - 1 + triggers.length) % triggers.length];
    else if (event.key === "Home") next = triggers[0];
    else if (event.key === "End") next = triggers[triggers.length - 1];
    if (!next) return;

    event.preventDefault();
    next.focus();
  };

  return (
    <button
      type="button"
      role="tab"
      id={`tab-${value}`}
      aria-selected={isSelected}
      aria-controls={`tabpanel-${value}`}
      data-slot="tabs-trigger"
      data-state={isSelected ? "active" : "inactive"}
      tabIndex={isSelected ? 0 : -1}
      className={cn(
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring text-foreground dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:shadow-sm dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setValue(value);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        moveFocus(event);
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setValue(value);
        }
      }}
      {...props}
    />
  );
}

export interface TabsContentProps extends React.ComponentProps<"div"> {
  value: string;
  forceMount?: boolean;
}

function TabsContent({ className, value, forceMount = false, ...props }: TabsContentProps) {
  const { value: selectedValue } = useTabsContext("TabsContent");
  const isSelected = selectedValue === value;
  if (!isSelected && !forceMount) return null;

  return (
    <div
      role="tabpanel"
      id={`tabpanel-${value}`}
      aria-labelledby={`tab-${value}`}
      hidden={!isSelected}
      data-slot="tabs-content"
      data-state={isSelected ? "active" : "inactive"}
      tabIndex={0}
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
