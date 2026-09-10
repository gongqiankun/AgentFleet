# Shared session usage

AgentFleet 0.30.10 reports token usage when a shared session is continued in
Codex Desktop or CLI on the host. The usage stays with the same session and is
not counted twice when switching between the host and the panel.

The panel updates after Codex saves its usage information and synchronization
completes. Hosts must be connected and session synchronization enabled.

Usage covers observed activity. Earlier consumption without a recorded baseline
may be incomplete; an unavailable count does not mean zero consumption.
