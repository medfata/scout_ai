"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side Better Auth client. Only client components import this file.
 *
 * No `baseURL`: the client talks to its own origin, so the same build works on
 * localhost, previews and production (section 8: "Preview deployments run with
 * `DRY_RUN=true`"). Auth state lives in cookies, which is what `src/lib/session.ts`
 * reads on the server.
 */
export const authClient = createAuthClient();
