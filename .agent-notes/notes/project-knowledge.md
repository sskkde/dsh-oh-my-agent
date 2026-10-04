# project-knowledge — 文档组织规范与祖先规则加载的取舍记录

日期：2026-10-03 ｜ 主题：omo-project-documentation 计划（T1-T5）的关键决策与否决方案
规范正文：[docs/project-knowledge.md](../../docs/project-knowledge.md) ｜ 加载契约：[docs/subsystems/rule-loading.md](../../docs/subsystems/rule-loading.md)

## 决策与被否决的替代方案

1. **四层职责 + 单权威正文**（AGENTS=行动规则 / docs=现状 / notes=因果 / .omo=按类别区分权威状态与派生产物）。批准 plans、人工 memory、Boulder 状态和验证证据不属于可整体丢弃的缓存；旧 memory 不自动重分类。compiled/index 才可由来源重建。
   否决：docs 与 AGENTS 合并成单一树——会话自动注入面随之膨胀，历史复盘无处安放，且"规则"与"现状"的更新节奏不同。
2. **子 AGENTS 采用祖先路径作用域**（只适用所在目录子树），不做全仓递归全局化。
   否决：把所有 AGENTS.md 提升为全局常设规则——深层目录规则泄漏到无关任务。
   否决：纯靠 globs 表达作用域——空 globs / alwaysApply 的既有语义会绕过目录边界。
3. **信任边界 = workspace 自身**：不上溯父目录；外部绝对路径与外指 symlink 不读。
   否决：向上搜索 monorepo 外层 AGENTS——越界读取不可控；确有需求时用显式引用，不做自动发现。
4. **预算 2500 字符沿用现有 hook 上限**，整条规则为粒度（不截半句冒充完整），省略必须显式（contextIncomplete + 来源清单）。
   否决：静默截断正文——等于冒充完整加载；否决：为此新增公开配置面——超出本计划范围。
5. **取消 5s TTL 路径编译缓存，保留会话级有界交付账本**（指纹含被预算省略的源）。
   理由：TTL 缓存会投旧块（规则改了 5 秒内仍按旧貌注入）；防刷屏由账本承担，新鲜度不该拿缓存换。
6. **自动渠道仅限**：成功 read / 成功 edit / session 常设守则 / brief 与 delegate_as 的 files 目标 / omo_rules path。
   否决：write、bash、任意工具后置注入——误报面大且计划明确排除；需要时显式查询。
7. **默认 `.agent-notes/`，旧路径不迁移**：已有 `.agents/notes/` 等经显式引用继续可用，不自动发现、不自动改写。
   否决：自动搬迁用户既有 notes——破坏性，超出插件职责。

## 条件与边界

- 语义冲突不自动裁决：简报与注入声明"局部要求不得放宽根级约束"；矛盾需报告并停止相关实施。
- 历史复盘（postmortems）与 notes 里的旧结论**不是现行规则**，不自动变成规则注入。
- 回归测试：`test/rules.test.mjs`、`test/projectContext.test.mjs`、`test/rulesHooks.test.mjs`（Node 内置 test/assert，os 临时目录 fixture）。
