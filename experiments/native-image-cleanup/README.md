# Isolated native-image cleanup experiments

This directory contains the original test-only prototype and native compatibility harness. Its cleanup entry point is restricted to generated test homes with synthetic credentials and model responses. Do not remove those restrictions or run it on a user's history.

The production adapter is maintained separately in `apps/local-agent/src/native-image-helper.py` and embedded by `packaging/embed-image-helper.mjs`. See the current [feature scope and limitations](../../docs/panel-image-cleanup.md); this prototype is not the production command-line interface.

## Run isolated checks

Use Linux, Python 3, Node.js 24, a built Local Agent, and a Codex 0.153.4 executable for the native compatibility tests:

```sh
npm --prefix apps/local-agent run build
python3 -m unittest discover -s experiments/native-image-cleanup -v
AGENTFLEET_NATIVE_CODEX=/absolute/path/to/codex \
  node --test --test-isolation=none --test-concurrency=1 \
  experiments/native-image-cleanup/native-test.mjs
```

Without `AGENTFLEET_NATIVE_CODEX`, native tests are skipped; a skip is not proof of compatibility. The harness uses temporary homes, small synthetic images, and a local mock model server. It must not use production credentials or user projects.

Coverage includes text and session-identity preservation, non-target images, writer exclusion, stale previews, unsupported inputs, interrupted projection updates, and resuming the same session after cleanup. Native tests cover legacy and paginated history layouts. Padding preserves line byte offsets, so these checks do not demonstrate disk-space reclamation or secure erasure of backups and WAL files.
