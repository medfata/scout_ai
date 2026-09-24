"use client";

import * as React from "react";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Slot } from "@/components/ui/slot";

/**
 * shadcn/ui Dialog (new-york style), built on the native `<dialog>` element
 * instead of `@radix-ui/react-dialog` (section 0 rule 2: no new dependencies).
 * `showModal()` gives the focus trap, Escape handling and `::backdrop` for free.
 */
interface DialogContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialogContext(component: string): DialogContextValue {
  const context = React.useContext(DialogContext);
  if (!context) throw new Error(`${component} must be used inside <Dialog>.`);
  return context;
}

export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}

function Dialog({ open, defaultOpen = false, onOpenChange, children }: DialogProps) {
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
  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

export interface DialogTriggerProps extends React.ComponentProps<"button"> {
  asChild?: boolean;
}

function DialogTrigger({ asChild = false, children, onClick, ...props }: DialogTriggerProps) {
  const { setOpen } = useDialogContext("DialogTrigger");
  const handleClick: React.MouseEventHandler<HTMLElement> = (event) => {
    onClick?.(event as React.MouseEvent<HTMLButtonElement>);
    if (!event.defaultPrevented) setOpen(true);
  };

  if (asChild) {
    return (
      <Slot data-slot="dialog-trigger" aria-haspopup="dialog" onClick={handleClick}>
        {children}
      </Slot>
    );
  }
  return (
    <button type="button" data-slot="dialog-trigger" aria-haspopup="dialog" onClick={handleClick} {...props}>
      {children}
    </button>
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<"div"> & { showCloseButton?: boolean }) {
  const { open, setOpen } = useDialogContext("DialogContent");
  const dialogRef = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      data-slot="dialog-content"
      data-state={open ? "open" : "closed"}
      onClose={() => setOpen(false)}
      onClick={(event) => {
        // Clicks on ::backdrop target the dialog element itself.
        if (event.target === dialogRef.current) setOpen(false);
      }}
      className={cn(
        "bg-background fixed top-1/2 left-1/2 z-50 m-0 grid max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border p-6 shadow-lg",
        "backdrop:bg-black/50 backdrop:backdrop-blur-[2px]",
        "open:animate-in open:fade-in-0 open:zoom-in-95",
        className,
      )}
      {...(props as React.ComponentProps<"dialog">)}
    >
      {children}
      {showCloseButton ? (
        <DialogClose
          aria-label="Close"
          className="ring-offset-background focus:ring-ring absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none"
        >
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
      ) : null}
    </dialog>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export interface DialogCloseProps extends React.ComponentProps<"button"> {
  asChild?: boolean;
}

function DialogClose({ asChild = false, children, onClick, ...props }: DialogCloseProps) {
  const { setOpen } = useDialogContext("DialogClose");
  const handleClick: React.MouseEventHandler<HTMLElement> = (event) => {
    onClick?.(event as React.MouseEvent<HTMLButtonElement>);
    if (!event.defaultPrevented) setOpen(false);
  };

  if (asChild) {
    return <Slot data-slot="dialog-close" onClick={handleClick}>{children}</Slot>;
  }
  return (
    <button type="button" data-slot="dialog-close" onClick={handleClick} {...props}>
      {children}
    </button>
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
