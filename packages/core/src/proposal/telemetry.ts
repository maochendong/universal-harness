/**
 * Capture UX telemetry (intent-to-prd design 16.3, 20.8): observational
 * counters only — form round-trips, prefill hit counts, missing field counts.
 * Telemetry never enters the proposal draft, the canonical content or any
 * semantic digest; the strict draft schema rejects such fields outright.
 */
export const CAPTURE_UX_TELEMETRY_KINDS = [
  "manual_form_presented",
  "manual_form_completed",
  "legacy_interpreter_invoked",
] as const;
export type CaptureUxTelemetryKind = (typeof CAPTURE_UX_TELEMETRY_KINDS)[number];

export interface CaptureUxTelemetryEvent {
  readonly kind: CaptureUxTelemetryKind;
  readonly session_id: string;
  readonly round: number;
  readonly metrics: Readonly<Record<string, number>>;
}

export type CaptureUxTelemetrySink = (event: CaptureUxTelemetryEvent) => void;

export const noopCaptureUxTelemetry: CaptureUxTelemetrySink = () => undefined;
