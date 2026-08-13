# Minimal Plugin Example

The smallest useful Universal Harness plugin: a tool provider offering one
`tool.echo` capability, executed as a minimized subprocess.

- `plugin.json` is the Plugin Capability Manifest. The host validates it
  against the authoritative plugin schema before execution; an incompatible
  `protocol_version` or an undeclared capability fails before the plugin runs.
- `plugin.mjs` is the plugin executable. The host invokes it with a fixed
  executable plus an argument array (never a shell), a scrubbed environment,
  a confined working directory, a timeout and an output cap. It reads one
  JSON request (`{"text": "..."}`) from the file path passed as the first
  argument and writes one JSON result line to stdout.

Run it the way the conformance kit does:

```sh
echo '{"text": "hello"}' > /tmp/request.json
node plugin.mjs /tmp/request.json
# {"status":"ok","capability":"tool.echo","echo":"hello"}
```

The contract this example satisfies lives in `packages/plugin-sdk`
(manifest validation, subprocess supervision) and is verified by
`packages/conformance`.
