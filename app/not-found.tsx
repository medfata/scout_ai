import Link from "next/link";

import { Button } from "@/components/ui/button";

/** 404 page. Reachable without a session, so it carries no private data. */
export default function NotFound() {
  return (
    <main className="surface-grid flex min-h-svh flex-col items-center justify-center gap-6 p-8">
      <div className="space-y-2 text-center">
        <p className="micro-label text-muted-foreground">Error 404</p>
        <h1 className="text-2xl font-semibold tracking-tight">Nothing at this coordinate</h1>
        <p className="text-muted-foreground max-w-sm text-sm">
          The page you asked for does not exist. Head back to the console.
        </p>
      </div>
      <Button asChild variant="outline">
        <Link href="/dashboard">Go to dashboard</Link>
      </Button>
    </main>
  );
}
