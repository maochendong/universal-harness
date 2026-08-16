import type { ServerResponse } from "node:http";

export interface ProblemDetails {
  readonly type: "about:blank";
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
}

export class DashboardProblem extends Error {
  readonly code: string;
  readonly status: number;
  readonly title: string;

  constructor(status: number, code: string, title: string, detail: string) {
    super(detail);
    this.name = "DashboardProblem";
    this.status = status;
    this.code = code;
    this.title = title;
  }

  toJSON(): ProblemDetails {
    return {
      type: "about:blank",
      title: this.title,
      status: this.status,
      detail: this.message,
      code: this.code,
    };
  }
}

export const DASHBOARD_SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(DASHBOARD_SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

export function sendProblem(response: ServerResponse, problem: DashboardProblem): void {
  applySecurityHeaders(response);
  response.statusCode = problem.status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/problem+json; charset=utf-8");
  response.end(`${JSON.stringify(problem.toJSON())}\n`);
}

export function asDashboardProblem(error: unknown): DashboardProblem {
  if (error instanceof DashboardProblem) return error;
  return new DashboardProblem(
    500,
    "internal_error",
    "Internal Server Error",
    "the Dashboard request could not be completed",
  );
}
