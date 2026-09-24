import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui ScrollArea (new-york style). Radix-free: a native scroll container
 * with overscroll containment, so keyboard and touch scrolling behave normally.
 * Custom scrollbar styling is not included; the browser's own bar is used.
 */
function ScrollArea({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="scroll-area" className={cn("relative overflow-hidden", className)} {...props}>
      <div
        data-slot="scroll-area-viewport"
        className="focus-visible:ring-ring/50 size-full overflow-auto overscroll-contain rounded-[inherit] outline-none focus-visible:ring-[3px]"
      >
        {children}
      </div>
    </div>
  );
}

export { ScrollArea };
