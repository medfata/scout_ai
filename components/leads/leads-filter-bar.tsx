"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { LeadFilterOptions } from "@/app/(app)/leads/queries";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Server-side filters for the leads table: stage, ICP and free-text search all become
 * query-string state, so the page reloads the exact rows and the table stays client-side
 * and dumb.
 */

const ALL = "all";

export function LeadsFilterBar({
  options,
  current,
}: {
  options: LeadFilterOptions;
  current: { stage?: string; icp?: string; q?: string };
}) {
  const router = useRouter();
  const [query, setQuery] = useState(current.q ?? "");

  function apply(next: { stage?: string; icp?: string; q?: string }) {
    const merged = { ...current, ...next };
    const query: Record<string, string> = {};
    if (merged.stage && merged.stage !== ALL) query.stage = merged.stage;
    if (merged.icp && merged.icp !== ALL) query.icp = merged.icp;
    if (merged.q && merged.q.trim().length > 0) query.q = merged.q.trim();

    const queryString = new URLSearchParams(query).toString();
    router.push(queryString.length > 0 ? `/leads?${queryString}` : "/leads");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={current.stage ?? ALL} onValueChange={(value) => apply({ stage: value })}>
        <SelectTrigger className="w-44" aria-label="Filter by stage">
          <SelectValue placeholder="Stage" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All stages</SelectItem>
          {options.stages.map((stage) => (
            <SelectItem key={stage} value={stage}>
              {stage}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={current.icp ?? ALL} onValueChange={(value) => apply({ icp: value })}>
        <SelectTrigger className="w-56" aria-label="Filter by ICP">
          <SelectValue placeholder="ICP" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All ICPs</SelectItem>
          {options.icps.map((icp) => (
            <SelectItem key={icp.id} value={icp.id}>
              {icp.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          apply({ q: query });
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, title or company"
          className="w-64"
          aria-label="Search leads"
        />
      </form>
    </div>
  );
}
