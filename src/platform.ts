import { randomUUID } from "node:crypto";
export type Code =
  | "UNAUTHORIZED"
  | "POLICY_BLOCKED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_REQUEST"
  | "UNAVAILABLE"
  | "UNSUPPORTED"
  | "INTERNAL";
export class HubError extends Error {
  constructor(
    readonly code: Code,
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export const ok = <T>(data: T, requestId: string = randomUUID()) => ({
  ok: true,
  data,
  meta: { requestId, timestamp: new Date().toISOString() },
});
export const fail = (
  code: Code,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
) => ({
  ok: false,
  error: {
    code,
    message,
    retryable: false,
    failedCenter: "context-hub",
    details,
  },
  meta: { requestId, timestamp: new Date().toISOString() },
});
