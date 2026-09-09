# Updating an existing deployment

Back up configuration and persistent volumes before updating. Build and verify an image before replacing the running service. Keep the previous image for rollback.

For changes confined to the web application, use `packaging/Dockerfile.web` with an explicit, previously verified base image:

```sh
docker build -f packaging/Dockerfile.web \
  --build-arg BASE_IMAGE=agentfleet:previous \
  --build-arg AGENTFLEET_BUILD_SHA=<commit-sha> \
  -t agentfleet:local .
docker compose up -d --no-deps --no-build control-plane
```

This replaces browser assets, including removal of obsolete bundles, while preserving backend code, installers, and published Agent downloads. Verify `/ready`, browser asset delivery, and unchanged download manifests and artifact checksums.

For backend and web changes without Agent changes, use `packaging/Dockerfile.control-plane` with a verified base image. Use the standard Dockerfile for Agent or packaging changes. Never rebuild different Agent bytes under an already published version; assign a new version instead.

A control-plane restart may interrupt connections and leave unresolved actions frozen. Verify host reconnection and existing session state without replaying commands. Only unfreeze uncertain writes after checking their actual outcome.
