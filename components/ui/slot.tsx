import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Dependency-free stand-in for Radix's `Slot` (section 0 rule 2 forbids new
 * dependencies). It lets components support `asChild`, the shadcn convention for
 * rendering a component's styles onto a caller-supplied element — for example
 * `<Button asChild><Link href="/leads">Leads</Link></Button>`.
 *
 * It merges `className` and passes every other prop to the child. Like Radix's
 * Slot it expects exactly one element child.
 */

export interface SlotProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
}

export function Slot({ children, className, ...props }: SlotProps): React.ReactElement {
  if (!React.isValidElement(children)) {
    throw new Error(
      "Slot expects exactly one React element child. Pass the element to style, or drop `asChild`.",
    );
  }
  const child = children as React.ReactElement<{ className?: string }>;
  const merged: React.HTMLAttributes<HTMLElement> = {
    ...props,
    className: cn(className, child.props.className),
  };
  return React.cloneElement(child, merged);
}
