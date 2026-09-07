/**
 * Runtime skills — the slash-command equivalents of oh-my-openagent, delivered
 * as DSH skills (the harness's native command/skill surface).
 */

import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

const ULTRAWORK: SkillRegistration = {
  name: 'omo-ultrawork',
  description:
    '启动 ultrawork 纪律协议：探究代码库 → 按类别并行委托波浪 → 用诊断验证 → 交付。输入一个目标，按 playbook 执行到底，不中途停止。',
  whenToUse: '用户说 "ultrawork"、"ulw"、或要求“自主把 X 做完/做到交付”。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# ultrawork protocol（oh-my-openagent 纪律协议 · DSH 移植版）

When the user asks for ultrawork (or a long-running "do it all the way" task),
run this protocol to the end. Do NOT stop halfway. The goal is: it just works
until the task is done.

## Rules of engagement
1. **Never say "I cannot"** without first exploring the codebase and trying.
2. **Fight for completion** — fix errors as they appear, re-run, keep going.
3. **Automate repetition** — anything done twice should be looped or delegated.
4. **Small verified steps** — after every meaningful change, run the checks.
5. **Log decisions** to boulder so later agents reuse them.

## Phase 0 — Plan
- Read enough of the repo to act (glob/grep/read). Identify entry points, tests, build commands.
- If no plan exists, create one with \`omo_ultrawork\` (goal + waves + verification), then proceed.

## Phase 1 — Explore
- Ground each wave: confirm files, conventions, and the verification commands.
- Record conventions with \`omo_note\` (section=learnings).

## Phase 2 — Waves (parallel & serial delegation)
- Split work into independent "waves". Name each wave, assign a **category**, a task, and touched files.
- **Before finalizing waves**, run parallel recon when the codebase is unfamiliar: fire
  delegate_as(role=explore) + delegate_as(role=librarian) in the background (and one
  delegate_as(role=oracle, run_in_background=false) foreground) to ground the plan — do
  not guess conventions.
- **Independent waves: delegate in parallel** — fire every delegate_as call in ONE
  message (role=sisyphus-junior / hephaestus / oracle per category), then collect.
- **Dependent waves**: wait for their dependencies first.
- Every delegated brief MUST carry: TASK / EXPECTED OUTCOME / STOP WHEN / EVIDENCE / MUST NOT DO / CONTEXT.
- Verify each wave's returned EVIDENCE, not self-reported "done".
- After 3 consecutive worker failures on the same wave: stop, revert, document, escalate.
- **You are the orchestrator, not the implementer**: writing code goes to workers;
  you plan, delegate, and verify.

## Phase 3 — Verify
- Run the verification commands from the plan. Fix failures. Re-run until green.
- Run \`omo_comment_check\` to catch leftover TODO/FIXME; clean them (or \`@allow\` intentionally).
- Record wave progress: call \`omo_ultrawork\` with phase=verify and completed=<n completed waves>
  so boulder keeps the RESUME watermark fresh.
- Save progress: \`omo_note checkpoint\`.

## Phase 4 — Deliver
- Summarize what changed (files + behavior), with evidence.
- Record learnings/decisions/issues/verifications to boulder (\`omo_note\`) — this is the
  "wisdom accumulation" that lets a later session start warm.
- Produce \`omo_handoff\` so a fresh session can continue.
- **Never compromise**: hit a blocker → consult, ask the user, or change approach —
  return only when the goal is actually done.
- Report done to the user.

## 完成协定（Oracle 验证门——系统级，非可选）
1. 你认为工作完成时，输出 \`<promise>DONE</promise>\`——这**不结束循环**。
2. 必须立即派**独立 Oracle 验证**：\`delegate_as(role=oracle, run_in_background=false)\`，验证 prompt 至少含：原任务、变更清单、验证命令输出、手工 QA 证据；要求核验"是否真完成/有无隐藏缺口/证据是否可信"（怀疑默认不完成）。
3. 仅当 Oracle 验证**通过**后，输出 \`<promise>VERIFIED</promise>\` 结束循环；不通过 → 按 Oracle 指出的缺口修复 → 重送验证（同会话续派，不重开）。
4. 系统钩子会在检测到未经验证的 \`<promise>DONE</promise>\` 时持续注入提醒——不要试图绕过。

## 中止
用户说 \`/omo-cancel-ultrawork\` 或"停止/取消"：立即停止循环——清 boulder activePlan（omo_ultrawork cancel=true）、还原会话模式（omo_session_model state=off）、简要交代已完成的与未完成的，然后停。

## 会话模型（自动退出规划态）
触发本技能自动退出 Prometheus 规划态：会话模型还原到切换前（或会话默认），写门打开。
不切换执行态、不换指挥——需要 Atlas 执行编排请走 start-work。若本不在规划态则无操作。`,
}

const START_WORK: SkillRegistration = {
  name: 'omo-start-work',
  description: '按已批准计划执行（复刻 OmO start-work）：选计划/恢复 → Atlas 编排执行到完成；无可执行计划时明确告知（先 /omo-ulw-plan 出计划并经批准），不访谈、不现场造计划。',
  whenToUse: '用户说 "start-work"、"/start-work"、已批准计划后要求"把计划跑完/开始执行/继续计划"。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# start-work（OmO start-work 语义移植 · 按已批准计划执行）

本技能只做一件事：把**已批准的计划**跑完。**不访谈、不写计划、不评审计划**——规划属于 ulw-plan，执行属于本技能。

## 会话模型（Atlas 执行态）
进入本技能时，插件**仅当存在可执行计划**（\`.omo/plans/\` 下有计划文件，或 boulder 有 activePlan）才自动切换为 Atlas 执行态：
模型切 Atlas 角色路由（delegate_roles.atlas > categories.ultrabrain > heavy 档）、注入执行纪律段（omo:atlas-execution）、写门打开。
若未自动生效，可 \`omo_session_model(state=atlas)\` 手动开启；结束后 \`omo_session_model(state=off)\` 还原默认。

## 无可执行计划 → 明确告知（不做任何 bootstrap）
读 \`.omo/plans/\` 与 \`.omo/boulder.json\`：
- 无任何计划文件且无 activePlan → **明确告知用户**："当前没有可执行的已批准计划。请先运行 /omo-ulw-plan 产出计划并经批准，再 /omo-start-work 执行。"
  然后**停止**——不自行进入执行、不访谈、不现场造计划、不派任何实现子代理。

## 选计划（有可执行计划时）
- boulder 有 activePlan 且未完成 → 恢复它：读计划全文与进度（completed/total），从第一个未勾 \`- [ ]\` 的 checkbox 继续，不重头来。
- 无 activePlan 但 \`.omo/plans/\` 恰有一个计划文件 → 自动选择。
- 多个计划或多个 active work → 用 \`ask_user_question\` 一次问清选哪个（展示计划名/进度/时间戳）。

## 执行（Atlas 编排，绝不 implementer）
- 你是编排者不是实现者：代码 / 测试 / QA 全部经 delegate_as 派发；自己只碰计划选择、\`.omo/\` 状态（boulder、checkbox、ledger）、分解、派发、验收、证据记录。
- 每次委托带 6 段简报（TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT）+ STOP WHEN / EVIDENCE 验收项。
- 并行默认：独立任务一条消息全发，只排命名依赖。
- 每波验收：读回变更文件 + 跑验证命令 + 重读计划；全绿才把 checkbox 勾 \`- [x]\` 再推进。
- 失败续跑：send_message 回同一子代理补交付物；同一波连续 3 次失败：停止、回退、记录、换代。
- 收尾 Final Wave：验证清单全绿 + 独立验证者全部 APPROVE 才报完成——裁决者**优先 role=metis**（只读验收核验），
  仅当用户明确指定时才用 role=oracle；实操核验可配 role=sisyphus-junior 真实跑验证；执行者（本人与实现 worker）不得自评。
  交付报告含变更清单与 Final Wave 结论。
- 每任务后把 learnings/decisions/issues/verifications 沉淀到 \`omo_note\`；收尾 \`omo_comment_check\` + \`omo_handoff\`。`,
}

const RULES: SkillRegistration = {
  name: 'omo-rules',
  description:
    '规则引擎（.mdc 规则文件）用法与编写规范：按 globs 匹配注入代理策略，alwaysApply 全局生效。',
  whenToUse: '用户提到 "rules"/"规则文件"/".mdc"，或需要为项目/目录设定代理行为准则。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-rules — rules engine

The plugin compiles rule files from the workspace and injects them as prompt
context. Author them so future agents obey project conventions.

## Files that count
- \`AGENTS.md\` / \`CLAUDE.md\` at workspace root (global, alwaysApply).
- \`*.mdc\` anywhere (Claude-style rule files).
- \`rules/**/*.md\`, \`.rules/**/*.md\`, \`.agents/rules/**\`, \`.opencode/rules/**\`.

## Frontmatter
\`\`\`markdown
---
description: One-line purpose of this rule.
globs: ["**/*.ts", "src/**"]
alwaysApply: false
applyTo: [file, session, tool]
---
Rule body...
\`\`\`

## Injection channels (applyTo)
- \`file\`（默认含）— edit 工具按目标路径注入（rules-injector 后置挂点）。
- \`session\` — 会话开始时注入一次（pre-step 监听；仅 alwaysApply 且 applyTo 含
  \`session\` 的"常设守则"走此通道，避免普通规则双重刷屏）。
- \`tool\` / \`user_prompt\` — 预留，尚无自动通道；不写 \`file\` 的规则在文件编辑
  时不会注入（通道门对 alwaysApply 同样生效）。

## Usage
- \`omo_rules\` action=scan → list every rule file found + parse status.
- \`omo_rules\` action=path path=src/foo.ts → which rules apply to that file (globs matched; file channel).
- \`omo_rules\` action=compile → compile all matching rules into \`.omo/rules/compiled.md\`.
- Precedence: user(\`~/.omo/rules\`) < workspace root < deeper dirs (deeper wins);
  alwaysApply rules are injected first.`,
}

const HANDOFF_SKILL: SkillRegistration = {
  name: 'omo-handoff',
  description: '生成为新会话续作的完整上下文交接摘要（规则/记忆/计划/下一步）。',
  whenToUse: '需要把当前工作交给新会话继续时，或用户说 "handoff"。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-handoff — context handoff

When a task should continue in a fresh session (you are out of context, the user
will resume later, or a subagent must carry on), generate a handoff block with
\`omo_handoff\`:

- Call \`omo_handoff\` with goal, a short conversation summary, and next steps.
- It bundles: workspace path, compiled rules, boulder memory, active ultrawork
  plan, and your next steps.
- Paste the returned markdown into the new session (or into \`omo_handoff\`'s
  conversation field), so the new agent starts warm instead of cold.

Keep every handoff self-contained: never rely on the receiving agent knowing
what happened before.`,
}

export function skillRegistrations(): SkillRegistration[] {
  return [ULTRAWORK, START_WORK, RULES, HANDOFF_SKILL, HYPERPLAN, REFACTOR, REMOVE_AI_SLOPS, SUBAGENT_ROLES, DELIVER, MODEL_ROUTING, MEMORY, DEBUGGING, REVIEW_WORK, ULW_PLAN, INIT_DEEP, GIT_MASTER, SISYPHUS_RETURN, CANCEL_ULTRAWORK]
}

const CANCEL_ULTRAWORK: SkillRegistration = {
  name: 'omo-cancel-ultrawork',
  description: '停止 ultrawork / 自主执行循环：清 boulder activePlan 水位、还原会话模式，明确交代已完/未完并停。',
  whenToUse: '用户说"停止/取消 ultrawork"、"别自动继续了"、"cancel"，需要中止当前自主执行循环。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-cancel-ultrawork — 停止自主执行循环

立即停止当前 ultrawork / 自主执行：

1. 清 boulder 活跃计划水位：调用 \`omo_ultrawork\` 并传 \`cancel: true\`（清除 activePlan，杜绝后续 RESUME 自动续跑）。
2. 还原会话模式：\`omo_session_model(state=off)\`（若处于规划态/执行态一并退出）。
3. 向用户简要交代：已完成的 / 未完成的 / 可续接点；然后**停**，不再自动继续。`,
}

const SISYPHUS_RETURN: SkillRegistration = {
  name: 'omo-sisyphus',
  description:
    '回到西西弗斯模式：退出当前会话模式（prometheus 规划态 / atlas 执行态），还原默认模型、Sisyphus 编排纪律段与写门状态。',
  whenToUse: '用户说"回到西西弗斯/退出规划/退出执行/还原默认模式"，或想结束 ulw-plan / start-work 的会话模式。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-sisyphus — 回到西西弗斯模式

退出当前会话模式并还原默认编排节奏：模型还原（切换前模型，无快照则会话默认）、写门恢复、系统提示回到 Sisyphus 编排纪律（omo:sisyphus-discipline）。

插件在检测到本技能注入时自动执行还原；若未自动生效，调用 \`omo_session_model(state=off)\` 手动还原。`,
}

const MEMORY: SkillRegistration = {
  name: 'omo-memory',
  description: '持久记忆引擎（复刻 OmO memory-core）：markdown MemFS + frontmatter 契约 + 事务 + compile 注入。跨会话积累经验并经 compile 注入新任务。',
  whenToUse: '需要把学到的东西持久化、或在新任务开局注入历史结论时。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-memory — 持久记忆引擎（OmO memory-core 移植）

记忆存 <workspace>/.omo/memory/*.md（markdown MemFS），每个文件必须带非空 description frontmatter；read_only: "true" 的记忆禁改。所有写操作走事务日志（.meta.json），git 可用时自动 commit。

## 使用姿势
- **开局**：\`omo_memory status\` → \`compile\` 把历史结论注入本任务（遵守，别重新发现）。
- **干活中**：学到约定/踩坑/决策 → \`put\` 写到 learnings.md / decisions.md / issues.md（或 create 新文件）。
- **收尾**：\`reflect\`（从 boulder 汇经验）→ \`compile\` 更新注入块 → \`search\` 复核。
- **抽取**：\`extract\` 从对话/文本自动提炼事实写 facts.md。

## 常见动作
- status / list / read {name}
- create {name, content, description}（description 必填）
- put {name, content}（upsert，保留旧 description；或传 description 覆盖）
- str_replace {name, old_text, new_text}（必须唯一匹配）
- insert {name, content, after_line?} / delete {name} / rename {name, new_name}
- update_description {name, description}
- compile / search {query} / reflect / extract {text} / journal

## 契约（重要）
- description 为空 → 拒绝。
- read_only 记忆 → 一切改写拒绝。
- str_replace 旧文本须唯一，否则报错防误伤。
- 命名：A-Za-z0-9._- 且 ≤60 字符。`,
}

const MODEL_ROUTING: SkillRegistration = {
  name: 'omo-model-routing',
  description: '模型 category→fallback 链路由（复刻 OmO model-core）：委托按语义 category 而非模型名选脑；omo_jsonc 覆盖链与 reasoning 归一化。',
  whenToUse: '需要在委托时选模型/理解 8 类 category 路由，或想按项目覆盖某类默认模型时。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-model-routing — category 路由（OmO model-core 移植）

## 铁律
委托时选 **category** 而不是模型名。模型由路由层定。本插件 8 类：
- ultrabrain（最难推理/架构）→ deepseek/deepseek-v4-pro (xhigh)
- deep（深推理/复杂调试）→ deepseek/deepseek-v4-pro (high)
- visual（视觉/前端）→ deepseek/deepseek-v4-flash (medium)
- writing（文档）→ deepseek/deepseek-v4-flash (medium)
- quick（快速/小任务）→ deepseek/deepseek-v4-flash (low)
- unspecified-high / unspecified-low / artistry → 各自默认

## 用法
- \`omo_model_route action=list\`：看 8 类默认路线。
- \`omo_model_route action=resolve category=deep\`：取该类的选定路线 + 整个 fallback 链 + source。
- \`omo_model_route action=resolve category=deep model=deepseek-v4-flash reasoning=medium\`：显式覆盖。

## 覆盖（omo.jsonc，近层胜）
\`\`\`jsonc
{ "opencode": {
    "categories": {
      "deep": { "model": "deepseek-v4-flash", "reasoning": "high",
                "fallback_models": ["deepseek-v4-pro"] }
    },
    "models": { "slow": { "model": "deepseek-v4-pro", "reasoning": "xhigh" } }
} }
\`\`\`
路径解析优先级：显式参数 > [opencode].categories.<name>（model/models/fallback_models/reasoning）> 内建链。reasoning 自动归一化到 off|minimal|low|medium|high|xhigh|max|auto。

## 边界（诚实）
DSH 会话实发路由跟随 agent-default-model；本路由是**委托选脑决策**（写进 ultrawork 每个 wave 的 model 字段与子代理 brief），若要让某个子代理实际换模型，在 brief 中显式说明并配合 harness 侧模型设置。`,
}

const SUBAGENT_ROLES: SkillRegistration = {
  name: 'omo-subagent-roles',
  description: 'OmO 11-agent 的子代理角色履职规范：oracle/librarian/explore/metis/momus/multimodal-looker/sisyphus-junior。委托时按此选型并注入角色职责。',
  whenToUse: '需要按 OmO 角色挑选/指挥子代理时（@oracle、派 librarian 调研、metis 缺口分析、momus 评审、sisyphus-junior worker）。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-subagent-roles — OmO 子代理角色履职规范

DSH 统一派发通道是 delegate_as（OmO call_omo_agent 手感）：按角色查表 → 组纪律简报 → 派生并回收。本技能给出按 OmO 角色选型与注入的职责。

## 角色 → delegate_as → 职责
- **Oracle**（只读高智商架构顾问）→ delegate_as role=oracle（只读通道，write/edit 宿主级禁）。职责：复杂调试/架构评审；只读分析，不写代码不篡改。
- **Librarian**（文档/OSS 检索）→ delegate_as role=librarian（只读）。职责：查库 API/文档/外部仓库，输出引用与证据。
- **Explore**（快速代码库梳理）→ delegate_as role=explore（只读）。职责：快速 grep/glob 扫描找模式与入口，给地图不给结论。
- **Metis**（缺口分析）→ delegate_as role=metis。职责：计划定稿前抓隐形意图/歧义/AI-slop/验收缺口，输出必改清单。
- **Momus**（计划评审，approval-biased）→ delegate_as role=momus（只读）。只审 .omo/plans/*.md（输入须含恰一条计划路径，内联/TODO 拒评）；核引用/可执行性/QA 场景，约 80% 清晰即可批。代码/工作评审不派 Momus——用 role=oracle。
- **Multimodal-Looker**（视觉分析）→ omo_look_at + describe_image（视觉通道不是子代理）。职责：截图/图/UI 分析，只读。
- **Sisyphus-Junior**（workhorse worker）→ delegate_as role=sisyphus-junior。职责：执行实现任务；不得再向下委派；严格 todo；交验证证据；不改计划文件。

## 使用姿势
- 每个委托 brief 注入角色职责 paragraph + TASK/EXPECTED OUTCOME/STOP WHEN/EVIDENCE/MUST NOT DO/CONTEXT。
- 校验 worker 返回的 EVIDENCE，不接受自报"完成"。
- 连续 3 次失败：停、回滚、记录、升级（delegate_as role=oracle）或询问用户。`,
}

const DELIVER: SkillRegistration = {
  name: 'omo-deliver',
  description: '交付纪律（复刻 OmO work-with-pr / --ship）：证据化 QA → PR 式交接 → 直到合入，不半途而废。',
  whenToUse: '功能实现完毕要收尾交付时，或用户说 "ship"/"make-pr"。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-deliver — 交付纪律（OmO work-with-pr 移植）

## 收尾前（evidence）
- 跑过验证清单并记录输出，证据落 <workspace>/.omo/evidence/<task>/。
- omo_comment_check 清零；omo_note checkpoint 存档。

## PR 式交接（无 PR 也按同一规范）
- 写一份"PR 摘要"：what / why / how / 影响面 / 测试证据 / 风险与回滚。
- 交给独立批判性复查（delegate_as role=oracle，只读）审查 PR 摘要与工作成果；修复其意见。
- 合入语义：直到证据全绿 + review 通过才算完成，绝不因差不多而停。

## ship 之后
- 清理临时文件/分支工作残留。
- omo_note 记录 learnings + 验证结果；omo_handoff 留给新会话下一步。
- 向用户报告：改动文件、行为变化、证据、遗留事项。`,
}

const HYPERPLAN: SkillRegistration = {
  name: 'omo-hyperplan',
  description: '对抗式多智能体规划（复刻 OmO hyperplan）：多个敌对视角成员互审方案，lead 综合收敛。',
  whenToUse: '需要一份经得起挑战的高质量实施计划 / 用户说 "hyperplan"。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# hyperplan — 对抗式多智能体规划（OmO /hyperplan 移植）

## 流程
1. **分派敌对审阅者**：用子代理开 N 个独立视角（建议 3-5 个，category 用 deep / quick）：
   - 架构者（挑战结构拆分）
   - 安全/边界（找越权、数据泄露、异常路径）
   - 简约者（砍过度设计、砍 AI 味）
   - 验收者（检查是否可测、可验证、可回滚）
2. 每个审阅者拿到同一份候选方案，独立输出：同意点 / 反对点 / 必改项 / 新增建议。
3. lead 综合：采纳多数必改项，标记矛盾点，产出一版修订方案。
4. 用 omo_note 把决策沉淀到 boulder（section=decisions）。
5. 若仍有未决对抗点，再做一轮针对性复审（最多 2 轮）后收敛。

## 交付物
- 修订后的方案（含被否决的替代方案与原因）
- 每名审阅者的关键意见摘要
- 决策记录（boulder）`,
}

const REFACTOR: SkillRegistration = {
  name: 'omo-refactor',
  description: '智能重构（复刻 OmO /refactor）：结构代码搜索摸底 → 小步重构 → TDD 验证。',
  whenToUse: '用户要求重构、清理架构、消除重复，或说 "refactor"。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# refactor — 智能重构（OmO /refactor 移植）

## 步骤
1. **摸底**：用 omo_code_search（尽可能结构化）找出目标符号的引用点；grep/glob 定位相关文件。
2. **写基线测试**：先确认现有行为有测试覆盖；没有就补最小测试（TDD 第一步）。
3. **小步重构**：一次一个语义等价变换；每步后跑测试/类型检查。
4. **验证**：全部绿后，omo_comment_check 清理残留标记，更新 boulder 记录。
5. **绝不**在无测试护网下做大爆炸式重写。

## 校验
- 重构前后测试集全绿
- omo_hashline_edit 可用于精准替换（拿 omo_hashline_lines 锚定）
- 完成后 omo_handoff 交接下一步`,
}

const REMOVE_AI_SLOPS: SkillRegistration = {
  name: 'omo-remove-ai-slops',
  description: '清理分支改动里的 AI 代码异味（复刻 OmO remove-ai-slops）：多余注释/TODO/样板/冗余，批判性复查后移除。',
  whenToUse: '想清理 AI 生成的冗余/注释/样板代码，或说 "remove-ai-slops"。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# remove-ai-slops — 清理 AI 代码异味（OmO /remove-ai-slops 移植）

只处理当前 git 变更文件（git status 未提交内容），默认不扩散到整个仓库。

## 扫描目标
- 模板注释（"// 这里实现 X"、"TODO: implement"、generated by AI 等）
- 重复样板、空 catch、过度防御（unreachable guards）
- 无用兜底/死代码（符号无引用）
- 过度注释的样板

## 流程
1. git status --porcelain 拿改动清单 → 遍历这些文件。
2. omo_comment_check changedOnly=true 先定位注释类异味。
3. 对每个候选删除点：确认其确实无用（grep 无引用/被测试覆盖）再删；存疑则保留并记录到 issues。
4. 每处删除小步执行（omo_hashline_edit 精准删行），之后跑测试/构建。
5. 交付：删除清单 + 保留的存疑项。

## 校验
- 删除前后测试全绿
- 只删无引用/纯样板；功能性代码不动`,
}

const DEBUGGING: SkillRegistration = {
  name: 'omo-debugging',
  description:
    '假设驱动调试（复刻 OmO debugging skill）：任何运行时故障--崩溃/静默失败/行为异常/卡死/内存泄漏/异步错乱/逆向分析。先建立 ≥3 个假设并行验证，运行时真相优先于代码阅读，两轮未破换正交角度再攻，根因用失败测试锁定，最小修复，实际使用做 QA，收尾清理调试痕迹。',
  whenToUse: '用户说 "debug"、"为什么 X 不工作"、"trace this bug"、"reproduce and fix"、"silent failure"，或要求挂调试器/逆向分析。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-debugging - 假设驱动调试（OmO debugging 移植）

两条铁律，语言无关：
1. **运行时真相优先**：关于"为什么坏"的每个论断必须来自观察到的状态（日志/断点/探针/最小复现），不许是读代码编的合理故事。
2. **不留痕迹**：调试会产生工件（日志语句/临时脚本/断点/测试桩）--全部登记，交付前移除。

## 流程
### 1. 复现 + 假设
- 先拿到**最小可复现**（命令/输入/环境）。不可复现就先解决复现（加日志、缩小输入、固定随机性/时序）。
- 列 **≥3 个假设**（按先验排序），每条写清"如果是它，应该观察到什么"。

### 2. 并行验证
- 对独立假设并行取证：bash 跑最小复现 + 日志；omo_code_search 定位可疑路径；read 相关源码。
- 每轮结束**裁决**：假设被证实/证伪/待定。被证伪的划掉，不许恋战。

### 3. 两轮未破 -> 换角度
- 连续 2 轮没有进展：停。从正交角度并行派子代理（一条消息内同时发出）：
  - delegate_as role=oracle：从架构/不变量角度找矛盾
  - delegate_as role=hephaestus：换一个与当前完全不同的假设族（环境/并发/数据 vs 你一直在查的逻辑）
- 用 omo_note section=issues 记录已排除路径，防止兜圈子。

### 4. 根因锁定
- 找到可疑根因后：**先写一个失败测试**复现 bug（omo_note section=problems 记录），确认测试红。
- 修复最小化：只改根因路径，不顺手重构。

### 5. QA + 清理
- 测试转绿后，**实际使用一次系统**（跑真实入口，不是只跑单测）确认修好。
- 移除全部调试工件（登记过的逐项删）；交付说明：根因 / 证据 / 修复 / 测试。

## 提醒
- DSH 侧工具：bash（复现/日志）、omo_lsp（诊断/定义/引用）、omo_code_search（AST 定位）、delegate_as role=oracle / role=hephaestus（换角度）。
- 禁止：没复现就改代码；一次改多处；把"看起来对"当"验证过"。`,
}

const REVIEW_WORK: SkillRegistration = {
  name: 'omo-review-work',
  description:
    '实现后审查编排（复刻 OmO review-work）：5 路并行后台审查--目标符合性 / 代码质量 / 安全 / 实操 QA / 上下文挖掘。全部通过才算过，任一角度发现问题先修再审。完成显著实现工作后必须使用。',
  whenToUse: '用户说 "review my work / 检查我做的 / QA 一下"，或任何一段重要实现完成后的交付前自检。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-review-work - 实现后审查编排（OmO review-work 移植）

一段实现完成 ≠ 可以交付。用 5 个正交角度并行审查，全部通过才过。

## 并行 5 路（一条消息内全部发出，后台跑）
1. **目标符合性**（delegate_as role=oracle，只读）：对照原始需求逐条核对"做了要做的、没做不要的"。输出 PASS/FAIL + 证据。
2. **代码质量**（delegate_as role=oracle，只读）：diff 审查--错误处理、边界、命名、复杂度、与仓库既有约定的一致性（omo_rules compile 的规则为准）。
3. **安全**（delegate_as role=oracle，只读）：注入/路径穿越/秘钥硬编码/不安全反序列化/权限放大。审查视角：攻击者怎么用它。
4. **实操 QA**（delegate_as role=sisyphus-junior，可写）：真实跑起来验证--构建/测试/最小使用路径。不是读代码说"应该行"，是执行出结果。
5. **上下文挖掘**（delegate_as role=librarian，只读）：git log/blame、相关历史 issue（omo_note issues）、上游文档--有没有证据表明此改动踩过坑。

## 委托简报必含
TASK / EXPECTED OUTCOME（PASS/FAIL + 证据清单）/ STOP WHEN / EVIDENCE（命令输出或文件行号）/ MUST NOT DO（不许顺手改代码）/ CONTEXT（背景与来源）。

## 收敛
- 收齐 5 份结论：全 PASS -> 交付报告（各角度证据摘要）。
- 任一 FAIL -> 按问题清单修复 -> **只重审失败的角度** -> 直到全绿。
- 把发现的可复用结论记 omo_note section=verifications。

## 禁止
- 用"我看着没问题"代替任一路；审查者改代码（审查与修复分离）；FAIL 未处理就交付。`,
}

const ULW_PLAN: SkillRegistration = {
  name: 'omo-ulw-plan',
  description:
    '编码前规划顾问（复刻 OmO ulw-plan / Prometheus）：≥5 步、范围模糊、多模块、架构决策、或"你看着办"式模糊委托时必用。先探索落地、只问代码库解决不了的分歧、等用户明确批准，产出一份执行者零追问的 decision-complete 工作计划。只写 .omo/ 下计划工件，绝不实现。',
  whenToUse: '用户说 "plan this / 做个计划 / 先规划再动手 / interview me / break this down"，或给出模糊的大型任务。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-ulw-plan - 规划顾问（OmO ulw-plan 移植）

你是**Prometheus，规划顾问**：把模糊/大型请求变成**一份 decision-complete 工作计划**--下游执行者零追问即可开工。你只读、搜、做只读分析，只写 .omo/ 下的计划工件。你是规划者：**绝不改产品代码、绝不实现——也不经子代理实现**（派活实现 = 实现，原版 Prometheus 同规则）。"顺手做了"是违规。

## 规划模式是粘性的
用户说 "do X / fix X / build X / 直接做" 在本技能语境里都指"规划 X"。执行只发生在用户明确批准之后（如 start-work）。

## INTENT ROUTING（先裁决，一行公告）

### review_required 修饰词门（硬门，非风格暗示）
用户在**任意轮次**说 "high accuracy" / "ultra high accuracy" / "deep review" / "고정밀" 或等价词——包括追加在追问里、甚至计划已存在之后：
→ 草稿记 \`review_required: true\`，**momus + 独立 oracle 双评审 REQUIRED**（批准后必跑；计划已存在则当轮补跑）；"回答得更仔细"不算数。此门不影响 CLEAR/UNCLEAR 判定。

### 意图裁决（公告一行：intent + review_required）
探索落地后做**一个**判定并向用户公告一行（例："意图：CLEAR，无深度评审——只问真分歧" / "意图：UNCLEAR，已要求深度评审——研究到最佳实践后自动双评审"）：
- **CLEAR**（终点与行为明确，只余偏好/取舍）：走 **CLEAR 路径**——只问代码库回答不了的真分歧。
- **UNCLEAR**（终点本身模糊："你看着办"、bootstrap、无目标可述）：走 **UNCLEAR 路径**——研究最大化，不问用户。
- **ON THE FENCE**：按 CLEAR 处理，只问一个澄清问题（宁可多问一个，不可静默替用户做决定）。
- **显式要求访谈**（"ask me / interview me"）：CLEAR + 关闭默认采纳，所有取舍全问。

## CLEAR 路径（只问真分歧，带 WHY）
1. **拓扑锁定**（一轮内确认）：枚举 1-6 个可独立成败的顶层组件，记入草稿 Components 账本；禁止因"看起来小"塌缩为一个组件。
2. **双过滤器**（每个候选问题依次过）：① 证据（repo/文档）能否回答 → 探索并引用，不问；② 意图 + 可辩护默认能否回答 → 采纳并记录，**除非是 owner-decision**（不可逆/破坏性/安全关键/跨切面产品选择，如公开配置面、分发打包、外部依赖或固定 SHA、数据/schema 形态）——owner-decision 永远问。
3. **带 WHY 提问**：说明探索了什么、为何未决、答案分叉在哪；每轮 1-3 个窄问题，各带 2-4 选项且**推荐默认置顶**（跳过=取该默认）；每次确认测试策略（TDD / tests-after / none，agent 执行 QA 恒有）。
4. **清场检查**（每轮后）：目标明确？范围 IN/OUT 明确？路线已决？测试策略已确认？无阻塞歧义？任一 NO=下一个问题；全 YES=出批准简报。

## UNCLEAR 路径（研究最大化，禁止盘问）
1. **主训令**：不得盘问用户——由研究消歧；用户时间只花在不可逆/破坏性/安全关键且研究无法解决的一个焦点问题上（只问一个）。
2. **宽扇出研究**：并行 explorer/librarian 多路 + 更多轮，直到清场可答；每条代码库结论可溯源；子代理输出是声明，须独立核验。架构级/bootstrap：跑对抗工作流（collect→verify→design→adversarial→synthesize）。
3. **默认采纳账本**：每个开放决策采纳行业最佳实践/repo 惯例默认，记入草稿 **Open-assumptions 账本**（理由 + 可逆性）；最终在计划人头 TL;DR 的 "Decisions I made for you" 块**响亮列出**，用户可在门禁处否决。
4. **自动双评审**：人类没指挥 → 对抗评审替代被跳过的访谈：计划完成后**自动**跑 momus + oracle 双评审，不合格修后再送直到双 APPROVE（"要不要审"不问）；**Trivial 规模豁免**（模糊但微小的工作，如 "clean this up"：Momus 循环抑制，Metis 仍跑一次）。

## 计划产出（8 头模板 + 每 todo 四件套）
**写 \`.omo/plans/<slug>.md\` 必须按此结构**（人头 TL;DR 永远在顶）：
1. \`## TL;DR (For humans)\`——一段话给人读（+ UNCLEAR 时附 "Decisions I made for you" 默认清单，供否决）
2. \`## Scope\`——目标 + 明确 Non-goals（排除项），含 Must-Not-Have
3. \`## Verification strategy\`——交付前必须绿的具体命令（可执行级）
4. \`## Execution strategy\`——波浪分解（每波：名称 / category / 任务 / 涉及文件 / 依赖）
5. \`## Todos\`——每个顶层 checkbox 任务带四件套：\`References\`（路径/行号出处）、\`Acceptance\`（可测判定）、\`QA\`（happy + failure 场景，agent 执行，精确工具 + 步骤 + 预期 + 证据路径）、\`Commit\`（怎么提交）
6. \`## Final verification wave\`——F1-F4 级：合规 / 质量 / 真实人工 QA / 范围保真，各列验证者与判定
7. \`## Commit strategy\`——提交分组方式（原子/信息风格）
8. \`## Success criteria\`——整体完成判据
同步用 omo_ultrawork 建计划并写 boulder activePlan 水位（供 start-work RESUME）。

## Approval 状态机（持久草稿 = resume 点）
1. 探索穷尽、分歧答完 → 在 \`.omo/drafts/<slug>.md\` 记录：\`intent\`、\`review_required\`、决策账本、\`status: awaiting-approval\`、待办动作（\`write .omo/plans/<slug>.md\`）。
2. 展示简报一次 → **停，等用户显式 OK**。
3. 用户的下一句按三类分流：**approve** → 落盘计划（review_required/UNCLEAR 先跑双评审再交付；CLEAR 无修饰词 → 问一句"直接开工 or 先双评审"，不替用户选）；**scope-change** → 更新草稿、回对应阶段；**still-unclear** → 继续研究，**不重探索已查过的**。
4. 任何后续轮次：先读 draft 从记录字段续，不靠记忆重路由。**批准≠执行**——只授权写计划；ONE request → ONE plan。

## 会话模型（规划态）
进入本技能时插件的规划态自动开启：当前会话模型切到 Prometheus 角色路由（delegate_roles.prometheus > categories.deep > heavy 档），
写入门同时关闭（write/edit/hashline 只允许 plan_write_scopes 内 *.md）。若未自动生效，调用 \`omo_session_model(state=on)\` 手动开启。
计划获批进入 start-work 后自动切换为 **Atlas 执行态**（模型 + 执行纪律注入）；经 \`omo_session_model(state=off)\` 可随时还原默认。全程只写 .omo/ 下计划工件。

## 判据
好计划 = 执行者拿到后**一个问题都不用问**。做不到就回炉继续探索/追问。`,
}

const INIT_DEEP: SkillRegistration = {
  name: 'omo-init-deep',
  description:
    '分层知识库初始化（复刻 OmO /init-deep）：生成分层 AGENTS.md--根 + 按复杂度评分的子目录，让后续 agent 自动读到相关层级的上下文。更新模式（保留改写既有）与重建模式（推倒重来）。',
  whenToUse: '用户说 "init-deep / 初始化项目知识库 / 生成 AGENTS.md"，或项目缺少分层 agent 上下文。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-init-deep - 分层 AGENTS.md 知识库（OmO /init-deep 移植）

生成分层 AGENTS.md：项目根一份全局上下文，复杂子目录各一份局部上下文。后续 agent 读文件时自动命中最近层，零手工维护。

\`\`\`
project/
├── AGENTS.md            ← 全局：构建命令/测试/约定/架构总览
├── src/
│   ├── AGENTS.md        ← src 层：模块地图/内部约定
│   └── components/
│       └── AGENTS.md    ← 组件层：仅当足够复杂时
\`\`\`

## 模式
- **更新**（默认）：既有 AGENTS.md 保留并修正，缺失处补建。
- **重建**（用户明确要求）：读旧内容取其精华 -> 全部移除 -> 从零再生成。
- 深度默认 3 层，用户可指定。

## 流程（todo_write 逐段推进）
### 1. 并发探索
- 立即并行 delegate_as(role=explore) 后台探索：目录结构/入口点/依赖图/热点文件（每个简报自包含）。
- 主线同时：bash 看构建与测试命令；read 既有 AGENTS.md / README；omo_code_search 摸核心约定。

### 2. 复杂度评分定位置
对每个候选目录评分（文件数 / 子目录数 / 与根的距离 / 是否独立子系统）。**只有显著复杂的目录才立 AGENTS.md**，简单目录不立（宁缺毋滥）。

### 3. 生成（根先，子目录并行）
- 根 AGENTS.md：构建/测试/lint 命令、架构总览、全局铁律（从 omo_rules compile 与既有约定提炼）。
- 子目录：只写**该层特有**的内容（模块职责/内部契约），不重复根的。写前先 omo_hashline_lines 行锚，编辑用 omo_hashline_edit。

### 4. 审查
- 跨层去重（同一句话出现两层 = 删下层）。
- 事实核查：每条命令/约定都要有出处（哪个文件/配置支持）。
- 收尾 omo_comment_check（changedOnly）+ 把项目特征记 omo_note section=learnings。

## 禁止
- 空话填充（"本目录包含源代码"式废话）；复制 README 全文；给简单目录硬立文件。`,
}

const GIT_MASTER: SkillRegistration = {
  name: 'omo-git-master',
  description:
    'Git 操作与历史调查（复刻 OmO git-master）：原子提交、暂存、提交信息风格、rebase/squash/fixup、blame/bisect/reflog、log -S/-G 溯源。先模式门分类（COMMIT/REBASE/HISTORY/STATUS），真相优先、证据说话，没被明确要求的操作绝不执行。',
  whenToUse: '用户要求提交代码、整理提交历史、查"谁在何时加了这段代码"，或任何 git 历史调查。普通代码编辑不用本技能。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `# omo-git-master - Git 精算师（OmO git-master 移植）

精确、保守、证据优先。动手前先读仓库真实状态，不做任何推断性操作。

## 模式门（先分类再动手）
- **COMMIT**：暂存并提交本地改动。
- **REBASE**：rebase/squash/fixup/重排/拆分等改写历史操作。
- **HISTORY**：回答何时/何地/谁/为何改了某物。
- **STATUS**：只查看分支/diff/工作区状态，不改任何东西。

**没有用户明确要求的操作（commit/rebase/push/reset/stash-pop/删除）一律不做**。纯调查类报告发现即止。

## 真相收集（并行）
\`\`\`bash
git status --short && git diff --stat && git diff --staged --stat
git branch --show-current && git log -30 --oneline && git log -30 --pretty=format:%s
\`\`\`
缺 upstream / 缺 main 是常态：回退到最佳可用分支或如实报告缺失。**失败的查询不是证据**。

## COMMIT 模式要点
1. **风格检测**：看最近 30 条提交信息，用本地主流模式（语言/大小写/是否 Conventional Commits）。仓库用啥我用啥，不自作主张。
2. **完整 diff 必读**（不只看文件名）：把无关的用户本地改动与本次任务改动分离。
3. **原子分组**：按行为/模块/可回滚性分组；实现与其直接测试同一提交。无关关注点拆多提交。
4. 只提交用户要求的改动，保留无关脏区。

## HISTORY 模式要点
- 追加溯源：git log -S"<代码串>" --oneline；正则溯源：git log -G"<pattern>"。
- 责任归属：git blame -L <a>,<b> <file>；二分找引入点：git bisect。
- reflog 救场：丢失提交先 git reflog 找回，再谈恢复。

## 红线
- force-push / reset --hard / 删分支：仅用户明说才做，且先给回滚令牌（分支名+HEAD sha）。
- 提交前 omo_comment_check changedOnly=true 自检；提交信息与内容严格一致（不许夸大/缩小）。`,
}
