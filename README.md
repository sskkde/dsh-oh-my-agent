# @dsh-external/dsh-oh-my-agent

在 DSH（DeepSeek Harness，Cordis）上**忠实复刻 oh-my-openagent（OmO，aka oh-my-opencode）**核心能力的插件。

> OmO 是一个多模型 agent 编排 harness（原为 OpenCode 插件）。本项目不搬运其 OpenCode 宿主绑定，
> 而是把它的**旗舰功能**按 DSH 原生能力（子代理/团队/目标/技能/编辑）重新实现，所有持久状态落入
> 会话工作区 `<workspace>/.omo/`（与 OmO 同名状态目录约定一致）。

## 复刻的功能矩阵（原功能 → 本插件实现 → DSH 原生能力）

| OmO 功能 | 本插件实现 | 状态 |
| --- | --- | --- |
| `ultrawork` 纪律协议 / ulw-loop | `omo_ultrawork`（计划状态机 + 波浪式委托 playbook + category→子代理映射）+ 技能 `omo-ultrawork` | ✅ |
| rules 引擎（.mdc / AGENTS.md，frontmatter + globs 匹配注入） | `omo_rules`（scan/compile/path）+ `rulesForPath` 编译块 | ✅ |
| boulder 跨任务记忆（learnings/decisions/issues/verifications/problems） | `omo_note`（append/list/update/checkpoint/new-thread） | ✅ |
| hashline 确定性精编（行号#2字符哈希，防 stale 误写） | `omo_hashline_edit` + `omo_hashline_lines`（xxhash32 16 符号字表） | ✅ |
| ast-grep 结构化代码搜索 / 重写 / 扫描 | `omo_code_search`（search/rewrite/scan）— **ast-grep 0.45 真后端已内置**（@ast-grep/cli），AST 级匹配/落盘改写 | ✅ |
| **LSP 语言服务器工具集**（OmO lsp-tools 复刻）：诊断/定义/引用/符号/改名 | `omo_lsp`（内嵌 vscode-languageserver-protocol MIT，typescript-language-server→tsserver，别名按语言探测） | ✅ |
| codegraph 代码知识图谱（symbol/节点/探索） | `omo_codegraph`（包装 ~/.omo/codegraph CLI） | ✅ |
| comment-checker（TODO/FIXME 扫描，@allow 豁免） | `omo_comment_check` | ✅ |
| monitor 后台命令流式回注（`[OMO MONITOR OUTPUT]` 信封） | `omo_monitor`（start/output/list/stop） | ✅ |
| `/handoff` 交接摘要 | `omo_handoff` + 技能 `omo-handoff` | ✅ |
| team mode 共享任务表 | `omo_team_task`（文件锁式共享队列） | ✅ |
| memory-core 持久记忆（markdown MemFS + frontmatter 契约 + 事务日志 + compile 注入） | `omo_memory`（create/put/read/str_replace/insert/delete/rename/update_description/compile/search/reflect/extract/journal）+ 技能 `omo-memory` | ✅ |
| model-core category->fallback 链路由 | `omo_model_route`（resolve/list，omo.jsonc `categories.<name>` 覆盖链与 reasoning 归一化）+ 技能 `omo-model-routing` | ✅ |
| Pre/PostToolUse 生命周期 hooks | `omo_hooks`（8 个：write-existing-file-guard / comment-checker / rules-injector / read-only-gate / **edit-error-recovery** / **json-error-recovery** / **monitor-status-injector** / **hashline-read-enhancer**，挂 DSH tools/pre-execute + post-execute；失败路径走恢复指引，成功路径走检查/注入） | ✅ |
| 子代理禁再派发（防嵌套委托） | nested-delegation-guard：全局 ToolGuard（子代理会话调用 `delegate_as`/`subagent*`/`workflow`/`ralph` 一律拒绝，含 `workflow.agent()`/`ralph` 内部直调 spawn 的绕过面，主会话不受影响）+ `agent/created` per-agent 作用域守卫纵深 + 委托时 `toolFilter` 使派发工具对子代理不可见；`hooks.nested_delegation_extra_tools` 逃生口、`hooks.nested_delegation_guard=false` 可关 | ✅ |
| omo.jsonc 分层配置（用户层+项目层逐级覆盖，[opencode] 开关） | `omo_jsonc` + `disabled_tools`/`hashline_edit`/`monitor` 开关接线 | ✅ |
| hyperplan 对抗式多智能体规划 | 技能 `omo-hyperplan` | ✅ |
| /refactor 智能重构（结构搜索→小步→TDD） | 技能 `omo-refactor` + `omo_code_search`/`omo_hashline_edit` | ✅ |
| remove-ai-slops 清 AI 代码异味 | 技能 `omo-remove-ai-slops` | ✅ |
| Prometheus 访谈规划 → Atlas 执行 | 技能 `omo-start-work`；纯规划变体（意图裁决 + decision-complete 计划 + 等批准）为技能 `omo-ulw-plan` | ✅ |
| 假设驱动调试（debugging skill） | 技能 `omo-debugging`（≥3 假设并行验证 / 两轮未破换正交角度 / 失败测试锁根因 / 清痕迹） | ✅ |
| 实现后审查（review-work skill） | 技能 `omo-review-work`（5 路并行审查：目标/质量/安全/QA/上下文，全过才过） | ✅ |
| /init-deep 分层 AGENTS.md | 技能 `omo-init-deep`（复杂度评分定层级 / 并发探索 / 跨层去重） | ✅ |
| git-master 原子提交与历史调查 | 技能 `omo-git-master`（模式门 COMMIT/REBASE/HISTORY/STATUS + 风格检测 + 原子分组） | ✅ |
| OmO 控制台 / 面板 | client 侧「OmO 控制台」卡片（`web-ui.plugin.item` 槽位）+ `GET /dsh-oh-my-agent/api/*` | ✅ |
| 差异化 agent 编排（11-agent：sisyphus/prometheus/atlas/oracle/librarian/explore/metis/momus/hephaestus/multimodal-looker/sisyphus-junior） | `omo_agents`（角色档案库 + category 模型绑定 + 委托简报生成 + agent_teams 建队方案）；执行复用 DSH subagent_* / agent_teams | ✅ 差异化层 |
| context7 官方文档检索 MCP | `omo_docs`（search/get 桥接 context7.com 免费 API，断网降级 web_search） | ✅ |
| look-at 视觉链路 | `omo_look_at`（意图->精准视觉 prompt 编排：ui-diagnose/chart-read/text-transcribe/compare/general，执行复用 DSH describe_image/read_image） | ✅ 编排层 |
| 自定义技能 SKILL.md（.opencode/skills） | `omo_skills`（扫描 .opencode/skills 与 .omo/skills 的 SKILL.md，frontmatter 解析，注册为 DSH 运行时技能） | ✅ |
| 11-agent 多模型编排 / 原生团队 | 复用 DSH subagent_* / agent_teams / goal / ralph（角色职责见技能 `omo-subagent-roles`，选型见 `omo_model_route`，简报见 `omo_agents`） | 🔗 由 DSH 承担 |

## 工具一览（21 个）

`omo_status` · `omo_rules` · `omo_note` · `omo_hashline_edit` · `omo_hashline_lines`
`omo_code_search` · `omo_comment_check` · `omo_monitor` · `omo_ultrawork` · `omo_handoff` · `omo_team_task` · `omo_jsonc` · `omo_codegraph` · **`omo_lsp`** · **`omo_memory`** · **`omo_model_route`** · **`omo_hooks`** · **`omo_agents`** · **`omo_docs`** · **`omo_look_at`** · **`omo_skills`**

技能（16）：`omo-ultrawork` · `omo-start-work` · `omo-rules` · `omo-handoff` · `omo-memory` · `omo-model-routing` · `omo-subagent-roles` · `omo-deliver` · `omo-hyperplan` · `omo-refactor` · `omo-remove-ai-slops` · `omo-debugging` · `omo-review-work` · `omo-ulw-plan` · `omo-init-deep` · `omo-git-master`

## 快速上手

1. 注入后对任意会话说“ultrawork，帮我 …”，agent 会加载 `omo-ultrawork` 技能并进入纪律协议。
2. 先 `omo_status` 看工作区识别与规则概况；`omo_rules action=compile` 预编译项目规则。
3. 编辑用 `omo_hashline_lines` 取行哈希 → `omo_hashline_edit` 做确定性精编。
4. 干活过程 `omo_note` 记录经验；收尾 `omo_comment_check` + `omo_handoff`。

## goal-guard（方案 B）：派发子代理期间的 goal 注入治理

**问题**：DSH `goal-round-driver` 在 agent idle 且 goal `active+armed` 时必然排队下一轮
`<goal_round>` 注入。dsh-omo 的委托纪律是“派发后台 continuable 子代理后结束回合、
等结算通知”——等待窗口内 agent 处于 idle，armed goal 会被**反复注入**并烧光
`maxGoalRounds`。模型工具层的 `pause/resume` 要求直接人类回合，模型自救不了。

**对策**（插件在宿主服务层代为治理，无需人类介入）：

- **派发** `delegate_as`（continuable）成功时：goal `active+armed` → `ctx.goals.disarm`
  （进程内，无耐久事件、不改 phase/revision），记 mark（goalId/revision）。
- **等待窗口**（`subagents.listChildren` 仍有 `activity:'running'` 子代理时）：
  goal 若被重新武装（等待中才设置 goal / 人类手动 resume）→ 再次 disarm。
- **结算**（`session/event` 的 `user/message source.kind='subagent-settled'` 通知，
  或本会话 `turn/end`，或 `goal/changed`）：mark 未毒化、goal 仍 `active+disarmed` 且
  id/revision 一致 → `ctx.goals.resume` 重新武装，恢复正常自主续跑。
- **毒化**（fail-safe）：等待窗口内出现 driver 的故障信号（agent/error、
  turn/end max-tokens/aborted）→ 禁止自动 resume，交给人类。

**事件通道实测结论**：根会话的 `agent/status` 经作用域过滤**不可达**（只有子代理的
idle 能到），`session/event` 与 `goal/changed` 可达——决策触发器只挂在已验证通道上。

开关：omo.jsonc 或插件配置 `goalGuardOn: false` 关闭（默认开启）。
观察：`GET /dsh-oh-my-agent/api/goalguard` 返回守卫状态快照 + diag 计数器：
`omo_status` 输出 `goal-guard: N agents guarded`。

## 构建 / 注入

```bash
# dev 生产线
dev_build_plugin   # bash scripts/build.sh (host) + npm run build:client + npm pack
dev_inject_plugin  # 运行时注入（host+UI 全生效）
dev_reload_package # 热重载
dev_uninject_plugin
```

状态约定：`<workspace>/.omo/{boulder.json,notepad.md,rules/,work/,plans/,monitors.json,monitor/,team/,checkpoints/}`。
boulder 携带 `activePlan` 水位（id/名称/进度 total/completed/status）——ultrawork/start-work 的跨会话 RESUME 指针：`omo_ultrawork` 建计划即写水位，`completed` 参数推进，`deliver` 标记完成；`omo-start-work` 技能先查水位决定 RESUME 或 INIT。

## 分层配置开关（omo.jsonc）

用户层 `~/.omo/omo.jsonc` 与项目层 `.omo/omo.jsonc`（近者覆盖远者，JSONC 支持注释/尾逗号）：

```jsonc
{
  "opencode": {
    "disabled_tools": ["omo_code_search"],   // 跳过注册的工具
    "hashline_edit": { "enabled": true },
    "monitor": { "enabled": true }
  }
}
```
用 `omo_jsonc action=read` 查看合并结果，`action=validate` 校验合法性。

许可证：BSD-3-Clause（复刻思路来自 oh-my-openagent，SUL-1.0，仅作功能映射不复用其代码）。
