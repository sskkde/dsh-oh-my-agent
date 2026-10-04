# 规则加载契约（rule loading）

`@dsh-external/dsh-oh-my-agent` 规则引擎的**现行**加载契约：什么文件算规则、作用域怎么算、
经哪些通道进入上下文、预算与去重如何工作。实现：`src/rules.ts`（扫描 / 解析 / 作用域）、
`src/projectContext.ts`（有界组合）；本文与代码同步维护，行为以测试（`test/rules.test.mjs`、
`test/projectContext.test.mjs`、`test/rulesHooks.test.mjs`）为准。

## 规则源

| 来源 | 作用域 |
| --- | --- |
| workspace 根 `AGENTS.md` / 根 `CLAUDE.md` | 全局常设（alwaysApply） |
| 子目录 `AGENTS.md`（任意深度） | **目录作用域**：只适用其所在目录及后代；子 `CLAUDE.md` 不加载 |
| `*.mdc`（扫描深度 10 层内，任意位置） | 按 globs 匹配（既有行为不变） |
| `rules/`、`.rules/`、`.openagent/`、`.agents/rules/`、`.opencode/rules/` 下的 `*.md`（同样受 10 层扫描深度） | 按 globs 匹配（既有行为不变） |
| 用户层 `~/.omo/rules/` | 全局，优先级最低 |

## frontmatter

`description` / `globs` / `alwaysApply` / `applyTo: [file|session|tool|user_prompt]`。

作用域语义（先路径边界过滤，再谈其余）：

- 子 `AGENTS.md` 无论 `alwaysApply: true` 还是空 `globs`，都**不越过其目录子树**。
- 子 `AGENTS.md` 无 metadata 时默认 `applyTo: [file]`；根 AGENTS/CLAUDE 保持现有会话级语义
  （alwaysApply、默认 `applyTo: [file, session]`）。
- 局部规则**不会升级为全局常设守则**：`session` 通道只装根级 / 无目录作用域的常设规则。
- 不做自由文本的覆盖/冲突自动裁决：局部要求不能放宽根级约束；发生矛盾应报告并停止相关实施，而不是猜。
- `applyTo` 继续作为**通道门**：`alwaysApply` 不绕过通道声明。

## 路径边界（信任边界 = workspace 自身）

- 目标路径（相对/绝对）统一解析到 workspace 内；解析后落在 workspace 外的目标不匹配任何规则。
- 目标解析后越出 workspace 的 `../` 上跳、前缀碰撞（`src2/…` 不算 `src/` 内）与绝对外部目标不匹配 workspace 规则，也不制造伪祖先。
- 所有 workspace 规则来源（包括根 `CLAUDE.md` 及其他 workspace 规则文件）解析来源时均做 realpath containment 检查；解析失败或指向 workspace 外时 fail-closed，不读取其外部正文。
- 用户层 `~/.omo/rules/` 是显式配置的可信来源，独立于 workspace containment 检查；它不属于 workspace 内规则，也不与 workspace 文件共用同一信任域。
- 不上溯 workspace 父目录找规则。
- 祖先链按"根 → 目标实际父目录"**逐级发现**，不受 glob 扫描深度上限（walkFiles 10 层）影响，且无 64 层上限；
  逐级遍历至真实 workspace 根，展示不因排序优先级封顶而改变父先于子的祖先顺序，来源明确。
- 文件目标含其父目录链上的 AGENTS；**目录目标**（磁盘上确为目录）含该目录自己的 AGENTS；
  缺失文件按实际父目录解析；目录目标不推断未知后代的规则。

## 注入通道与预算

通道（`applyTo` 门）：

- `file`：成功 `read` / 成功 `edit` 的后置注入（rules-injector hook）。
- `session`：会话开始注入一次（仅根级常设守则，见上）。
- `tool` / `user_prompt`：预留，尚无自动通道。

预算 **2500 字符**（沿用现有 hook 上限，无公开配置；含提示头与来源清单）：

- 组合顺序：全局 / 常设规则优先，祖先规则按根 → 深层；组合按规则来源保留各自的 scope/targets。同一来源命中多个目标时正文只输出一次并合并适用目标；不同来源即使正文相同也不合并、不把一个 scope 错配给另一个目标。
- 每个来源条目保留完整 metadata（`name`、`scope`、`always`、`sources`、`targets`、正文）；组合指纹还覆盖 workspace、预算、提示头与通道等组合参数，任一有效输入变化均可触发重新交付。
- **只装完整规则**，不在正文中间截断；放不下的整条列为 omitted，附来源清单与 `contextIncomplete`
  声明，要求行动前 `read` 原文；若来源清单本身也超预算，只回报不完整状态并指引用
  `omo_rules action=path` 查询，不冒充完整加载。
- 规则注入是提示上下文，**不是写入前强制安全门**；也不以预算截断执行环境本来的系统安全约束。

## 交付去重（delivery ledger）

- 会话级账本：全局最新块指纹 + 按路径上次交付指纹，**两者皆新才投递**；10 分钟窗口过后可重发
  （对抗上下文压缩导致的副本丢失）。
- 去重键使用**全部适用规则（含被预算省略者）的完整正文指纹**——被省略的规则变化同样触发重投。
- A→B→A 内容回退视为变化、重新投递；不同会话之间互相隔离。
- **无 TTL 编译缓存**：规则文件变更在下一次解析立即生效。

## 自动渠道（诚实清单）

会自动注入的只有：成功 `read`、成功 `edit`（file 通道）；会话首步常设守则（session 通道）；
`omo_agents brief` 与 `delegate_as` 按 `files` 目标组合的上下文；`omo_rules action=path` 显式查询。

**其他渠道不自动注入**：`bash`、自定义工具、`write`、`omo_hashline_edit` 等不触发——需要时用
`omo_rules action=path path=<目标>` 显式获取。`docs/` 与 notes 的正文**不自动注入**，经 AGENTS 里的指针按需读取。
