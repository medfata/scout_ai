import { CreateOfferDialog } from "@/components/offers/create-offer-dialog";
import { OffersTable } from "@/components/offers/offers-table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listOffers } from "@/src/services/offers";

export const dynamic = "force-dynamic";

export default async function OffersPage() {
  const offers = await listOffers();

  const active = offers.filter((item) => item.offer.status === "active").length;
  const icpCount = offers.reduce((sum, item) => sum + item.icpCount, 0);
  const approvedCount = offers.reduce((sum, item) => sum + item.approvedIcpCount, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Offers &amp; ICP studio</h1>
          <p className="text-sm text-muted-foreground">
            Turn what you sell into ranked ideal-customer profiles Scout can source from.
          </p>
        </div>
        <CreateOfferDialog />
      </div>

      {offers.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Start with one offer</CardTitle>
            <CardDescription>
              An offer is your service plus the proof behind it. Scout generates 3–7 ranked ICPs per offer, then
              sources people that match. Nothing is sent without your approval.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Click <span className="font-medium text-foreground">New offer</span> to add your first one.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {offers.length} offer{offers.length === 1 ? "" : "s"} · {active} active · {icpCount} ICP
            {icpCount === 1 ? "" : "s"} ({approvedCount} approved)
          </p>
          <OffersTable items={offers} />
        </div>
      )}
    </div>
  );
}
