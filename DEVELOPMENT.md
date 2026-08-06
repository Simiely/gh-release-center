# DEVELOPMENT.md · 开发文档

## 项目概览

gh-release-center 是 tools-center 平台的一个 app 型工具：网页维护「软件 → GitHub 仓库」清单，GitHub API 分页采集 Release 下载链接，按平台过滤、增量加载、直达下载。Node 22+ 零依赖，双模式运行（平台托管 / 独立运行）。

## 架构说明

```
server.mjs (入口薄层:静态 + API 路由)
  ├── lib/github.mjs   GitHub API 客户端:代理 CONNECT / Bearer Token / 分页 / 错误归一化
  ├── lib/store.mjs    data.json 持久化(CAP_STORAGE_DIR),含版本迁移
  └── public/index.html  单文件 UI(零框架,__BASE__ 子路径)
```

**数据流**：前端 `fetch(__BASE__ + "/api/..")` → server.mjs 路由 → lib/github.mjs 调 `api.github.com/repos/{owner}/{repo}/releases`（支持代理+Token）→ 结果合并进 store 缓存 → 返回前端。

**目录约定**：仓库根 = 工具根（manifest.json 在根目录，平台 Git 导入时 `manifest.id` 决定目录名）。

## 关键问题与方案

### 问题：Node fetch 不走系统代理，GitHub API 直连不稳（大陆网络）

**TL;DR**：零依赖下用 `node:https` 手写 HTTPS 代理（CONNECT 隧道），封装成 `requestJson()` 单一出口。

- 问题：平台部署在本机/NAS，大陆网络直连 api.github.com 常超时；原生 fetch 不读系统代理
- 根因：fetch 底层（undici）默认无代理支持，且零依赖约束下不能引 ProxyAgent
- 解决：`lib/github.mjs` 实现 `createTunnelConn(proxy, target)`——向代理发 `CONNECT target:443`，成功后把裸 socket 交给 `https.request({ createConnection })` 走 TLS；无代理时直连
- 预防：所有 GitHub 请求一律走 `requestJson()`，禁止散用 fetch

### 问题：平台反代挂在 `/tool/<id>/` 子路径，前端路径写死会 404

**TL;DR**：前端一律 `window.__BASE__ + "/api/.."`；独立运行时平台不注入 `__BASE__`，前端兜底 `window.__BASE__ || ""`。

- 问题：工具在平台里被反代到 `/tool/gh-release-center/`，写死 `/api/software` 会打到平台自身 API
- 根因：tools-center proxy.js 只向 HTML 注入 `<script>window.__BASE__="/tool/<id>";</script>`
- 解决：页面加载先 `const BASE = window.__BASE__ || "";`，所有 fetch/资源引用用 `BASE + ...`
- 预防：新增前端请求时统一走 `api(path, opts)` 封装

### 问题：GitHub 分页「加载更多」与本地缓存如何配合

**TL;DR**：per_page 用设置的增量数，page 从缓存已拉页数 +1 开始；响应 `Link` 头 `rel="next"` 判断是否还有更多。

- 问题：直接拉全部 Release 太多；无 Token 限速下频繁请求易 403
- 根因：Release 数量不定（几到几百）
- 解决：增量拉取——每页 `settings.perPage` 个，前端「加载更多」→ `?page=N` 拉下一页合并入缓存；总数从 Link 头解析；「刷新」清缓存重拉第一页
- 预防：缓存落地 data.json，重启不丢；403 时返回 code=rate_limit，UI 提示配 Token

## 开发记录

- 2026-08-06：项目初始化，四件套 + manifest + 骨架
