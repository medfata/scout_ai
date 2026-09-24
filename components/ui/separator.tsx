import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Separator (new-york style). Radix-free: a plain element with
 * `role="separator"` and `aria-orientation`, which is what assistive tech reads.
 */
export interface SeparatorProps extends React.ComponentProps<"div"> {
  orientation?: "horizontal" | "vertical";
  /** Decorative separators are hidden from the accessibility tree. */
  decorative?: boolean;
}

function Separator({ className, orientation = "horizontal", decorative = true, ...props }: SeparatorProps) {
  return (
    <div
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      data-slot="separator"
      data-orientation={orientation}
      className={cn(
        "bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
