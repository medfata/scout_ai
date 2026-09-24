import { requireOwner } from "@/src/lib/session";
import { CONTACT_STAGES, type ContactStage } from "@/src/domain/types";

import { LeadsFilterBar } from "@/components/leads/leads-filter-bar";
import { LeadsTable } from "@/components/leads/leads-table";
import { loadLeadFilterOptions, loadLeadRows } from "./queries";

/**
 * Section 10: `(app)/leads` — a dense table over every contact, filterable by stage and
 * ICP with a text search. The row links to the lead detail.
 */

export const dynamic = "force-dynamic";

interface LeadsSearchParams {
  stage?: string;
  icp?: string;
  q?: string;
}

export default async function LeadsPage({ searchParams }: { searchParams: Promise<LeadsSearchParams> }) {
  await requireOwner();
  const params = await searchParams;

  const stage = parseStage(params.stage);
  const icpId = params.icp && params.icp.length > 0 ? params.icp : undefined;
  const search = params.q?.trim() ? params.q.trim() : undefined;

  const [rows, options] = await Promise.all([
    loadLeadRows({ stage, icpId, search, limit: 200 }),
    loadLeadFilterOptions(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
        <p className="text-sm text-muted-foreground">
          {rows.length} contact{rows.length === 1 ? "" : "s"} matching the current filters.
        </p>
      </header>

      <LeadsFilterBar options={options} current={{ stage, icp: icpId, q: search }} />
      <LeadsTable rows={rows} />
    </div>
  );
}

function parseStage(value: string | undefined): ContactStage | undefined {
  if (!value) return undefined;
  return CONTACT_STAGES.find((stage) => stage === value);
}
