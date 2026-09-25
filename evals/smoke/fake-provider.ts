/**
 * No-key smoke fixture for the eval harness itself. It exists so `pnpm eval:smoke` can prove
 * that promptfoo loads TypeScript providers, TypeScript `file://` assertions, test `vars`, and
 * provider `metadata` — none of which needs an AI Gateway key.
 *
 * The payload below is deliberately tiny and contains no message body.
 */
import type { ApiProvider, CallApiContextParams, ProviderResponse } from "promptfoo";

import { readVar } from "../lib/grading";

export default class SmokeProvider implements ApiProvider {
  id(): string {
    return "scout-eval:smoke";
  }

  async callApi(_prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const smokeId = readVar(context, "smokeId") ?? "missing";
    return {
      output: JSON.stringify({ smoke: smokeId }),
      metadata: { scout: { payload: "from-metadata", smokeId } },
    };
  }
}
