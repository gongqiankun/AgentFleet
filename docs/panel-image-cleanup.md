# Panel image cleanup

Images uploaded through the composer are stored by the control plane and sent to the host as image content. They can be embedded in native Codex history instead of becoming a standalone PNG in the project directory. Deleting an unrelated source file does not remove these copies.

The host image manager supports filtering and selecting sessions, previewing affected content, and confirming cleanup. The default quota is 50 MB per host. Cloud references are removed only after a matching host acknowledgement. Shared images belonging to unselected sessions or turns remain available.

Native-history cleanup currently supports the validated Linux adapter for Codex 0.153.4 and requires Python 3 with the standard `sqlite3` and `fcntl` modules. It uses native writer and coordination locks, verifies file identity and fingerprints, and rejects active or uncertain sessions, unsupported formats, compacted records containing target images, and unprovable upload provenance. A restarted Agent does not automatically repeat an already-started cleanup.

The adapter preserves native session IDs, text, and line byte offsets. Removed inline image bytes are replaced with padding, so native history files do not shrink. Limits include 50 upload records per session, 64 MiB history files, and a 60-second helper timeout. Preview results and final receipts should be checked before declaring both sides clean.

Cleanup does not delete project files, independent backups, provider-side data, or forensic remnants in SQLite WAL files. macOS and Windows native-history rewriting is not currently supported. This feature is not a general secure-erasure tool.

Displayed file size measures storage. Token statistics, when available, come from native runtime reports and may be stale; file size cannot determine a request's token usage. Deleting another idle session does not refund previously consumed tokens.

Implementation and isolated validation live in `apps/local-agent`, `apps/control-plane`, and `experiments`; tests must never rewrite a real user's active history.
