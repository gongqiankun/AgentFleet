# Local Agent

The Node.js 24 / TypeScript host service discovers projects and native Codex sessions, manages writer ownership, and connects to the control plane over an authenticated outbound WebSocket.

Install through your own panel's one-time host enrollment flow. Supported distributions include Linux x86_64, macOS x86_64/arm64, and Windows x86_64. Runtime compatibility, credential protection, and requested execution permissions are checked before enabling writes. Unsupported or uncertain state fails closed.

Run `npm ci`, `npm run check`, `npm test`, and `npm run build` here for development. See the root [README](../../README.md), [packaging guide](../../packaging/README.md), and [image cleanup limitations](../../docs/panel-image-cleanup.md). Tests involving native Codex must use isolated temporary homes and synthetic sessions.
