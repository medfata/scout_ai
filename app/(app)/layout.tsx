import { requireOwner } from "@/src/lib/session";

import { AppNav } from "./nav";

/**
 * Section 10: the `(app)` route group is everything behind the login. The layout
 * checks the session once for every screen (each Server Action re-checks it on
 * its own, per section 8) and renders the fixed console shell: a dense left
 * sidebar plus the page.
 */

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const owner = await requireOwner();

  return (
    <div className="flex min-h-svh">
      <AppNav email={owner.email} />
      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1600px] px-6 py-5">{children}</div>
      </main>
    </div>
  );
}
