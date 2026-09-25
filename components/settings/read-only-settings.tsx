import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { LinkedinMode } from "@/src/domain/types";

/**
 * Values that live outside the `settings` row on purpose, shown read-only so the owner can
 * see what is actually in force without a Vercel dashboard visit. Section 0 locks LinkedIn
 * mode for v1 and section 4/D7 keeps model ids in env.
 */

export interface ReadOnlySettingsProps {
  linkedinMode: LinkedinMode;
  modelCopy: string;
  modelResearch: string;
  dryRun: boolean;
  requiresConsentGeos: string[];
}

export function ReadOnlySettings(props: ReadOnlySettingsProps) {
  const facts: Array<{ label: string; value: string; reason: string }> = [
    {
      label: "LINKEDIN_MODE",
      value: props.linkedinMode,
      reason: "Locked for v1 (section 0): Scout creates tasks and you click send. Automated mode is a later, owner-approved upgrade.",
    },
    {
      label: "MODEL_COPY",
      value: props.modelCopy,
      reason: "IDs live in env (section 4/D7). Change it in Vercel, never in the browser.",
    },
    {
      label: "MODEL_RESEARCH",
      value: props.modelResearch,
      reason: "IDs live in env. Research runs on the free Gemini tier against public company pages only.",
    },
    {
      label: "DRY_RUN",
      value: props.dryRun ? "true" : "false",
      reason: "Set by env. Local and preview always run with DRY_RUN=true (section 10 rule 9); the banner above explains what it rewrites.",
    },
    {
      label: "Consent-required geos",
      value: props.requiresConsentGeos.length > 0 ? props.requiresConsentGeos.join(", ") : "none",
      reason: "Section 9: countries excluded from cold email unless consent is handled. Read-only here until a later pass adds the editor.",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fixed by env or locked for v1</CardTitle>
        <CardDescription>
          These cannot be edited on this page. Each one says why, per section 0&apos;s decision rules.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          {facts.map((fact) => (
            <div key={fact.label} className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[12rem_minmax(0,1fr)]">
              <dt className="flex items-center gap-2">
                <Badge variant="outline">read-only</Badge>
                <span className="font-mono text-xs">{fact.label}</span>
              </dt>
              <dd className="space-y-1">
                <p className="font-mono text-sm break-all">{fact.value}</p>
                <p className="text-sm text-muted-foreground">{fact.reason}</p>
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
