# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS web-build
WORKDIR /build/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web/ ./
RUN npm run build

FROM node:24-bookworm-slim AS control-plane-build
WORKDIR /build/apps/control-plane
COPY apps/control-plane/package.json apps/control-plane/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/control-plane/ ./
RUN npm run build

FROM node:24-bookworm-slim AS control-plane-deps
WORKDIR /build/apps/control-plane
COPY apps/control-plane/package.json apps/control-plane/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim AS local-agent-release
WORKDIR /build
ADD --checksum=sha256:1e6a0f2802c4199f81e1d3d9a962d64dc274693d8391f02d1f4ab457e57c4c38 \
    https://github.com/openai/codex/releases/download/rust-v0.154.0/bwrap-x86_64-unknown-linux-musl.tar.gz \
    /build/bwrap-validated.tar.gz
ADD --checksum=sha256:a68df7cca23c6da7cde175677df7de61c73a234add1333a1254b86d641af01f7 \
    https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz \
    /build/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz
ADD --checksum=sha256:500ee2a02ea598ae519052e7d7d8e201d1db01986f30c214ef4143645dc86fad \
    https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-code-mode-host-aarch64-apple-darwin.tar.gz \
    /build/codex-code-mode-host-aarch64-apple-darwin.tar.gz
ADD --checksum=sha256:a0fa6141e591f44dc2d86a589cfe797212317bfb9fa3a6c73131e4dbb93387fe \
    https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-code-mode-host-x86_64-apple-darwin.tar.gz \
    /build/codex-code-mode-host-x86_64-apple-darwin.tar.gz
ADD --checksum=sha256:656b475bb80d258e3244dc57a1556eb3ce2180791a649ced5e2c8e199c340891 \
    https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-code-mode-host-x86_64-pc-windows-msvc.exe.tar.gz \
    /build/codex-code-mode-host-x86_64-pc-windows-msvc.exe.tar.gz
ADD --checksum=sha256:89ddae071e8a8126d8d12396db1b308108b9e64216b014e917bdaa02b7bc1007 \
    https://github.com/openai/codex/releases/download/rust-v0.153.2/bwrap-x86_64-unknown-linux-musl.tar.gz \
    /build/bwrap-baseline.tar.gz
ADD --checksum=sha256:e7d65c75e05637e42b93f6abf9222fa0d26b537648a7a34c122b75021d41756d \
    https://github.com/openai/codex/releases/download/rust-v0.153.4/bwrap-x86_64-unknown-linux-musl.tar.gz \
    /build/bwrap-x86_64-unknown-linux-musl.tar.gz
ADD --checksum=sha256:d7e18b2597ae8f242f5f31ee9e90deef48dbc9edd634d9868fb6435d08c07f02 \
    https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-x86_64-unknown-linux-musl.tar.gz \
    /build/codex-x86_64-unknown-linux-musl.tar.gz
ADD --checksum=sha256:344310a0a591c1b192e04feff304321a69907c9498baaac331ca7e16ebcef9d7 \
    https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-aarch64-apple-darwin.tar.gz \
    /build/codex-aarch64-apple-darwin.tar.gz
ADD --checksum=sha256:1219c837d8f813b493a424c125c0038b5d9ca16279bc6d3fe6ce037a3e18a6e7 \
    https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-x86_64-apple-darwin.tar.gz \
    /build/codex-x86_64-apple-darwin.tar.gz
ADD --checksum=sha256:4e96740782869faff9d424806d4419afd2ee51ea5ece6cec462912b7098497a1 \
    https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-x86_64-pc-windows-msvc.exe.tar.gz \
    /build/codex-x86_64-pc-windows-msvc.exe.tar.gz
ADD --checksum=sha256:a1a54f46a750d2523d628d924aab61758a51c9dad3e0238beb14141be9615dd3 \
    https://nodejs.org/dist/v24.14.0/node-v24.14.0-darwin-arm64.tar.gz \
    /build/node-v24.14.0-darwin-arm64.tar.gz
ADD --checksum=sha256:f2879eb810e25993a0578e5d878930266fd2eafcffe9f2839b3d8db354d4879e \
    https://nodejs.org/dist/v24.14.0/node-v24.14.0-darwin-x64.tar.gz \
    /build/node-v24.14.0-darwin-x64.tar.gz
ADD --checksum=sha256:63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088 \
    https://nodejs.org/dist/v24.14.0/win-x64/node.exe \
    /build/node-win-x64.exe
COPY apps/local-agent/package.json apps/local-agent/package-lock.json ./apps/local-agent/
RUN npm ci --prefix apps/local-agent --no-audit --no-fund
COPY apps/local-agent/ ./apps/local-agent/
COPY packaging/ ./packaging/
RUN AGENTFLEET_RELEASE_DIR=/build/release ./packaging/build-portable.sh \
    && AGENTFLEET_RELEASE_DIR=/build/release sh ./packaging/build-cross-platform.sh \
    && node -e 'const fs=require("node:fs");const crypto=require("node:crypto");const m=JSON.parse(fs.readFileSync("/build/release/manifest.json","utf8"));const a=m.artifacts?.["linux-x64"];if(m.schemaVersion!==1||!a)throw new Error("invalid release manifest");const p="/build/release/"+a.file;const digest=crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");if(digest!==a.sha256)throw new Error("release checksum mismatch");if(fs.statSync(p).size!==a.size)throw new Error("release size mismatch");if(!fs.existsSync(p+".sha256"))throw new Error("release checksum file missing")' \
    && artifact="$(node -p 'require("/build/release/manifest.json").artifacts["linux-x64"].file')" \
    && format="$(node -p 'require("/build/release/manifest.json").artifacts["linux-x64"].format')" \
    && version="$(node -p 'require("/build/release/manifest.json").version')" \
    && if [ "$format" = sea ]; then \
         test "$("/build/release/$artifact" --version)" = "$version"; \
       else \
         mkdir /build/release-smoke \
         && tar -xzf "/build/release/$artifact" -C /build/release-smoke \
         && test "$(/build/release-smoke/agentfleet/agentfleet --version)" = "$version"; \
       fi \
    && test "$(wc -c < /build/codex-x86_64-unknown-linux-musl.tar.gz | tr -d ' ')" = 98981886 \
    && test "$(tar -tzf /build/codex-x86_64-unknown-linux-musl.tar.gz)" = codex-x86_64-unknown-linux-musl \
    && mkdir /build/codex-smoke /build/codex-schema \
    && tar -xzf /build/codex-x86_64-unknown-linux-musl.tar.gz -C /build/codex-smoke --no-same-owner \
    && test "$(/build/codex-smoke/codex-x86_64-unknown-linux-musl --version 2>/dev/null)" = "codex-cli 0.154.0" \
    && /build/codex-smoke/codex-x86_64-unknown-linux-musl app-server generate-json-schema --out /build/codex-schema >/dev/null 2>&1 \
    && test "$(sha256sum /build/codex-schema/codex_app_server_protocol.v2.schemas.json | cut -d ' ' -f 1)" = f3487938786b729cb6773dbc9e83a7efab9c78c845db7094e8f539f373cbacc9 \
    && cp /build/codex-x86_64-unknown-linux-musl.tar.gz /build/release/codex-linux-x64-0.154.0.tar.gz \
    && cp /build/codex-aarch64-apple-darwin.tar.gz /build/release/codex-darwin-arm64-0.154.0.tar.gz \
    && cp /build/codex-x86_64-apple-darwin.tar.gz /build/release/codex-darwin-x64-0.154.0.tar.gz \
    && cp /build/codex-x86_64-pc-windows-msvc.exe.tar.gz /build/release/codex-win32-x64-0.154.0.tar.gz \
    && test "$(tar -tzf /build/bwrap-x86_64-unknown-linux-musl.tar.gz)" = bwrap-x86_64-unknown-linux-musl \
    && tar -xzf /build/bwrap-x86_64-unknown-linux-musl.tar.gz -C /build/codex-smoke --no-same-owner \
    && test "$(sha256sum /build/codex-smoke/bwrap-x86_64-unknown-linux-musl | cut -d ' ' -f 1)" = 77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c \
    && cp /build/codex-smoke/bwrap-x86_64-unknown-linux-musl /build/release/codex-bwrap-linux-x64-0.153.4 \
    && test "$(tar -tzf /build/bwrap-baseline.tar.gz)" = bwrap-x86_64-unknown-linux-musl \
    && tar -xzf /build/bwrap-baseline.tar.gz -C /build/codex-smoke --no-same-owner \
    && test "$(sha256sum /build/codex-smoke/bwrap-x86_64-unknown-linux-musl | cut -d ' ' -f 1)" = 01fb705f067bd5365b63d8ad2323a61c8d007733ca5e649437e086f3fb9935d8 \
    && cp /build/codex-smoke/bwrap-x86_64-unknown-linux-musl /build/release/codex-bwrap-linux-x64-0.153.2 \
    && node -e 'const fs=require("node:fs");const crypto=require("node:crypto");const names={"linux-x64":"codex-linux-x64-0.154.0.tar.gz","darwin-arm64":"codex-darwin-arm64-0.154.0.tar.gz","darwin-x64":"codex-darwin-x64-0.154.0.tar.gz","win32-x64":"codex-win32-x64-0.154.0.tar.gz"};const artifacts={};for(const [platform,file] of Object.entries(names)){const path="/build/release/"+file;artifacts[platform]={file,sha256:crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex"),size:fs.statSync(path).size,format:"tar.gz"}}const manifest={schemaVersion:1,version:"0.154.0",artifacts};fs.writeFileSync("/build/release/codex-manifest.json",JSON.stringify(manifest)+"\n")'

RUN tar -xzf /build/bwrap-validated.tar.gz -C /build/codex-smoke --no-same-owner \
    && test "$(sha256sum /build/codex-smoke/bwrap-x86_64-unknown-linux-musl | cut -d ' ' -f 1)" = 01fb705f067bd5365b63d8ad2323a61c8d007733ca5e649437e086f3fb9935d8 \
    && cp /build/codex-smoke/bwrap-x86_64-unknown-linux-musl /build/release/codex-bwrap-linux-x64-0.154.0

RUN node /build/packaging/prepare-code-mode.mjs /build/release

FROM node:24-bookworm-slim AS runtime
ARG AGENTFLEET_BUILD_SHA=unknown
ENV NODE_ENV=production \
    AGENTFLEET_BUILD_SHA=${AGENTFLEET_BUILD_SHA} \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/control-plane.sqlite \
    WEB_DIST_DIR=/app/web
WORKDIR /app
RUN groupadd --gid 10001 agentfleet \
    && useradd --uid 10001 --gid agentfleet --create-home --home-dir /home/agentfleet agentfleet \
    && mkdir -p /app/data /app/control-plane /app/web /app/runtime-releases \
    && chown -R agentfleet:agentfleet /app /home/agentfleet
COPY --from=control-plane-build --chown=agentfleet:agentfleet /build/apps/control-plane/package.json ./control-plane/package.json
COPY --from=control-plane-deps --chown=agentfleet:agentfleet /build/apps/control-plane/node_modules ./control-plane/node_modules
COPY --from=control-plane-build --chown=agentfleet:agentfleet /build/apps/control-plane/dist ./control-plane/dist
COPY --from=web-build --chown=agentfleet:agentfleet /build/apps/web/dist ./web
COPY --from=local-agent-release --chown=agentfleet:agentfleet /build/release/ ./web/downloads/
COPY --chown=agentfleet:agentfleet --chmod=0555 packaging/install.sh ./web/install
COPY --chown=agentfleet:agentfleet --chmod=0555 packaging/install-macos.sh ./web/install-macos
COPY --chown=agentfleet:agentfleet packaging/install.ps1 ./web/install.ps1
USER agentfleet
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=4s --start-period=12s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "control-plane/dist/src/index.js"]
