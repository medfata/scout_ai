"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Checkbox (new-york style), built on the native `<input type="checkbox">`
 * instead of `@radix-ui/react-checkbox` (section 0 rule 2: no new dependencies).
 *
 * Native semantics mean `onChange`/`checked` work as expected and the browser
 * draws the tick. `onCheckedChange` is provided for API parity with shadcn.
 */
export interface CheckboxProps extends Omit<React.ComponentProps<"input">, "type"> {
  onCheckedChange?: (checked: boolean) => void;
}

function Checkbox({ className, onCheckedChange, onChange, ...props }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "border-input accent-primary size-4 shrink-0 cursor-pointer rounded-[4px] border shadow-xs transition-shadow outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      onChange={(event) => {
        onChange?.(event);
        onCheckedChange?.(event.target.checked);
      }}
      {...props}
    />
  );
}

export { Checkbox };
