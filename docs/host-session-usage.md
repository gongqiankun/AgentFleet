# Shared session usage

AgentFleet 0.30.11 reports token usage when a session is continued in
Codex Desktop or CLI on the host. The usage stays with the same session and is
not counted twice when switching between the host and the panel.

The panel updates after Codex saves its usage information and synchronization
completes. Hosts must be connected and session synchronization enabled. Panel control is
not required; usage remains attached to the same session.

Usage covers observed activity. Earlier consumption without a recorded baseline
may be incomplete; an unavailable count does not mean zero consumption.

Weekly cycle usage covers the seven days ending at Codex's reported next weekly
reset. It is separate from the cumulative recorded total and message retention.
If a valid reset time is unavailable, the cycle total is not calculated.
Historical usage that cannot be assigned precisely across a reset boundary is
identified as incomplete rather than estimated.

Projects and sessions show cumulative and current weekly-cycle token usage side
by side. Usage details include separate total and weekly rankings. The host
summary also shows remaining five-hour quota when Codex reports that limit.

Quota snapshots are shared across hosts with a known matching account. While the
panel is visible, stale snapshots can be refreshed on demand; repeated views are
coalesced and failed queries back off. Token recording continues independently
of whether the panel is open.
