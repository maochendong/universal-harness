import { Type, type Static } from "@sinclair/typebox";

import { ExtensionsSchema, ProtocolVersionSchema, enumerated, strictObject } from "./common.js";

export const PLUGIN_KINDS = ["stack", "agent", "tool", "gate", "vcs", "projection"] as const;

export const PluginManifestSchema = strictObject({
  protocol_version: ProtocolVersionSchema,
  record_kind: Type.Literal("plugin_manifest"),
  name: Type.String({ minLength: 1, maxLength: 214, pattern: "^[a-z0-9@][a-z0-9@/._-]*$" }),
  version: Type.String({
    pattern:
      "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$",
  }),
  kind: enumerated(PLUGIN_KINDS),
  capabilities: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  resources: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  extensions: Type.Optional(ExtensionsSchema),
});

export type PluginManifest = Static<typeof PluginManifestSchema>;
