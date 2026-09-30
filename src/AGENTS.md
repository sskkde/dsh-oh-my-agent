# AGENTS.md — src（宿主半体）

宿主半体 = `src/*.ts`（**不含** `src/client/`），编译到 `lib/`（ES2023 / NodeNext，`tsconfig.json:19` 排除 client）。入口 `src/index.ts`（2632 行）承载装配、全部工具定义、HTTP 路由与提示词段；其余模块提供实现细节。

## 模块地图

| 子系统 | 文件 | 职责 |
| --- | --- | --- |
| 装配 / 工具 | `index.ts` | 插件元数据、Config、`buildTools()`、注册、事件、HTTP 路由、prompt 段 |
| 公共底座 | `util.ts`、`glob.ts`、`cmd.ts`、`xxhash32.ts`、`hashline.ts` | 路径/IO/workspace 解析、glob 匹配、子进程、行哈希锚点编辑 |
| 委托路由 | `delegate.ts`、`agents.ts`、`modelRoute.ts` | 委托通道与三级路由、11 角色档案/简报/建队、category→fallback 链 |
| 守卫 / 钩子 | `hooks.ts`、`goalGuard.ts`、`sessionModel.ts`、`messageSource.ts` | pre/post-execute 钩子与拦截门、goal 注入治理、会话模式 off/prometheus/atlas、消息 kind 声明 |
| rules 引擎 | `rules.ts`（用 `glob.ts`） | 扫描 / 解析 frontmatter / glob 匹配 / 编译写 `.omo/rules/compiled.md` |
| 记忆与状态 | `memory.ts`、`boulder.ts`、`handoff.ts`、`teamTask.ts`、`monitor.ts` | MemFS 记忆、boulder 笔记与 activePlan 水位、交接摘要、团队任务表、后台监控 |
| ultrawork / 提示词 | `ultrawork.ts`、`sisyphusPrompt.ts`、`prometheusPrompt.ts`、`atlasPrompt.ts` | 计划状态机与波浪进度、三种会话纪律段文本 |
| 代码智能 | `lsp.ts`、`codeSearch.ts`、`codegraph.ts`、`commentCheck.ts` | LSP 客户端、ast-grep/文本搜索、codegraph CLI 包装、阻断标记扫描 |
| 技能面 | `skills.ts`、`dynamicSkills.ts` | 18 个内置技能文本、扫描 `.opencode/skills`+`.omo/skills` 的 SKILL.md 注册 |
| 配置 | `omoconfig.ts` | omo.jsonc 分层读取/深合并、路由层读写 |
| 辅助 | `docs.ts`、`lookAt.ts` | context7 文档检索、视觉意图编排 |

代码智能与 rules 都复用 `util.walkFiles` / `isCodeFile` / `isWithin`（`codeSearch.ts:15`、`commentCheck.ts:13`、`rules.ts:24-25`）。

## `index.ts` 导航（2632 行）

| 区段 | 行 |
| --- | --- |
| 各模块 import | 41-68 |
| `name` / `inject = ['tools','skills','webServer','systemPrompt']` | 70-73 |
| `interface Config` + `const Config = z.object(...)`（必须同步） | 75-101 |
| `tool()` 包装（统一 `stripUndefined` 栅栏） | 250-264 |
| `buildTools()`：22 个工具定义 | 278-约 1700 |
| `regOnce` + `apply()`：配置门控、工具/技能注册 | 1996-2033 |
| `webServer.register`：7 条 HTTP 路由 | 2058-2184 |
| 事件挂载：`tools/pre-execute`、`tools/post-execute`、`agent/created`、goal-guard 事件 | 2198-2382 |
| `systemPrompt.section`（Sisyphus / Prometheus / Atlas 段） | 2566-2617 |

工具定义锚点（名字 → 定义行）：`omo_status` 284、`omo_rules` 338、`omo_note` 406、`omo_hashline_edit` 476、`omo_hashline_lines` 546、`omo_code_search` 581、`omo_comment_check` 647、`omo_monitor` 705、`omo_ultrawork` 777、`omo_handoff` 879、`omo_team_task` 913、`omo_jsonc` 984、`omo_codegraph` 1064、`omo_memory` 1098、`omo_hooks` 1240、`omo_model_route` 1299、`omo_session_model` 1360、`omo_agents` 1401、`omo_docs` 1560、`omo_look_at` 1608、`omo_skills` 1642、`omo_lsp` 1695。

## 注册范式（照抄，别另起一套）

- **工具**：`defineTool` → `tool(name, desc, params, schema, render, execute)`（`index.ts:250-264`），execute 返回值必经 `stripUndefined`。注册在 `apply()` 里 `regOnce(ctx, () => ctx.tools.register(def), tag)`（`:2025-2028`）；注册前按 `omo.jsonc` 的 `disabled_tools` / `hashline_edit` / `monitor` 过滤（`:2009-2023`）。
- **技能**：`skills.ts` 里加一个 `SkillRegistration` 对象即可，`skillRegistrations()`（`skills.ts:183-185`）自动带出，宿主循环注册（`index.ts:2030-2033`）。
- **effect 生命周期**：`regOnce`（`index.ts:1996-2002`）把返回 disposer 归一化后交给 `ctx.effect`。事件监听要自己收集每个 `on()` 的注销函数，在 effect disposer 里逐个 try/catch（`:2198-2214`）。
- **提示词段**：先检查可选服务存在，再经 `regOnce` 注册 `systemPrompt.section({name, order, text})`（`:2566-2586`）；动态段按会话模式返回文本（`:2594-2617`）。注意 section 属**注册服务实例的 scope**：裸 `systemPrompt.assemble({})` 看不到 preset scope 注册段，要用 `agentPresets.standingKeyFor(presetId)` 取 scope 再 assemble（上层 `../README.md` 的「委托路由」节）。
- **HTTP 路由**：`webServer.register`，`kind: 'exact'`（`:2058-2184`）。

## 配置层级

`omoconfig.ts` 手写 JSONC 清洗（剥注释/尾逗号）后 `JSON.parse`（`:24-69`）；深合并只在 plain object 上递归，标量/数组后层覆盖（`:89-101`）。优先级从低到高：用户层 `~/.omo/omo.jsonc` → workspace 祖先层（近者优先）→ 设置页托管的 `model-routes.jsonc`（压过手写层）（`:112-155`）。

## 铁律

- **显式 `undefined` 是硬错误**：harness lossless-JSON 校验拒收工具返回值含 undefined 的键（曾造成"已写盘却报失败"）。统一栅栏在 `index.ts:250-264` / `util.ts:134-149`；手写对象要条件挂键（`:1546-1551`、`boulder.ts:144`）。
- **未知工具名不要传 `tools.restrict()`**：会响亮抛错（上层 `../README.md` 的「hooks 与守卫」）。守卫的白名单是 `hooks.ts:379` 的 `DELEGATION_TOOL_NAMES`，扩展走 `hooks.nested_delegation_extra_tools`（`hooks.ts:163-177`）。
- **防御式错误处理**：捕获后返回 `null` 或 `{ok:false, message}`，并尽量记诊断（`util.ts:59-66`、`omoconfig.ts:238-240`）。
- 具名导出；camelCase 函数 / PascalCase 类型 / UPPER_SNAKE 常量。

## 踩坑（都有代码或实测出处）

- **ast-grep 退出码**：`0` = 有匹配、`1` = 无匹配（`--json` 时 stdout 为 `[]`）、`2+` = 用法/IO 错误；把 1 当失败会让"无匹配"被误报，rewrite 的"无匹配"是**成功空操作**（`codeSearch.ts:71-79`）。**`--lang` 必须留在同一条 argv 里**：曾把它拼成独立 shell 命令（`command not found`、exit 127），导致带语言过滤的搜索静默退化为文本后端（`codeSearch.ts:57-69`）。
- **rules 空 body**：空正文规则（陈旧产物/占位符）必须返回 null 过滤掉，否则空注入（`rules.ts:114-117`）；扫描时跳过引擎自己的 `compiled.md`（`:159-161`）。
- **rules-injector 的投递语义**（改这块前必读）：编译块缓存键是 `${ws}::${目标路径}`（5s TTL、`RULES_CACHE_MAX=200` 上限）——只按 `ws` 缓存时，5s 窗口内第二个被编辑的路径会拿到第一个路径的 glob 结果，**批量 edit 会投错规则**。投递去重是**组合判据**（`rulesDeliveryIsNew`）：账本记"转录里最新一条块 hash"（`lastGlobalHash`）+ "该路径上次投递的块"（`perPath`，上限 64），**两者都判定为新**才投；再叠 `RULES_REDELIVER_MS` 10 分钟窗口。效果：同块重复/批量交替重放都静默，块变化（**含 A→B→A 回退**）与超窗口则重投。所以**别假设"每次 edit 都会注入"，也别假设"投过就永不再投"**。channel 门与 glob 匹配仍见上层 `../README.md` 的「hooks 与守卫」。
- **嵌套派发守卫**：只封 `delegate_as` 不够——`workflow` / `ralph` 内部直调 spawn 会绕过，故名单含这四个入口（`hooks.ts:379`），另在 `agent/created` 挂 per-agent 作用域守卫纵深（`index.ts:2205`、`:2219`）。判定用 `tools.guard`（`hooks.ts:430`）。
- **goal-guard 只挂已验证通道**：`agent/status` 对根会话经作用域过滤**不可达**，决策触发器用 `session/event`（`user/message` 的 `subagent-settled` 结算通知、`turn/end` 兜底）与 `goal/changed`（`index.ts:2349-2380`，注释记录了实测结论）。"还有子代理在跑"用 `subagents.listChildren(...)` 的 `activity === 'running'` 判断，`subagent/end` 不等价于任务结算（`index.ts:2266-2301`、`goalGuard.ts:18`）。
- **消息 kind 不能改名**：`'oh-my-agent'`（`messageSource.ts:21`）会写进会话日志，故取短名词而非 scoped 包名（`:15-19`）；消费者对未知 kind 向下穿透，运行时无需注册。
- 排查以**结构化记录**为准，别 grep 会话日志里的模型文本（上层 `../README.md` 的「codeSearch（ast-grep）」节）。
