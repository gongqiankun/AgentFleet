# AgentFleets for Codex

[English](README.md)

自行部署的 Codex 网页工作台，统一管理自己的 Linux、macOS 和 Windows 主机上的原生会话。任务在宿主机执行，浏览器用于查看对话、发送消息和管理接管状态。

本项目独立开发，并非 OpenAI 官方产品。请自行安装，使用自己的 Codex 凭据；项目不提供共享站点或默认登录账号。

## 功能

- 按主机、项目浏览原生会话，实时查看输出。
- 接管并继续同一个原生会话，释放后可回到宿主机使用。
- 支持重命名、归档、分支和删除；相关能力由宿主机确认。
- 消息排队、会话执行权限配置，以及结果不确定时的冻结和手动解冻。
- 图片上传、按会话查看存储占用、预览并执行受支持的图片清理。
- 中英文界面和响应式布局；Enter 发送，Ctrl+Enter 或 Mac 的 ⌘+Enter 换行。

## 自行部署

需要 Docker、Compose、HTTPS 反向代理，以及安装了受支持 Codex 的宿主机。源码构建会下载依赖和各平台运行时，需要网络访问。写入能力由操作系统、凭据保护和 App Server 协议检查共同决定，不能仅凭版本号判断兼容。

```sh
git clone https://github.com/gongqiankun/AgentFleet.git
cd AgentFleet
cp .env.example .env
```

启动前修改 `.env`：

- `ADMIN_EMAIL` 填自己的邮箱；`ADMIN_PASSWORD` 设置至少 12 位的独立密码，没有预设密码。
- `PUBLIC_ORIGIN` 和 `ALLOWED_ORIGINS` 填自己的 HTTPS 地址，不带末尾斜杠。
- HTTPS 保持 `COOKIE_SECURE=true`；反向代理位于同机时保持 `PUBLISH_HOST=127.0.0.1`。
- 使用转发头时，`TRUSTED_PROXIES` 只配置已核验的直接代理地址。

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:3215/ready
```

将自己的 HTTPS 地址反向代理到 `127.0.0.1:3215`，开启 WebSocket 升级支持。访问自己的地址，用自己配置的账号密码登录，在面板中添加主机，并在目标主机运行生成的一次性安装命令。不要分享配对票据。

仅在本机回环地址体验时，可将两个 origin 都设为 `http://127.0.0.1:3215`，并设置 `COOKIE_SECURE=false`。不要把这套 HTTP 配置用于公开部署。

Compose 使用命名卷保存控制面数据和已验证的运行时。升级前备份配置及数据卷；`docker compose down -v` 会删除数据卷，请勿作为普通升级步骤。仅更新网页的方式见[发布说明](docs/web-only-release.md)。

## 接管、恢复与冻结

同一个原生会话只能有一个写入进程。面板接管期间，不要在宿主机对同一会话执行 `codex resume`。先在面板释放接管，等宿主机确认后再本地恢复。回到面板前，先退出本地写入进程，再接管。重命名只改变标题，不改变原生会话 ID。

断连或重启可能让操作结果不确定，即使对话中已经出现回复。系统会冻结写入，不会自动重发可能产生副作用的动作。请先核验宿主机及原生会话，再手动点击解除冻结。解冻不代表上一条操作失败，也不会撤销它；确定结果前不要重复发送。

## 数据与图片

控制面保存账号和主机注册信息、同步的对话内容、操作记录和上传图片。Codex 执行及模型凭据保留在宿主机。控制面不是无存储转发器，需要保护控制面数据卷和宿主机数据。

默认图片配额为每主机 50 MB。受支持的清理可删除面板上传图片在两端的对应内容，保留文字与原生会话身份。原生历史清理目前限已验证的 Linux/Codex 适配器，需要 Python 3；不支持或来源不明的数据会被拒绝。不会清理供应商云端数据或独立备份。清理后原生历史文件字节数可能不缩小，存储大小也不等于 token 用量。详见[图片清理说明](docs/panel-image-cleanup.md)。

## 开发

使用 Node.js 24 和 npm：

```sh
npm ci --prefix apps/control-plane
npm ci --prefix apps/local-agent
npm ci --prefix apps/web
npm run check
npm test
npm run build
```

`apps/control-plane` 是 API 与 SQLite 控制面，`apps/local-agent` 是宿主机 Agent，`apps/web` 是 React 工作台，`packaging` 提供安装器和构建脚本，`experiments` 包含隔离的原生历史兼容性工具。

参阅[贡献指南](CONTRIBUTING.md)、[安全问题报告](SECURITY.md)和[打包说明](packaging/README.md)。涉及会话所有权、操作重放或原生历史的修改，需要针对恢复行为进行测试。

## 许可证

[MIT](LICENSE)。第三方软件保留各自许可证，见[第三方声明](THIRD_PARTY_NOTICES.md)。
