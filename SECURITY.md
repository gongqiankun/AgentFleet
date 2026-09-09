# Security

Report vulnerabilities through the repository's **Security → Report a vulnerability** page. Do not post credentials, private conversations, exploit details, or deployment addresses in public issues. If private reporting is unavailable, open an issue asking for a private reporting channel without including sensitive details.

Include affected versions, a minimal reproduction using synthetic data, expected impact, and any suggested fix. Security fixes target the current main branch; older releases do not have a separate maintenance commitment.

Operators should use HTTPS, unique administrator credentials, narrow proxy trust, and protected backups. Host execution runs with the Agent's operating-system account permissions. Grant only the access you intend. Keep `.env`, host keys, Codex credentials, and local operational notes outside version control.
