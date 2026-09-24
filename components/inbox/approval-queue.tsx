"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { approveDraftMessage, neverContactLead, skipDraftMessage } from "@/app/(app)/inbox/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { evaluateCopyRules } from "@/src/domain/copy-rules";
import type { SequenceStep } from "@/src/domain/sequence";
import { cn } from "@/src/lib/utils";
import type { InboxRow, InboxViolation } from "./types";

/**
 * Section 5: "Approval inbox | Review, edit, approve, skip, never-contact".
 * Section 4: "Dense tables and keyboard shortcuts for the approval inbox."
 *
 * Shortcuts, one listener, ignored while typing in a field:
 *   J / K  next / previous draft
 *   A      approve (saves the current subject and body first)
 *   S      skip
 *   E      focus the body editor
 *   X      never contact (email + domain + LinkedIn suppression, enrollment stopped)
 *   Esc    cancel editing / leave the field
 */

interface ApprovalQueueProps {
  rows: InboxRow[];
}

export function ApprovalQueue({ rows: initialRows }: ApprovalQueueProps) {
  const [rows, setRows] = useState<InboxRow[]>(initialRows);
  const [index, setIndex] = useState(0);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [editorFor, setEditorFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const current = rows[index] ?? null;

  // Loading a draft (or moving between drafts) resets the editor to the stored message.
  // Adjusting state during render is React's documented pattern for state derived from
  // props; doing it in an effect would paint one frame of the previous draft's text.
  if ((current?.messageId ?? null) !== editorFor) {
    setEditorFor(current?.messageId ?? null);
    setSubject(current?.subject ?? "");
    setBody(current?.body ?? "");
    setEditing(false);
  }

  const move = useCallback(
    (delta: number) => {
      setIndex((previous) => {
        const next = Math.min(Math.max(previous + delta, 0), Math.max(rows.length - 1, 0));
        return next;
      });
    },
    [rows.length],
  );

  const dropCurrent = useCallback((messageId: string) => {
    setRows((previous) => {
      const next = previous.filter((row) => row.messageId !== messageId);
      setIndex((currentIndex) => Math.min(currentIndex, Math.max(next.length - 1, 0)));
      return next;
    });
  }, []);

  const approve = useCallback(async () => {
    if (!current || busy) return;
    setBusy(true);
    const result = await approveDraftMessage({
      messageId: current.messageId,
      enrollmentId: current.enrollmentId,
      enrollmentStatus: current.enrollmentStatus,
      subject,
      body,
    });
    setBusy(false);
    if (result.ok) {
      dropCurrent(current.messageId);
      setStatus({ kind: "ok", text: `Approved for ${current.contactName}. Nothing is sent from this page.` });
    } else {
      setStatus({ kind: "error", text: result.error ?? "Approval failed." });
    }
  }, [busy, body, current, dropCurrent, subject]);

  const skip = useCallback(async () => {
    if (!current || busy) return;
    setBusy(true);
    const result = await skipDraftMessage({
      messageId: current.messageId,
      enrollmentId: current.enrollmentId,
      enrollmentStatus: current.enrollmentStatus,
    });
    setBusy(false);
    if (result.ok) {
      dropCurrent(current.messageId);
      setStatus({ kind: "ok", text: `Skipped ${current.contactName}.` });
    } else {
      setStatus({ kind: "error", text: result.error ?? "Skip failed." });
    }
  }, [busy, current, dropCurrent]);

  const neverContact = useCallback(async () => {
    if (!current || busy) return;
    setBusy(true);
    const result = await neverContactLead({
      messageId: current.messageId,
      enrollmentId: current.enrollmentId,
      enrollmentStatus: current.enrollmentStatus,
      email: current.contactEmail,
      companyDomain: current.companyDomain,
      linkedinUrl: current.linkedinUrl,
    });
    setBusy(false);
    if (result.ok) {
      dropCurrent(current.messageId);
      setStatus({ kind: "ok", text: `${current.contactName} is now on the do-not-contact list.` });
    } else {
      setStatus({ kind: "error", text: result.error ?? "Never-contact failed." });
    }
  }, [busy, current, dropCurrent]);

  const focusEditor = useCallback(() => {
    setEditing(true);
    window.requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(bodyRef.current.value.length, bodyRef.current.value.length);
    });
  }, []);

  const cancelEditing = useCallback(() => {
    if (!current) return;
    setSubject(current.subject ?? "");
    setBody(current.body);
    setEditing(false);
    (document.activeElement as HTMLElement | null)?.blur();
  }, [current]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      const element = target as HTMLElement | null;
      if (!element || !element.tagName) return false;
      return (
        element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA" ||
        element.tagName === "SELECT" ||
        element.isContentEditable
      );
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

      if (isTypingTarget(event.target)) {
        if (event.key === "Escape") {
          event.preventDefault();
          cancelEditing();
        }
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "j") {
        event.preventDefault();
        move(1);
      } else if (key === "k") {
        event.preventDefault();
        move(-1);
      } else if (key === "a") {
        event.preventDefault();
        void approve();
      } else if (key === "s") {
        event.preventDefault();
        void skip();
      } else if (key === "e") {
        event.preventDefault();
        focusEditor();
      } else if (key === "x") {
        event.preventDefault();
        void neverContact();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEditing();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [approve, cancelEditing, focusEditor, move, neverContact, skip]);

  const liveViolations = useMemo(() => {
    if (!current) return [] as InboxViolation[];
    const step: SequenceStep = {
      key: current.stepKey ?? `step_${current.step}`,
      channel: current.channel,
      kind: current.isFirstTouch ? "first_touch" : "follow_up",
      dayOffset: 0,
      thread: "none",
    };
    const firstLine = current.signature.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
    return evaluateCopyRules({
      step,
      channel: current.channel,
      body,
      subject: subject.trim().length > 0 ? subject : null,
      claims: current.claims,
      signalCount: current.signals.length,
      angleKeys: current.angleKeys,
      angle: current.angle ?? "",
      proofCount: current.proofCount,
      hasSignature: firstLine.length > 0 && body.includes(firstLine),
    }).map((violation) => ({ code: violation.code, message: violation.message, severity: violation.severity }));
  }, [body, current, subject]);

  const pendingCount = rows.length;

  if (pendingCount === 0 || !current) {
    return (
      <div className="flex flex-col gap-4">
        {status ? <StatusLine status={status} /> : null}
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nothing waits for approval. Scout never sends without the autonomy level you set in Settings.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {index + 1} / {pendingCount}
          </span>
          waiting for approval
          <Badge variant={current.needsOwner ? "destructive" : "secondary"}>
            {current.needsOwner ? "needs owner" : "critic passed"}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => move(-1)} disabled={index === 0}>
            K · Previous
          </Button>
          <Button variant="outline" size="sm" onClick={() => move(1)} disabled={index >= pendingCount - 1}>
            J · Next
          </Button>
        </div>
      </div>

      {status ? <StatusLine status={status} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{current.contactName}</CardTitle>
            <div className="text-sm text-muted-foreground">
              {[current.contactTitle, current.companyName].filter(Boolean).join(" · ") || "No company on file"}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap gap-1.5">
              {current.tier ? <Badge variant="outline">Tier {current.tier}</Badge> : <Badge variant="outline">No tier</Badge>}
              {typeof current.score === "number" ? <Badge variant="outline">Score {current.score}</Badge> : null}
              {current.icpName ? <Badge variant="secondary">{current.icpName}</Badge> : null}
              <Badge variant="outline">
                {current.channel} · {current.stepKey ?? `step ${current.step}`}
              </Badge>
              {current.angle ? <Badge variant="secondary">angle: {current.angle}</Badge> : null}
            </div>
            <Separator />
            <section>
              <h3 className="mb-1 font-medium">Brief</h3>
              <p className="text-muted-foreground">{current.briefSummary ?? "No research brief yet."}</p>
              {current.likelyPains.length > 0 ? (
                <p className="mt-2 text-muted-foreground">
                  <span className="font-medium text-foreground">Likely pains: </span>
                  {current.likelyPains.join("; ")}
                </p>
              ) : null}
              {current.aiOpportunity ? (
                <p className="mt-2 text-muted-foreground">
                  <span className="font-medium text-foreground">AI opportunity: </span>
                  {current.aiOpportunity}
                </p>
              ) : null}
              {current.confidence ? (
                <p className="mt-2 text-xs text-muted-foreground">Evidence confidence: {current.confidence}</p>
              ) : null}
            </section>
            <Separator />
            <section>
              <h3 className="mb-1 font-medium">Signals ({current.signals.length})</h3>
              {current.signals.length === 0 ? (
                <p className="text-muted-foreground">No cited signal. The draft must not make company-specific claims.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {current.signals.map((signal, signalIndex) => (
                    <li key={`${signal.url}-${signalIndex}`} className="text-muted-foreground">
                      <a
                        className="underline underline-offset-2 hover:text-foreground"
                        href={signal.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {signal.fact}
                      </a>
                      {signal.date ? <span className="ml-1 text-xs">({signal.date})</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {current.scoreReasons.length > 0 ? (
              <>
                <Separator />
                <section>
                  <h3 className="mb-1 font-medium">Why this score</h3>
                  <ul className="list-disc pl-4 text-muted-foreground">
                    {current.scoreReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </section>
              </>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Draft</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {current.channel === "email" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="draft-subject">Subject</Label>
                <Input
                  id="draft-subject"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  onFocus={() => setEditing(true)}
                  placeholder="Subject"
                />
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="draft-body">Body</Label>
                <span className="text-xs text-muted-foreground">
                  {current.wordLimit ? `max ${current.wordLimit} words` : null}
                  {current.charLimit ? `max ${current.charLimit} chars` : null}
                </span>
              </div>
              <Textarea
                id="draft-body"
                ref={bodyRef}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onFocus={() => setEditing(true)}
                className="min-h-72 font-mono text-[13px] leading-relaxed"
                spellCheck
              />
              <p className="text-xs text-muted-foreground">
                {editing ? "Editing — press Esc to cancel changes." : "Press E to edit; subject and body save when you approve."}
              </p>
            </div>

            <ViolationList
              title="Code checks (live)"
              violations={liveViolations}
              emptyText="Every mechanical rule passes for this body."
            />
            <ViolationList
              title="Review recorded at draft time"
              violations={current.violations}
              emptyText={
                current.verdict
                  ? `Critic passed: ${current.verdict.criticPassed ? "yes" : "no"}.`
                  : "No review recorded (drafted before phase 3)."
              }
            />
            {current.verdict?.fix ? (
              <Alert>
                <AlertTitle>Critic instruction</AlertTitle>
                <AlertDescription>{current.verdict.fix}</AlertDescription>
              </Alert>
            ) : null}

            <Separator />

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void approve()} disabled={busy}>
                A · Approve
              </Button>
              <Button variant="outline" onClick={() => void skip()} disabled={busy}>
                S · Skip
              </Button>
              <Button variant="outline" onClick={focusEditor} disabled={busy}>
                E · Edit
              </Button>
              <Button variant="destructive" onClick={() => void neverContact()} disabled={busy}>
                X · Never contact
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              J/K next or previous · A approve · S skip · E edit · X never contact · Esc cancel. Approval never sends;
              the send guard and the sequence run separately.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ViolationList({
  title,
  violations,
  emptyText,
}: {
  title: string;
  violations: InboxViolation[];
  emptyText: string;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      {violations.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {violations.map((violation) => (
            <li
              key={`${violation.code}-${violation.message}`}
              className={cn(
                "rounded-md border px-2 py-1 text-xs",
                violation.severity === "error"
                  ? "border-destructive/40 bg-destructive/5 text-destructive"
                  : "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400",
              )}
            >
              <span className="font-mono">{violation.code}</span> — {violation.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusLine({ status }: { status: { kind: "ok" | "error"; text: string } }) {
  return (
    <Alert variant={status.kind === "error" ? "destructive" : "default"}>
      <AlertTitle>{status.kind === "error" ? "Action failed" : "Done"}</AlertTitle>
      <AlertDescription>{status.text}</AlertDescription>
    </Alert>
  );
}
