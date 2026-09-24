import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/src/lib/auth";

/**
 * Section 8: Better Auth's own routes (`/api/auth/*`). `proxy.ts` treats this
 * prefix as public; Better Auth verifies state and cookies itself. Google
 * redirects back here, and the internal dev credentials provider posts here too.
 */
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(auth);
