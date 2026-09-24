import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Section 7: "With DRY_RUN=true, every send is rewritten to the owner's test inbox and
 * tagged as a test." Section 10 rule 9: "Safe by default. Local and preview environments
 * run with DRY_RUN=true." The banner is the one place the owner cannot miss that.
 */
export function DryRunBanner({ redirectEmail }: { redirectEmail: string | null }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Dry run is on — nothing is delivered to prospects</AlertTitle>
      <AlertDescription>
        {redirectEmail ? (
          <>
            Every send is rewritten to <span className="font-medium">{redirectEmail}</span> and tagged as a test
            (<code className="text-xs">X-Scout-Test</code>). Turn <code className="text-xs">DRY_RUN</code> off only after a
            real send lands where you expect it.
          </>
        ) : (
          <>
            <code className="text-xs">DRY_RUN</code> is on but <code className="text-xs">DRY_RUN_REDIRECT_EMAIL</code> is not
            set, so the send guard blocks every email. Set the redirect address to test the pipeline.
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
