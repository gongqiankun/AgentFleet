import { t, localized } from "../i18n";
export interface CodexCommand {
  name: string;
  label: string;
  action: "settings" | "permissions" | "copy" | "diff" | "new" | "close" | "native" | "inspect" | "draft" | "raw" | "help" | "pending" | "terminal";
  coverage: "available" | "partial" | "pending" | "terminal";
  note: string;
  canonical?: string;
}
const command = (name: string, label: string, action: CodexCommand["action"], note: string, coverage: CodexCommand["coverage"] = "available"): CodexCommand => ({ name, label, action, note, coverage });
const implemented: CodexCommand[] = localized(() => ([
  ...[["model",t("模型与推理强度")],["plan",t("计划模式")],["fast",t("服务档位")],["personality",t("沟通风格")]].map(([name,label]) => command(name,label,"settings",t("打开可编辑选项；只允许主机声明支持的配置，用于下一轮。"))),
  command("status", t("运行配置"), "settings", t("显示来源、下次配置、上次接受和最近读取值；尚无完整上下文余量统计。"), "partial"),
  command("copy", t("复制已同步回复"), "copy", t("复制已加载的最后一条同步回复，不含尚未同步的本机输出。"), "partial"),
  command("diff", t("查看已同步差异"), "diff", t("定位已有差异摘要；不是即时扫描整个 Git 工作区。"), "partial"),
  command("new", t("新建会话"), "new", t("在当前项目打开新建会话；旧会话与文件保留。")),
  command("clear", t("开始全新会话"), "new", t("打开同项目新建会话，不删除旧记录；网页不需要清空终端。")),
  command("resume", t("切换保存的会话"), "close", t("返回项目列表选择会话；历史格式仍需支持接管。")),
  command("exit", t("关闭会话详情"), "close", t("只关闭网页详情，不停止任务或主机连接服务。")),
  ...[["rename",t("重命名宿主机会话")],["fork",t("从历史创建分支")],["archive",t("归档宿主机会话")],["unarchive",t("恢复宿主机归档")]].map(([name,label]) => command(name,label,"native",t("修改原生 Codex 会话，需主机能力和空闲状态；分支不保证可接管所有历史格式。"))),
  command("compact", t("压缩上下文"), "native", t("启动原生压缩，可能消耗额度；启动回执不代表完成。")),
  command("review", t("审查未提交修改"), "native", t("当前仅支持未提交修改，不支持提交号或基准分支参数。"), "partial"),
  command("stop", t("停止会话后台终端"), "native", t("确认后停止当前 App Server 中此会话的全部后台终端，不是取消模型任务或停止系统服务。")),
  ...[["account",t("账号状态")],["usage",t("用量窗口")],["debug-config",t("配置来源")],["skills",t("项目技能")],["mcp",t("MCP 状态")],["apps",t("应用连接器")],["plugins",t("已安装插件")],["hooks",t("项目钩子")],["ps",t("后台终端")],["goal",t("任务目标")],["permissions",t("执行权限")],["experimental",t("实验功能")]].map(([name,label]) => command(name,t("查看{0}", label), name === "permissions" ? "permissions" : "inspect", name === "ps" ? t("读取当前会话的原生后台终端。接口没有历史输出；不是系统进程列表。") : name === "goal" ? t("只读现有目标；目标写入和自动续跑需要额外的任务状态协调。") : name === "permissions" ? t("打开主机、项目、会话权限继承设置；支持项目内开发、联网和完整访问，不改写本机 CLI 配置。") : name === "experimental" ? t("只读功能状态，不写配置或切换开关。") : t("只读查询，不安装、启停、登录或写配置；结果有数量上限。"), "partial")),
  command("init", t("准备项目指令生成任务"), "draft", t("生成可编辑任务草稿，确认发送后由 Codex 检查或创建 AGENTS.md；不会立即写文件。"), "partial"),
  command("raw", t("纯文本阅读"), "raw", t("切换已加载同步内容的纯文本视图，不读取原始 RPC、密钥或未同步日志。"), "partial"),
  command("help", t("命令清单与支持范围"), "help", t("逐项查看可用、部分支持、待接入和终端专属命令。")),
]));
const pending: [string, string, string][] = localized(() => ([
  ["delete",t("永久删除原生会话"),t("原生删除可能连带后代会话；需影响预览、二次确认和云端/主机一致性处理。云端正文删除不等于此命令。")],
  ["approve",t("重试自动审查拒绝"),t("不是普通的一次性权限审批；需要原生拒绝记录、精确重试标识及审查策略协同。")],
  ["agent",t("切换子代理"),t("需同步父子关系、线程生命周期和可接管状态，不能把普通项目会话列表当作子代理树。")],
  ["mention",t("选择项目文件"),t("需主机侧受限文件检索、路径校验及类型化上下文引用；目前可在普通消息里说明项目相对路径。")],
  ["logout",t("退出主机 Codex 账号"),t("会影响该主机共享登录的会话；需账号恢复/重新登录流程。不是退出面板账号。")],
  ["memories",t("记忆配置"),t("需按版本验证配置键、作用范围和回执，不能任意改写主机配置。")],
  ["import",t("导入外部项目与会话"),t("需检测、预览、选择、冲突处理及异步进度；不直接覆盖宿主机文件。")],
  ["side",t("临时旁支对话"),t("需临时分支生命周期与父会话并行状态；不能用永久 fork 冒充。")],
  ["feedback",t("提交诊断反馈"),t("需诊断内容预览、脱敏与用户选择接收方；不会自动外传日志。")],
]));
const terminal: [string, string][] = localized(() => ([["ide",t("IDE 当前文件与选区")],["keymap",t("终端快捷键")],["vim",t("终端 Vim 编辑")],["setup-default-sandbox",t("Windows 提权沙箱设置")],["sandbox-add-read-dir",t("Windows 额外可读目录")],["app",t("切换宿主机桌面应用")],["statusline",t("终端状态栏")],["title",t("终端窗口标题")],["theme",t("终端配色主题")],["pets",t("终端宠物")]]));
const base = localized(() => ([...implemented, ...pending.map(([name,label,note])=>command(name,label,"pending",note,"pending")), ...terminal.map(([name,label])=>command(name,label,"terminal", name.includes("sandbox") ? t("原生 Windows 安装/权限操作依赖本地 OS 设置，不适用于网页直接等价执行。") : t("这是终端或桌面界面行为，网页不会改动另一台机器的终端/IDE；需要独立的网页等效设计。"),"terminal"))]));
export const codexCommands: CodexCommand[] = localized(() => ([...base, ...[["quit","exit"],["subagents","agent"],["btw","side"],["pet","pets"]].map(([name,canonical])=>({...base.find(item=>item.name===canonical)!,name,canonical}))]));
export const coverageLabels = localized(() => ({ available: t("可用"), partial: t("部分支持"), pending: t("待接入"), terminal: t("终端专属") }));
export const initInstructions = ("请检查当前项目的结构、现有文档和已有 AGENTS.md。若 AGENTS.md 不存在，创建适用于当前项目的简洁指令文件，包含实际可验证的构建、测试、代码约定；若已存在，先说明需要补充的内容，保留用户现有规则，不盲目覆盖。不要编造命令或运行破坏性操作。");
export function parseCodexCommand(input: string): { name: string; args: string } | null {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+(.*))?$/is.exec(input.trim());
  return match ? { name: match[1].toLowerCase(), args: match[2] ?? "" } : null;
}
