import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { LeadActions } from "@/components/leads/lead-actions";
import { requireOwner } from "@/src/lib/session";
import { loadLeadDetail } from "../queries";

/**
 * Section 10: the lead detail page — brief with cited signals, score and reasons, the
 * full thread, enrollment state, and the section 9 Export / Delete data-request buttons.
 */

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;

  const detail = await loadLeadDetail(id);
  if (!detail) notFound();

  const { contact, company, brief, scores, enrollments, messages, activity } = detail;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Button variant="ghost" size="sm" className="w-fit px-0" asChild>
          <Link href="/leads">← Back to leads</Link>
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{contact.fullName}</h1>
            <p className="text-sm text-muted-foreground">
              {[contact.title, company?.name ?? company?.domain].filter(Boolean).join(" · ") || "No company on file"}
            </p>
          </div>
          <LeadActions contactId={contact.id} contactName={contact.fullName} />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{contact.stage}</Badge>
          <Badge variant="outline">email: {contact.emailStatus}</Badge>
          {contact.email ? <span className="text-sm text-muted-foreground">{contact.email}</span> : null}
          {contact.linkedinUrl ? (
            <a className="text-sm underline underline-offset-2" href={contact.linkedinUrl} target="_blank" rel="noreferrer">
              LinkedIn
            </a>
          ) : null}
          <span className="text-xs text-muted-foreground">
            source: {contact.source ?? "unknown"} · collected {formatDateTime(contact.collectedAt)}
          </span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Research brief</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {brief ? (
              <>
                <p>{brief.summary}</p>
                {brief.likelyPains.length > 0 ? (
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">Likely pains: </span>
                    {brief.likelyPains.join("; ")}
                  </p>
                ) : null}
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">AI opportunity: </span>
                  {brief.aiOpportunity}
                </p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">confidence: {brief.confidence}</Badge>
                  {brief.model ? <span>{brief.model}</span> : null}
                  {brief.promptVersion ? <span>{brief.promptVersion}</span> : null}
                  <span>${Number(brief.costUsd).toFixed(4)}</span>
                </div>
                <Separator />
                <section className="flex flex-col gap-1.5">
                  <h3 className="font-medium">Signals ({brief.signals.length})</h3>
                  {brief.signals.length === 0 ? (
                    <p className="text-muted-foreground">No cited signal.</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {brief.signals.map((signal, signalIndex) => (
                        <li key={`${signal.url}-${signalIndex}`} className="text-muted-foreground">
                          <a className="underline underline-offset-2 hover:text-foreground" href={signal.url} target="_blank" rel="noreferrer">
                            {signal.fact}
                          </a>
                          {signal.date ? <span className="ml-1 text-xs">({signal.date})</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            ) : (
              <p className="text-muted-foreground">No brief yet. Research runs before drafting.</p>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Score</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {scores.length === 0 ? (
                <p className="text-muted-foreground">Not scored yet.</p>
              ) : (
                scores.map(({ score, icpName }) => (
                  <div key={score.id} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{score.tier ? `Tier ${score.tier}` : "No tier"}</Badge>
                      <span className="font-medium">{score.score}/100</span>
                      {icpName ? <span className="text-muted-foreground">{icpName}</span> : null}
                    </div>
                    <ul className="list-disc pl-5 text-muted-foreground">
                      {score.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                    {score.disqualifiedReason ? (
                      <p className="text-destructive">Disqualified: {score.disqualifiedReason}</p>
                    ) : null}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Enrollments</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {enrollments.length === 0 ? (
                <p className="text-muted-foreground">No enrollment.</p>
              ) : (
                enrollments.map((enrollment) => (
                  <div key={enrollment.id} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={enrollment.status === "active" ? "default" : "secondary"}>{enrollment.status}</Badge>
                      <span className="text-muted-foreground">
                        {enrollment.sequenceKey} v{enrollment.sequenceVersion} · step {enrollment.currentStep}
                      </span>
                      {enrollment.angle ? <Badge variant="outline">angle: {enrollment.angle}</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      next action: {enrollment.nextActionAt ? formatDateTime(enrollment.nextActionAt) : "—"}
                      {enrollment.startedAt ? ` · started ${formatDateTime(enrollment.startedAt)}` : ""}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Thread ({messages.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages yet.</p>
          ) : (
            messages.map((message) => (
              <div key={message.id} className="flex flex-col gap-1.5 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant={message.direction === "inbound" ? "secondary" : "outline"}>
                    {message.direction} · {message.channel}
                  </Badge>
                  <span className="text-muted-foreground">step {message.step}</span>
                  <span className="text-muted-foreground">{message.status}</span>
                  {message.intent ? <Badge variant="secondary">{message.intent}</Badge> : null}
                  <span className="ml-auto text-muted-foreground">
                    {message.sentAt
                      ? `sent ${formatDateTime(message.sentAt)}`
                      : message.receivedAt
                        ? `received ${formatDateTime(message.receivedAt)}`
                        : `created ${formatDateTime(message.createdAt)}`}
                  </span>
                </div>
                {message.subject ? <p className="text-sm font-medium">{message.subject}</p> : null}
                <pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground">{message.body}</pre>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-sm">
            {activity.map((event) => (
              <li key={event.id} className="flex items-center gap-2 text-muted-foreground">
                <span className="w-40 shrink-0 font-mono text-xs">{formatDateTime(new Date(event.at))}</span>
                <span className="font-medium text-foreground">{event.type}</span>
                <span className="text-xs">({event.actor})</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function formatDateTime(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
