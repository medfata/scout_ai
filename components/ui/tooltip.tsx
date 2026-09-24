"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Slot } from "@/components/ui/slot";

/**
 * shadcn/ui Tooltip (new-york style), CSS-only instead of `@radix-ui/react-tooltip`
 * (section 0 rule 2: no new dependencies). It appears on hover and on keyboard
 * focus (`:focus-within`), which is the reachable subset of Radix's behaviour;
 * there is no touch affordance and no collision detection.
 */
function TooltipProvider({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

function Tooltip({ className, children, ...props }: React.ComponentProps<"span">) {
  return (
    <span data-slot="tooltip" className={cn("group/tooltip relative inline-flex", className)} {...props}>
      {children}
    </span>
  );
}

export interface TooltipTriggerProps extends React.ComponentProps<"span"> {
  asChild?: boolean;
}

function TooltipTrigger({ asChild = false, children, ...props }: TooltipTriggerProps) {
  if (asChild) {
    return (
      <Slot data-slot="tooltip-trigger" {...props}>
        {children}
      </Slot>
    );
  }
  return (
    <span data-slot="tooltip-trigger" {...props}>
      {children}
    </span>
  );
}

const tooltipContentVariants = cva(
  "bg-primary text-primary-foreground pointer-events-none absolute z-50 w-fit max-w-[16rem] rounded-md px-3 py-1.5 text-xs text-balance opacity-0 shadow-md transition-opacity group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100",
  {
    variants: {
      side: {
        top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
        bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
        left: "top-1/2 right-full mr-1.5 -translate-y-1/2",
        right: "top-1/2 left-full ml-1.5 -translate-y-1/2",
      },
    },
    defaultVariants: {
      side: "top",
    },
  },
);

export interface TooltipContentProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof tooltipContentVariants> {}

function TooltipContent({ className, side, children, ...props }: TooltipContentProps) {
  return (
    <span
      role="tooltip"
      data-slot="tooltip-content"
      data-side={side ?? "top"}
      className={cn(tooltipContentVariants({ side }), className)}
      {...props}
    >
      {children}
    </span>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
