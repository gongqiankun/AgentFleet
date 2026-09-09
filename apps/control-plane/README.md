# Control plane

Node.js 24, Fastify, and SQLite service for browser authentication, host enrollment, session catalogs, command coordination, and synchronized history. Passwords use scrypt and host proof of possession uses Ed25519.

Use the root [self-hosting instructions](../../README.md) for deployment and configuration. The administrator is bootstrapped from your environment on first start. Later restarts do not silently reset the stored password. Do not publish environment files or database volumes.

The internal listener defaults to `127.0.0.1:3000`; Compose configures the container listener and publishes it on loopback. Readiness is available at `/ready` and `/healthz`. Configure HTTPS origins and exact trusted proxy peers before exposing a deployment.

For development, run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` in this directory. The service coordinates session ownership, queue reservations, idempotency, retention, and unknown-outcome recovery; changes require isolated integration tests and must not replay actions on real hosts.
