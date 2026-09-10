# Codex 0.154.0 support

AgentFleet 0.30.10 supports managed Codex 0.154.0 on Linux, macOS and Windows.
New installations use 0.154.0 directly. Updates reuse an existing compatible
managed installation; the user's separate Codex installation remains unchanged.

Managed updates run when the host is idle and retain a rollback option if the
new runtime fails its startup checks. Versions that have not passed compatibility
checks remain unavailable for automatic promotion.

This release also improves Windows background startup and shared Desktop
configuration compatibility. Installing from a drive root is supported.
