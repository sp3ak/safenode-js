import type { FetchLike } from "../src/index.js";

export const API_KEY = "sn_testkey_0000000000000000";

export const ALLOW_BODY: Record<string, unknown> = {
  decision: "allow",
  impact_score: 12.5,
  risk_score: 6.25,
  matched_policies: [],
  reasons: [],
  alternatives: [
    { type: "general", description: "Review the policy rules and adjust the request." },
  ],
  trace_id: "9f1c2b7e-3d4a-4c8b-9e10-5a6f7b8c9d0e",
};

export function bodyWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...JSON.parse(JSON.stringify(ALLOW_BODY)), ...overrides };
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export class Recorder {
  readonly requests: RecordedRequest[] = [];

  get count(): number {
    return this.requests.length;
  }

  get last(): RecordedRequest {
    const last = this.requests[this.requests.length - 1];
    if (!last) throw new Error("no requests recorded");
    return last;
  }

  get lastBody(): Record<string, unknown> {
    return JSON.parse(this.last.body) as Record<string, unknown>;
  }
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * Build a mocked `fetch` plus the Recorder observing it. No live API calls, ever.
 *
 * Pass `responses` for a scripted sequence (the last entry repeats), or `handler` for full control.
 */
export function mockFetch(
  options: {
    responses?: Array<() => Response>;
    handler?: (req: RecordedRequest) => Promise<Response> | Response;
  } = {},
): { fetch: FetchLike; recorder: Recorder } {
  const recorder = new Recorder();
  const queue = [...(options.responses ?? [() => jsonResponse(200, ALLOW_BODY)])];

  const fetchImpl: FetchLike = async (url, init) => {
    const recorded: RecordedRequest = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    recorder.requests.push(recorded);
    if (options.handler) return await options.handler(recorded);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error("no scripted response");
    return next();
  };

  return { fetch: fetchImpl, recorder };
}

/** A logger that captures rather than prints, so tests can assert on warnings. */
export class CapturingLogger {
  readonly messages: string[] = [];
  warn(message: string): void {
    this.messages.push(message);
  }
}
