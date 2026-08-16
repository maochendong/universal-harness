import { describe, expect, it } from "vitest";

import { observeAgentBudget } from "../src/measurement.js";

describe("observeAgentBudget", () => {
  it("keeps opaque delegated token and step usage unavailable while measuring duration", () => {
    expect(
      observeAgentBudget({
        budget: { max_steps: 30, max_tokens: 120_000, max_duration_ms: 2_700_000 },
        usage: {
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          duration_ms: 390_000,
          metering: "unmetered",
        },
        profile: {
          control: "delegated",
          trajectory_visibility: "external-only",
          usage_metering: false,
          side_effect_interception: false,
        },
      }),
    ).toEqual([
      {
        dimension: "steps",
        availability: "unavailable",
        used: null,
        limit: 30,
        enforcement: "none",
      },
      {
        dimension: "tokens",
        availability: "unavailable",
        used: null,
        limit: 120_000,
        enforcement: "none",
      },
      {
        dimension: "duration_ms",
        availability: "measured",
        used: 390_000,
        limit: 2_700_000,
        enforcement: "harness",
      },
    ]);
  });

  it("records only genuinely observed managed dimensions as measured", () => {
    expect(
      observeAgentBudget({
        budget: { max_steps: 10, max_tokens: 4_000, max_duration_ms: 60_000 },
        usage: {
          input_tokens: 800,
          output_tokens: 400,
          total_tokens: 1_200,
          duration_ms: 15_000,
          metering: "provider_reported",
        },
        observedSteps: 3,
        profile: {
          control: "managed",
          trajectory_visibility: "full",
          usage_metering: true,
          side_effect_interception: true,
        },
      }),
    ).toEqual([
      expect.objectContaining({ dimension: "steps", availability: "measured", used: 3 }),
      expect.objectContaining({
        dimension: "tokens",
        availability: "measured",
        used: 1_200,
        enforcement: "provider",
      }),
      expect.objectContaining({
        dimension: "duration_ms",
        availability: "measured",
        used: 15_000,
        enforcement: "harness",
      }),
    ]);
  });
});
