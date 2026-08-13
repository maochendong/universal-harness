import { describe, expect, it } from "vitest";

import { AgentError } from "@universal-harness-internal/plugin-sdk";

import { buildEnvironment, renderArgs, validateCommandManifest } from "../src/manifest.js";
import { fixtureManifest } from "./helpers.js";

describe("validateCommandManifest", () => {
  it("accepts a well-formed manifest", () => {
    const manifest = fixtureManifest("complete.mjs");
    expect(validateCommandManifest(manifest)).toBe(manifest);
  });

  it("rejects a non-delegated control level", () => {
    expect(() =>
      validateCommandManifest({ ...fixtureManifest("complete.mjs"), control: "managed" }),
    ).toThrowError(AgentError);
  });

  it("rejects a missing or doubled input placeholder", () => {
    const base = fixtureManifest("complete.mjs");
    expect(() => validateCommandManifest({ ...base, args: ["run"] })).toThrowError(/placeholder/u);
    expect(() =>
      validateCommandManifest({ ...base, args: ["{input_file}", "{input_file}"] }),
    ).toThrowError(/placeholder/u);
  });

  it("rejects unsupported placeholders in the argument template", () => {
    const base = fixtureManifest("complete.mjs");
    expect(() =>
      validateCommandManifest({ ...base, args: ["{input_file}", "--task={objective}"] }),
    ).toThrowError(/unsupported placeholder/u);
  });

  it("rejects an empty executable and an invalid trajectory visibility", () => {
    const base = fixtureManifest("complete.mjs");
    expect(() => validateCommandManifest({ ...base, executable: "" })).toThrowError(AgentError);
    expect(() =>
      validateCommandManifest({ ...base, trajectory_visibility: "everything" }),
    ).toThrowError(/trajectory_visibility/u);
  });

  it("rejects non-boolean capability claims and bad resume semantics", () => {
    const base = fixtureManifest("complete.mjs");
    expect(() => validateCommandManifest({ ...base, usage_metering: "yes" })).toThrowError(
      /usage_metering/u,
    );
    expect(() => validateCommandManifest({ ...base, resume_semantics: "maybe" })).toThrowError(
      /resume_semantics/u,
    );
  });
});

describe("renderArgs", () => {
  it("substitutes only the input file placeholder", () => {
    const manifest = fixtureManifest("complete.mjs", {
      args: ["--run", "{input_file}", "--yes"],
    });
    expect(renderArgs(manifest, "/tmp/envelope.json")).toEqual([
      "--run",
      "/tmp/envelope.json",
      "--yes",
    ]);
  });
});

describe("buildEnvironment", () => {
  it("passes only allowlisted variables", () => {
    const manifest = fixtureManifest("complete.mjs", { env_allowlist: ["KEEP_ME"] });
    const env = buildEnvironment(manifest, { KEEP_ME: "1", DROP_ME: "2" });
    expect(env).toEqual({ KEEP_ME: "1" });
  });
});
