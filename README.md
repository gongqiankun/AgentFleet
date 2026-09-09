# AgentFleets for Codex

[简体中文](README.zh-CN.md)

A self-hosted web workspace for managing native Codex sessions across your own Linux, macOS, and Windows machines. Keep execution on your hosts and use a browser to follow conversations, send messages, and manage session control.

This is an independent project, not an official OpenAI product. Deploy your own instance and use your own Codex credentials. No shared service or default login is provided.

## Features

- Browse hosts, projects, and native sessions in one workspace.
- Take control of a session, continue the same native conversation, then release control back to the host.
- Rename, archive, fork, and delete sessions with host-side confirmation where supported.
- Follow streaming output, queue messages, and configure execution permissions per session.
- Keep uncertain operations frozen until you verify the host and manually unfreeze them.
- Upload images, inspect storage by session, and preview supported image cleanup operations.
- English and Simplified Chinese interface, responsive layouts, and keyboard shortcuts: Enter to send; Ctrl+Enter or ⌘+Enter for a newline.

## Self-host

You need Docker with Compose, an HTTPS reverse proxy, and hosts with a supported Codex installation. Source builds download dependencies and platform runtime artifacts, so internet access is required. Host write access depends on operating-system, credential protection, and App Server protocol checks; a version number alone does not guarantee compatibility.

```sh
git clone https://github.com/gongqiankun/AgentFleet.git
cd AgentFleet
cp .env.example .env
```

Edit `.env` before starting:

- Set `ADMIN_EMAIL` to your own address and `ADMIN_PASSWORD` to a unique password of at least 12 characters. There is no preset password.
- Set `PUBLIC_ORIGIN` and `ALLOWED_ORIGINS` to your own HTTPS origin, without a trailing slash.
- Keep `COOKIE_SECURE=true` for HTTPS and `PUBLISH_HOST=127.0.0.1` when the proxy runs on the same host.
- If using forwarded headers, configure `TRUSTED_PROXIES` with only the verified immediate proxy addresses.

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:3215/ready
```

Forward your HTTPS origin to `127.0.0.1:3215`, including WebSocket upgrade support. Open **your own origin**, sign in with the credentials you configured, and use the panel's host enrollment flow. Run the generated one-time installation command on each intended host; do not share enrollment tickets.

For loopback-only evaluation, set both origins to `http://127.0.0.1:3215` and `COOKIE_SECURE=false`. Do not use that configuration for a public deployment.

Compose persists control-plane data and validated runtime releases in named volumes. Back up your configuration and volumes before upgrades; do not use `docker compose down -v` unless you intend to delete them. See [release guidance](docs/web-only-release.md) for updates that preserve existing Agent downloads.

## Session control and recovery

A native session has one writer. While the panel controls a session, do not open that same session with `codex resume` on the host. Release control in the panel and wait for the host to acknowledge it before resuming locally. To return to the panel, stop the local writer first, then take control again. Renaming changes the title, not the native session ID.

A disconnect or restart can leave an operation's outcome unknown even if a reply is already visible. The panel freezes writes rather than automatically replaying an action. Check the host and native session first, then use the manual unfreeze button. Unfreezing does not prove that the previous operation failed and does not undo it; avoid sending the same action again until you know its outcome.

## Data and images

The control plane stores account and host enrollment data, synchronized conversation content, operation records, and uploaded images. Codex execution and model credentials remain on the host. Protect both the control-plane volumes and host data; this is not a storage-free relay.

The default image quota is 50 MB per host. Supported cleanup can remove panel-uploaded image content on both sides while preserving text and native session identity. Native-history cleanup is currently restricted to the validated Linux/Codex adapter and requires Python 3; unsupported or ambiguous data is rejected. Cleanup does not delete provider-side data or independent backups. Native history files may retain their byte length after image removal. Storage size is not a token-usage estimate. See [image cleanup](docs/panel-image-cleanup.md).

## Development

Use Node.js 24 and npm:

```sh
npm ci --prefix apps/control-plane
npm ci --prefix apps/local-agent
npm ci --prefix apps/web
npm run check
npm test
npm run build
```

| Directory | Purpose |
| --- | --- |
| `apps/control-plane` | Fastify API, authentication, SQLite state, host connections |
| `apps/local-agent` | Host discovery, native session control, execution and recovery |
| `apps/web` | React browser workspace |
| `packaging` | Installers, runtime artifacts and container builds |
| `experiments` | Isolated native-history compatibility tools and tests |

See [contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), and [packaging](packaging/README.md). Changes to session ownership, replay, or native history require focused recovery tests; passing UI tests alone is insufficient.

## License

[MIT](LICENSE). Third-party software retains its own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
