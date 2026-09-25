"use client";

import { useActionState, useState, useTransition } from "react";

import {
  updateAutonomyAction,
  updateCapsAction,
  updateIdentityAction,
  updateKillSwitchAction,
  updateOwnerSettingsAction,
  updateSendingWindowsAction,
} from "@/app/(app)/settings/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_CAPS } from "@/src/domain/settings-defaults";
import {
  AUTONOMY_LEVELS,
  type AutonomyLevel,
  type Caps,
  type ChannelKind,
  type SendingWindow,
  type SendingWindows,
} from "@/src/domain/types";
import { cn } from "@/lib/utils";
import { IDLE_SETTINGS_STATE, type SettingsActionState } from "./action-state";

/**
 * Section 9: "Safety rules live in code and config, never in prompts." This form is the
 * owner's side of that config: the kill switch, the autonomy level, caps, sending windows,
 * signature, postal address, timezone and the daily new-prospect target.
 *
 * Each card saves on its own, so a failed signature save cannot roll back a cap change.
 * Every submit posts to a server action that re-checks the owner session (section 8) and
 * revalidates `/settings`.
 */

export interface SettingsFormValues {
  timezone: string;
  sendingWindows: SendingWindows;
  caps: Caps;
  autonomyLevel: AutonomyLevel;
  signature: string;
  postalAddress: string;
  killSwitch: boolean;
  dailyNewProspectTarget: number;
}

export interface SettingsFormProps {
  values: SettingsFormValues;
  /** Section 0's hard ceiling; the page reads it from `MAX_DAILY_NEW_PROSPECTS`. */
  maxDailyNewProspects: number;
}

export function SettingsForm({ values, maxDailyNewProspects }: SettingsFormProps) {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <KillSwitchCard initialOn={values.killSwitch} />
      <AutonomyCard initialLevel={values.autonomyLevel} />
      <SendingWindowsCard windows={values.sendingWindows} />
      <CapsCard caps={values.caps} />
      <IdentityCard signature={values.signature} postalAddress={values.postalAddress} />
      <OwnerSettingsCard
        timezone={values.timezone}
        dailyNewProspectTarget={values.dailyNewProspectTarget}
        maxDailyNewProspects={maxDailyNewProspects}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kill switch — section 7, guard rule 1
// ---------------------------------------------------------------------------

function KillSwitchCard({ initialOn }: { initialOn: boolean }) {
  const [on, setOn] = useState(initialOn);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = (next: boolean) => {
    const previous = on;
    setOn(next);
    setError(null);
    startTransition(async () => {
      const result = await updateKillSwitchAction({ on: next });
      if (!result.ok) {
        setOn(previous);
        setError(result.error ?? "The kill switch could not be changed.");
      }
    });
  };

  return (
    <Card className={cn(on && "border-destructive/60")}>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Kill switch</CardTitle>
            <CardDescription>
              The send guard&apos;s first check. While it is on, <code className="text-xs">sendMessage</code> aborts
              before anything else.
            </CardDescription>
          </div>
          <Switch
            checked={on}
            disabled={pending}
            onCheckedChange={toggle}
            aria-label="Kill switch: block every send"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {on ? (
          <Alert variant="destructive">
            <AlertTitle>Sends are stopped</AlertTitle>
            <AlertDescription>
              No emails or follow-ups leave Scout until you turn this off. Nothing else on this page changes.
            </AlertDescription>
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">
            Off. Sends are still subject to the autonomy level, the caps, the window and every other guard rule.
          </p>
        )}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Autonomy — section 9's table
// ---------------------------------------------------------------------------

const AUTONOMY_TITLES: Record<AutonomyLevel, string> = {
  L0: "Draft only",
  L1: "Approve first touch",
  L2: "Auto-send tier A",
};

const AUTONOMY_DETAILS: Record<AutonomyLevel, string> = {
  L0: "Nothing sends without your approval. Use this for the first two weeks.",
  L1: "Follow-ups that pass the critic send automatically; first emails and LinkedIn messages still wait in the inbox.",
  L2: "Tier A leads with a passing critic send within caps; tier B and C still wait for approval.",
};

function AutonomyCard({ initialLevel }: { initialLevel: AutonomyLevel }) {
  const [level, setLevel] = useState<AutonomyLevel>(initialLevel);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const change = (next: string) => {
    const candidate = AUTONOMY_LEVELS.find((option) => option === next);
    if (!candidate || candidate === level) return;
    const previous = level;
    setLevel(candidate);
    setError(null);
    startTransition(async () => {
      const result = await updateAutonomyAction({ level: candidate });
      if (!result.ok) {
        setLevel(previous);
        setError(result.error ?? "The autonomy level could not be changed.");
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Autonomy level</CardTitle>
        <CardDescription>Section 9: what Scout may send without waiting for you to approve it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={level} onValueChange={change} disabled={pending}>
            <SelectTrigger className="w-28" aria-label="Autonomy level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTONOMY_LEVELS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">{pending ? "Saving…" : AUTONOMY_TITLES[level]}</span>
        </div>

        <ul className="space-y-2">
          {AUTONOMY_LEVELS.map((option) => (
            <li
              key={option}
              className={cn(
                "rounded-md border p-2.5 text-sm",
                option === level ? "border-primary/40 bg-accent/40" : "border-transparent bg-muted/40",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-medium">{option}</span>
                <span className="font-medium">{AUTONOMY_TITLES[option]}</span>
                {option === level ? (
                  <Badge variant="outline" className="ml-auto">
                    current
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-muted-foreground">{AUTONOMY_DETAILS[option]}</p>
            </li>
          ))}
        </ul>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sending windows — section 7
// ---------------------------------------------------------------------------

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
] as const;

function SendingWindowsCard({ windows }: { windows: SendingWindows }) {
  const [state, formAction, pending] = useActionState(updateSendingWindowsAction, IDLE_SETTINGS_STATE);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sending windows</CardTitle>
        <CardDescription>
          Section 7: email goes out inside the recipient&apos;s window, LinkedIn inside yours. Sends outside the window
          are blocked and retried at the next opening.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-5">
          <WindowFields channel="email" label="Email" window={windows.email} />
          <WindowFields channel="linkedin" label="LinkedIn" window={windows.linkedin} />
          <FormStatus state={state} />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save windows"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function WindowFields({
  channel,
  label,
  window,
}: {
  channel: ChannelKind;
  label: string;
  window: SendingWindow;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-4">
        {WEEKDAYS.map((day) => (
          <Label key={day.value} className="text-sm font-normal">
            <Checkbox name={`${channel}Days`} value={day.value} defaultChecked={window.days.includes(day.value)} />
            {day.label}
          </Label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor={`${channel}Start`} className="text-sm font-normal">
          From
        </Label>
        <Input
          id={`${channel}Start`}
          name={`${channel}Start`}
          type="time"
          defaultValue={window.start}
          className="w-32"
          required
        />
        <Label htmlFor={`${channel}End`} className="text-sm font-normal">
          To
        </Label>
        <Input
          id={`${channel}End`}
          name={`${channel}End`}
          type="time"
          defaultValue={window.end}
          className="w-32"
          required
        />
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Caps — section 7's pacing table
// ---------------------------------------------------------------------------

const CAP_FIELDS: Array<{ key: keyof Caps; label: string; help: string }> = [
  {
    key: "emailNew",
    label: "New email conversations / day / mailbox",
    help: `First-touch emails. Section 7 default after warmup: ${DEFAULT_CAPS.emailNew}.`,
  },
  {
    key: "emailTotal",
    label: "Total emails / day / mailbox",
    help: `First touches plus follow-ups. Section 7 default: ${DEFAULT_CAPS.emailTotal}.`,
  },
  {
    key: "linkedinInvites",
    label: "LinkedIn invites / day",
    help: `Assisted tasks in v1; applies to automated mode in phase 6. Section 7 default: ${DEFAULT_CAPS.linkedinInvites}.`,
  },
  {
    key: "linkedinMessages",
    label: "LinkedIn messages / day",
    help: `Automated mode only (phase 6). Section 7 default: ${DEFAULT_CAPS.linkedinMessages}.`,
  },
  {
    key: "linkedinProfileLookups",
    label: "LinkedIn profile lookups / day",
    help: `Automated mode only (phase 6). Section 7 default: ${DEFAULT_CAPS.linkedinProfileLookups}.`,
  },
];

function CapsCard({ caps }: { caps: Caps }) {
  const [state, formAction, pending] = useActionState(updateCapsAction, IDLE_SETTINGS_STATE);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Caps</CardTitle>
        <CardDescription>
          Daily limits per mailbox and per LinkedIn action. The send guard checks them atomically; warmup keeps the
          real email cap lower until the ramp finishes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {CAP_FIELDS.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`cap-${field.key}`}>{field.label}</Label>
                <Input
                  id={`cap-${field.key}`}
                  name={field.key}
                  type="number"
                  min={field.key === "emailNew" || field.key === "emailTotal" ? 1 : 0}
                  max={DEFAULT_CAPS[field.key]}
                  placeholder={String(DEFAULT_CAPS[field.key])}
                  defaultValue={caps[field.key]}
                  required
                />
                <p className="text-xs text-muted-foreground">{field.help}</p>
              </div>
            ))}
          </div>
          <FormStatus state={state} />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save caps"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Signature and postal address — section 9
// ---------------------------------------------------------------------------

function IdentityCard({
  signature: initialSignature,
  postalAddress: initialPostalAddress,
}: {
  signature: string;
  postalAddress: string;
}) {
  const [state, formAction, pending] = useActionState(updateIdentityAction, IDLE_SETTINGS_STATE);
  const [signature, setSignature] = useState(initialSignature);
  const [postalAddress, setPostalAddress] = useState(initialPostalAddress);
  const incomplete = signature.trim().length === 0 || postalAddress.trim().length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Signature and postal address</CardTitle>
        <CardDescription>
          Section 9: every email says who you are and offers a working opt-out. The postal address is required by
          CAN-SPAM for commercial email.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {incomplete ? (
            <Alert variant="destructive">
              <AlertTitle>Sends are blocked until both are filled</AlertTitle>
              <AlertDescription>
                The send guard refuses an email whose signature or postal address is empty, so an approval alone cannot
                get a message out.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="settings-signature">Signature</Label>
            <Textarea
              id="settings-signature"
              name="signature"
              rows={4}
              maxLength={2000}
              value={signature}
              onChange={(event) => setSignature(event.target.value)}
              placeholder={"Your name\nWhat you do\nYou can reply “stop” and I will never write again."}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-postal-address">Postal address</Label>
            <Textarea
              id="settings-postal-address"
              name="postalAddress"
              rows={3}
              maxLength={500}
              value={postalAddress}
              onChange={(event) => setPostalAddress(event.target.value)}
              placeholder="Street, city, country"
            />
          </div>

          <FormStatus state={state} />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save signature"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Timezone and daily new-prospect target — section 0
// ---------------------------------------------------------------------------

function OwnerSettingsCard({
  timezone,
  dailyNewProspectTarget,
  maxDailyNewProspects,
}: {
  timezone: string;
  dailyNewProspectTarget: number;
  maxDailyNewProspects: number;
}) {
  const [state, formAction, pending] = useActionState(updateOwnerSettingsAction, IDLE_SETTINGS_STATE);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Time and volume</CardTitle>
        <CardDescription>
          Your IANA timezone drives quota resets and LinkedIn windows. Section 0&apos;s ceiling bounds the daily
          new-prospect target.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="settings-timezone">Timezone (IANA)</Label>
            <Input id="settings-timezone" name="timezone" defaultValue={timezone} placeholder="Europe/Berlin" required />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-daily-target">New prospects per day</Label>
            <Input
              id="settings-daily-target"
              name="dailyNewProspectTarget"
              type="number"
              min={0}
              max={maxDailyNewProspects}
              defaultValue={dailyNewProspectTarget}
              required
            />
            <p className="text-xs text-muted-foreground">
              Ceiling {maxDailyNewProspects} from <code>MAX_DAILY_NEW_PROSPECTS</code>. Quality mode starts at 5; 0
              pauses sourcing without touching anything else.
            </p>
          </div>

          <FormStatus state={state} />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save time and volume"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared form feedback
// ---------------------------------------------------------------------------

function FormStatus({ state }: { state: SettingsActionState }) {
  if (state.status === "idle") return null;
  return (
    <Alert variant={state.status === "error" ? "destructive" : "default"}>
      <AlertDescription>{state.message}</AlertDescription>
    </Alert>
  );
}
