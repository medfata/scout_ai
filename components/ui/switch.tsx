"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Switch (new-york style), a `<button role="switch">` instead of
 * `@radix-ui/react-switch` (section 0 rule 2: no new dependencies).
 * Supports controlled (`checked` + `onCheckedChange`) and uncontrolled
 * (`defaultChecked`) use, like the Radix original.
 */
export interface SwitchProps extends Omit<React.ComponentProps<"button">, "onChange" | "type" | "value"> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

function Switch({ className, checked, defaultChecked = false, onClick, onCheckedChange, ...props }: SwitchProps) {
  const [uncontrolledChecked, setUncontrolledChecked] = React.useState(defaultChecked);
  const isChecked = checked ?? uncontrolledChecked;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isChecked}
      data-slot="switch"
      data-state={isChecked ? "checked" : "unchecked"}
      className={cn(
        "peer focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-[1.15rem] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        const next = !isChecked;
        if (checked === undefined) setUncontrolledChecked(next);
        onCheckedChange?.(next);
      }}
      {...props}
    >
      <span
        data-slot="switch-thumb"
        data-state={isChecked ? "checked" : "unchecked"}
        className={cn(
          "bg-background pointer-events-none block size-4 rounded-full ring-0 transition-transform",
          "data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0",
        )}
      />
    </button>
  );
}

export { Switch };
