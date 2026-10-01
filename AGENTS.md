# AGENTS.md — dsh-oh-my-agent（插件根）

`@dsh-external/dsh-oh-my-agent`：在 DSH（DeepSeek Harness / Cordis）上复刻 oh-my-openagent（OmO）能力集的插件。**目标 DSH 版本 0.1.7-rc.2**（`README.md:9`）。

## 双半体

| 半体 | 源 | 产物 | tsconfig | 模块格式 |
| --- | --- | --- | --- | --- |
| 宿主 | `src/*.ts`（不含 `client/`） | `lib/*.js` + `lib/types/host/**` | `tsconfig.json` | ES2023 / NodeNext |
| 客户端 | `src/client/index.ts` | `lib/client.js`（单文件 ModuleLoader bundle） | `tsconfig.client.json` | ES2020 / CommonJS |

宿主 tsconfig 显式排除 `src/client`（`tsconfig.json:19`），两个半体各自独立编译、独立 typecheck。

## 构建 / 校验 / 测试（命令都在本目录内跑）

| 目的 | 命令 | 实测（2026-09-30） |
| --- | --- | --- |
| 编译宿主 | `bash scripts/build.sh`（= `npm run build`） | exit 0 |
| 宿主类型检查 | `npx tsc -p tsconfig.json --noEmit` | exit 0，无诊断 |
| 客户端类型检查 | `npx tsc -p tsconfig.client.json --noEmit` | exit 0，无诊断 |
| 编译客户端 | `bash scripts/build-client.sh` | exit 0，`lib/client.js` 20518 bytes（2026-10-01） |
| 测试 | `node --test`（**不要传 `test/`**） | exit 0，7 tests 全通过（2026-10-01） |

- **本仓库不 `npm install`**：`scripts/build.sh:18-30` 从 `~/.dsh/profiles/node_modules` 或 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules` 探测一份 DSH 依赖树，`link_pkg`（`:41-55`）把 cordis / dsh-tools / dsh-llm / dsh-scope / dsh-session / schemastery 等 symlink 进本地 `node_modules`，再用系统 `tsc` 编译（`:79-81`）。所以 `node_modules` 全是 symlink，删了会被下次 build 重建。
- 客户端链路是"编译到临时目录再包装"：`tsc -p tsconfig.client.json` → `.build-client/` → `scripts/wrap-client.mjs` 包成 `window.__ModuleLoader__.load('@dsh-external/dsh-oh-my-agent', …)` 写入 `lib/client.js` → 清理临时目录（`scripts/build-client.sh:17-26`、`scripts/wrap-client.mjs:51-66`）。
- 测试直接 import **编译产物**（`test/delegationGuard.test.mjs:13-14` → `../lib/hooks.js`、`../lib/delegate.js`；`test/goalGuard.test.mjs:7-8` → `../lib/goalGuard.js`）→ **先 build 再 test**，否则测的是旧产物。
- 宿主类型检查现状 **0 诊断**（上层 `../README.md` 的「构建与落地链路」已同步该结论）；**不要把新错误当既有错误放过**。

## 装配（DSH 怎么找到这个包）

- `package.json:42-51`：`dsh.bundle.patch: ./cordis.patch.yml`；`dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]` + `platform: "web"`。
- `cordis.patch.yml:1-7`：向 web 插件 roster `insert` `id: dsh-oh-my-agent` / `name: @dsh-external/dsh-oh-my-agent`。
- 两种装法：`dev_inject_plugin`（dsh-super-injector 运行时注入，免重启）或 `dsh plugin --profile web add <path>`。
- **本目录就是被 DSH 加载的那份**（2026-10-01 起 profile `link:` 直指这里，部署副本层已取消）。改完 build → `dev_reload_package` 即可，链路见上层 `../AGENTS.md`；**构建即上线**，未意图上线的改动别编译。

## 接口面（改动这些 = 改对外契约）

- **22 个 `omo_*` 工具**，全部在 `src/index.ts` 的 `buildTools()` 内定义（`:278` 起，逐项行号见 `src/AGENTS.md`），过滤（`:2015-2023`）后统一 `ctx.tools.register`（`:2025-2028`）。过滤规则：`omo.jsonc` 的 `disabled_tools` + `hashline_edit` / `monitor` 开关（`:2009-2023`）。
- **18 个技能**：定义在 `src/skills.ts`（`SkillRegistration` 对象数组），`skillRegistrations()` 汇总（`:183-185`），宿主循环注册（`src/index.ts:2030-2033`）。
- **7 条 HTTP 路由** `/dsh-oh-my-agent/api/{status,goalguard,scan,boulder,monitors,note,modelroutes}`，`webServer.register` 且 `kind: 'exact'`（`src/index.ts:2058-2184`）；客户端卡片靠它们取数。
- **客户端 UI 挂两处 slot**：`settings.plugins.tab`（OmO 控制台卡片）+ `conversation.input.left`（composer 会话模式下拉，2026-10-01 新增；slot 名与 list/single 语义均版本敏感，见 `src/client/AGENTS.md`）。
- **1 条 slash 命令 `/omo-mode off|plan|exec`**（嵌套 `inject(['commands'])` 注册，`src/index.ts` apply 内）：写通道，等价 `omo_session_model`；投影 `omo-session-mode`（`src/sessionModel.ts` `sessionModeProjectionUnit`）承载读通道。
- **消息 kind `'oh-my-agent'`**（`src/messageSource.ts:21`）：只做类型层 `MessageSourceMap` 增强，运行时无需注册；但该值**会持久化进会话日志，不能随包改名**。
- **11 个 agent 角色档案**：`src/agents.ts:40-199`，每角色显式 `category`（sisyphus/prometheus→deep、atlas/oracle/metis→ultrabrain、hephaestus→unspecified-high、librarian/explore/sisyphus-junior→quick、momus→deep、multimodal-looker→visual）。

### 文档同步（2026-09-30 已对齐代码）

工具数 22（`README.md:50`）、技能数 18（`README.md:55`）与代码一致，宿主 tsc 0 诊断。**改接口面要三处一起更新**：代码（`src/index.ts` / `src/skills.ts`）+ 本文件 + `README.md`；运行时真相以 `omo_status` 报的已注册清单为准。

最近一次被文档漏掉的三项：`omo_session_model`（`src/index.ts:1360`）、`omo-cancel-ultrawork` / `omo-sisyphus`（`src/skills.ts:187`、`:202`）。

## 本仓库源码铁律

- **工具返回值不得含显式 `undefined`**：harness 的 lossless-JSON 校验会拒收（曾导致 `omo_note` 已写盘却报失败）。`tool()` 包装对所有 `omo_*` 统一 `stripUndefined`（`src/index.ts:250-264`，实现 `src/util.ts:134-149`）；手写返回对象要条件挂键（例 `src/index.ts:1546-1551`、`src/boulder.ts:144`）。
- **一切注册走 `ctx.effect`**：`regOnce`（`src/index.ts:1996-2002`）把工具/技能/事件/提示词段绑到 effect 生命周期，卸载即净。新增注册点必须沿用，否则热重载残留。
- **`inject` 里的服务可能缺席**：`inject = ['tools','skills','webServer','systemPrompt']`（`src/index.ts:70-73`），但 `systemPrompt` 注册前必须 guard（`:2566-2586`），宿主没有 dsh-system-prompt 时也要能加载。
- **Config 两份必须同步**：`interface Config` 与 `const Config = z.object({...})` 在 `src/index.ts:75-101` 逐字段对应；新增字段两处一起改。
- 具名导出（未见默认导出）；camelCase 函数 / PascalCase 类型 / UPPER_SNAKE 常量；注释中英混用，无单一语言约束。
- 别把未知工具名传给 `tools.restrict()`——它会响亮抛错（上层 `../README.md` 的「hooks 与守卫」）。

## 版本适配判断

第三方插件能否跑某 DSH 版本：先看 `dsh.engines.dsh`，再解析 peer 范围（`^0.1.7-rc.1` 接受 `0.1.7-rc.2`，不含 `0.2.0-rc.*`）；peer 里出现已移除的 `dsh-client-runtime` / `dsh-client-store` 是强失配信号。**区间覆盖 ≠ 实测通过**（上层 `../README.md` 的「版本适配记录」）。

## 深入

- `src/AGENTS.md` — 宿主模块地图、`index.ts` 导航、注册范式、踩坑。
- `src/client/AGENTS.md` — 客户端半体契约与包装步骤。
- `README.md` — 能力矩阵（OmO 功能 → 本插件实现）与 goal-guard 设计说明。
