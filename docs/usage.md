# Usage and remaining quota / 用量与剩余额度

Agent 0.30.1 adds read-only account quota snapshots and persisted token counters. Open the usage button on a host, project, or session. From Agent 0.30.2, account snapshots refresh once on connection and after native quota/account change notifications. Bursts are coalesced with a five-second minimum gap between event-triggered queries; there is no periodic quota query while idle. Visible page summaries read the control plane every 30 seconds, without querying Codex. The host usage dialog offers an explicit refresh of host information and quota (using the existing read-only catalog refresh operation). No model request, session resume, or writer takeover is performed to collect quota.

| Figure | Meaning |
| --- | --- |
| Used / remaining quota | Codex account limits, shared across devices and sessions. Remaining is 100 minus the reported used percentage. A 10,080-minute window is weekly; 300 minutes is five hours. |
| Recorded tokens | Usage observed for managed sessions, grouped by project and host. Input and output are shown separately; cached input and reasoning output are subsets, not extra totals. |
| Last 7 UTC dates | Recorded usage dated today and the preceding six UTC dates. This is not the account quota reset cycle. |
| Native cumulative total | Latest native session counter, which may include earlier or fork-inherited history. It is shown separately from recorded consumption. |

## Coverage and reliability

- Collection begins with new native `thread/tokenUsage/updated` notifications after the Agent upgrade. It does not scan or modify native history. Standalone CLI activity, earlier history, and sessions with content synchronization disabled may be absent.
- The first snapshot records only the last reported request. Later snapshots add increases in cumulative counters. Repeated snapshots and durable retransmissions do not add usage twice. Counter resets start a new baseline and are marked as incomplete.
- Token counters persist across control-plane restarts. Deleted sessions are excluded from project and host totals; these are operational summaries, not a billing ledger. Turning content synchronization off stops collecting new session usage; previously recorded counters remain.
- Account snapshots are deduplicated only when the host can identify the account. The host hashes the account/workspace identifier together with the account email for grouping; raw account identifiers, email, and credentials are not sent in usage telemetry. Unknown identities are shown by source host without combining percentages.
- Snapshots older than three minutes are marked out of date. Activity in standalone CLI processes or other clients that do not report events through AgentFleets may remain unseen until an explicit refresh. API-key authentication or unsupported quota responses may provide no quota window. Missing data never means zero use or unlimited quota.
- Account percentage cannot reliably be attributed to an individual project from token counts. AgentFleets does not estimate that allocation, monetary charges, or a token balance from the percentage.

The authenticated read-only endpoints are `/api/machines/:id/usage`, `/api/projects/:id/usage`, and `/api/sessions/:id/usage`. Each enforces workspace ownership. The control-plane database migrates from schema 25 to 26; take a consistent backup before upgrading. Rolling back to a schema-25 binary requires restoring its matching backup.

## 中文说明

主机、项目、会话都可以打开用量详情。账号展示官方上报的已用比例、剩余比例、重置时间和更新时间；项目与会话展示已记录的输入、输出、缓存输入、推理输出及总 token，并提供消耗排名。缓存和推理明细已经包含在对应总量里，不能重复相加。

统计从升级 Agent 后收到的新通知开始，首次只计入最近一次请求，之后累计计数的增量。不会扫描或改写原生历史，也不会为了查询额度恢复会话或抢占写入。接入前历史、独立 CLI 中的请求和关闭内容同步的会话可能缺失；重复通知不重复计数，计数重置会明确标注缺失。重启保留统计；删除会话后，该会话不再计入项目与主机汇总，因此这里不是计费账本。

同账号额度不能跨主机相加，也不能按 token 比例分摊到项目。Agent 0.30.2 改为连接时查询一次，之后由原生额度或账号变更事件触发查询，短时间事件会合并，事件查询最小间隔为 5 秒；空闲时不定时查询 Codex。页面每 30 秒只读取云端快照；主机用量弹窗可主动刷新主机信息与额度，该操作同时使用已有的只读目录刷新。未接入通知链路的独立 CLI 或其他设备的消耗可能需要主动刷新才能看到。超过三分钟未更新会标注过期。没有上报不是零消耗或无限额度。最近 7 个 UTC 日期与账号周额度重置周期是两个不同范围。
