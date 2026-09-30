# AGENTS.md — src/client（客户端半体）

单文件 UI 半体：`index.ts`（402 行）注册「OmO 控制台」卡片；`react.d.ts` 只为离线 typecheck 提供 React 类型，**运行时 React 由 DSH ModuleLoader 提供**（`react.d.ts:1-20`），因此这里用裸 `createElement`（无 JSX）、不引第三方 UI 依赖。

## 挂载契约

`inject = ['slots']`（`index.ts:24`）；`apply(ctx)` 把注册包在 `ctx.effect` 里，disposer 原样透传（`index.ts:388-402`）：

```ts
ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
  name: 'settings.plugins.tab', id: 'dsh-oh-my-agent', order: 120,
  label: () => 'OmO 控制台', inject: () => ({}),
}, OmOConsoleCard))
```

- slot 名 `settings.plugins.tab` 是 **DSH 0.1.7 起的名字**；旧的 `settings.plugin.item` 已移除——升版时 slot 名是第一个要核对的东西。
- `id` 必须与宿主插件 id 一致（`dsh-oh-my-agent`），`order` 决定 tab 排序。

## 与宿主通信

卡片只走宿主 HTTP API（宿主侧注册点 `../index.ts:2058-2184`），不 import 宿主模块：

| 客户端用法 | 端点 |
| --- | --- |
| 轮询状态 / 规则扫描 / 路由视图 | `GET /dsh-oh-my-agent/api/{status,scan,modelroutes}` |
| 追加 note / 保存模型路由 | `POST /dsh-oh-my-agent/api/{note,modelroutes}` |

请求封装在 `index.ts:60-82`，卡片主体（状态、规则、记忆、监控、模型路由编辑、追加 note）在 `:86-320`。契约变动要**两侧同时改**：`OmOStatus` 等接口（`:26-58`）是宿主 `apiStatus` 的镜像。

## 构建（与宿主完全独立）

```sh
bash scripts/build-client.sh        # tsc -p tsconfig.client.json → .build-client → wrap-client.mjs → lib/client.js
npx tsc -p tsconfig.client.json --noEmit   # 单独 typecheck
```

- `tsconfig.client.json`：ES2020 / CommonJS / 含 DOM 类型 / `outDir: .build-client` / `rootDir: src/client`，只纳入 `index.ts` 与 `react.d.ts`（`:3-18`）。
- `scripts/wrap-client.mjs:51-66` 把编译结果包成 `window.__ModuleLoader__.load('@dsh-external/dsh-oh-my-agent', …)` 写入 `lib/client.js`；相对 `require` 会内联（`:25-49`）。当前产物无本地模块内联（16984 bytes）。
- **改了客户端必须跑 `build-client.sh`**：`scripts/build.sh` 只管宿主，两个产物分别同步（`lib/*.js` 与 `lib/client.js`）到部署副本后再重载。
- 交付前同样过一遍 `npx tsc -p tsconfig.client.json --noEmit`（实测 exit 0）。
