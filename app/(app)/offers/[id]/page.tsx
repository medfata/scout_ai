import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { archiveOfferAction } from "@/app/(app)/offers/actions";
import { formatCost, formatWhen } from "@/components/offers/format";
import { GenerateIcpsButton } from "@/components/offers/generate-icps-button";
import { IcpCard } from "@/components/offers/icp-card";
import { OfferEditForm } from "@/components/offers/offer-edit-form";
import { OfferStatusBadge } from "@/components/offers/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Icp } from "@/src/db/schema";
import { lastIcpGeneration, listIcpsForOffer } from "@/src/services/icps";
import { getOffer } from "@/src/services/offers";

export const dynamic = "force-dynamic";

export default async function OfferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const offer = await getOffer(id);
  if (!offer) notFound();

  const [icpList, lastRun] = await Promise.all([listIcpsForOffer(id), lastIcpGeneration(id)]);
  const proposed = icpList.filter((icp) => icp.status === "proposed");
  const approved = icpList.filter((icp) => icp.status === "approved");

  return (
    <div className="space-y-6">
      <Link href="/offers" className="text-sm text-muted-foreground hover:underline">
        ← All offers
      </Link>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-2xl">
                {offer.title}
                <OfferStatusBadge status={offer.status} />
              </CardTitle>
              <p className="max-w-3xl text-sm text-muted-foreground">{offer.description}</p>
              {offer.priceHint ? <p className="text-sm">Price hint: {offer.priceHint}</p> : null}
            </div>
            <div className="flex flex-col items-end gap-2">
              <GenerateIcpsButton offerId={offer.id} hasExisting={icpList.length > 0} />
              <form action={archiveOfferAction}>
                <input type="hidden" name="offerId" value={offer.id} />
                <Button type="submit" variant="outline" size="sm" disabled={offer.status === "archived"}>
                  Archive offer
                </Button>
              </form>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Proof</p>
            {offer.proof.length === 0 ? (
              <Alert>
                <AlertTitle>No proof yet</AlertTitle>
                <AlertDescription>
                  Add a case study, demo or number below. The copywriter may only claim proof that lives here, so ICPs
                  with thin proof score low on proof fit.
                </AlertDescription>
              </Alert>
            ) : (
              <ul className="space-y-2">
                {offer.proof.map((item) => (
                  <li key={`${item.label}-${item.detail}`} className="rounded-md border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{item.label}</p>
                      {item.url ? (
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                        >
                          {item.url} <ExternalLink className="size-3" />
                        </a>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground">{item.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-sm text-muted-foreground">
            {lastRun
              ? `Last generation: ${lastRun.count} ICPs · ${formatCost(lastRun.costUsd)} · ${lastRun.model} · ${formatWhen(lastRun.at)}`
              : "No generation yet. Generate ICPs to see ranked profiles here."}
          </p>

          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">Edit offer</summary>
            <div className="mt-3">
              <OfferEditForm offer={offer} />
            </div>
          </details>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold tracking-tight">ICPs</h2>
          <p className="text-sm text-muted-foreground">
            {proposed.length} proposed · {approved.length} approved
          </p>
        </div>

        {icpList.length === 0 ? (
          <Alert>
            <AlertTitle>No ICPs yet</AlertTitle>
            <AlertDescription>
              Click Generate ICPs above. Scout proposes 3–7 profiles, a critic re-scores them, and code ranks them by
              pain, ability to pay, reachability, proof fit and speed.
            </AlertDescription>
          </Alert>
        ) : (
          <Tabs defaultValue="proposed">
            <TabsList>
              <TabsTrigger value="proposed">Proposed ({proposed.length})</TabsTrigger>
              <TabsTrigger value="approved">Approved ({approved.length})</TabsTrigger>
              <TabsTrigger value="all">All ({icpList.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="proposed" className="mt-4">
              <IcpList icps={proposed} empty="Every proposed ICP has been approved, paused or archived." />
            </TabsContent>
            <TabsContent value="approved" className="mt-4">
              <IcpList icps={approved} empty="No approved ICPs yet. Approve one to make it available for sourcing." />
            </TabsContent>
            <TabsContent value="all" className="mt-4">
              <IcpList icps={icpList} empty="No ICPs yet." />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}

function IcpList({ icps, empty }: { icps: Icp[]; empty: string }) {
  if (icps.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-4">
      {icps.map((icp) => (
        <IcpCard key={icp.id} icp={icp} />
      ))}
    </div>
  );
}
