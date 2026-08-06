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

### 问题：加载更多点击无反应 + 页面闪到顶部（v0.1.1 修复）

**TL;DR**：page 按 DOM 渲染行数算（被过滤/无资产的行不渲染），导致 page 回退重复拉已拉过的页；加载成功后 loadAll 全量重建导致滚动丢失。

- 问题：点「加载更多」→ 闪顶 → 划回来列表无变化
- 根因：① `card.querySelectorAll(".rel").length` 是**渲染行数**（无资产/平台过滤的行不渲染），小于缓存 release 数 → `page = floor(行数/perPage)+1` 偏小 → 请求已拉过的页 → 后端按 tag 合并去重 0 新增；② 加载成功后 `loadAll()` 清空重建 innerHTML → 滚动位置重置
- 解决：① 卡片加 `data-count=缓存 release 总数`，page 据此计算；无资产 release 也渲染版本行（行数恒 = 缓存数）；② 加载更多改为**单卡片增量重建**（`softwareMap` 内存快照 + `card.replaceWith`），滚动用 `window.scrollY` 兜底
- 预防：分页"页码"永远基于数据总数而非 DOM 观测；列表更新优先局部渲染，避免全量 innerHTML 重建

### 问题：GitHub 分页「加载更多」与本地缓存如何配合

**TL;DR**：per_page 用设置的增量数，page 从缓存已拉页数 +1 开始；响应 `Link` 头 `rel="next"` 判断是否还有更多。

- 问题：直接拉全部 Release 太多；无 Token 限速下频繁请求易 403
- 根因：Release 数量不定（几到几百）
- 解决：增量拉取——每页 `settings.perPage` 个，前端「加载更多」→ `?page=N` 拉下一页合并入缓存；总数从 Link 头解析；「刷新」清缓存重拉第一页
- 预防：缓存落地 data.json，重启不丢；403 时返回 code=rate_limit，UI 提示配 Token

### 问题：新增软件校验仓库存在（v0.1.1 修复）

**TL;DR**：POST 前先 fetchRepoInfo 校验，仓库不存在/网络错误直接拒绝，不再静默创建空条目。

- 问题：填不存在的仓库也"添加成功"，列表里出现永远拉不到数据的空卡片
- 根因：fetchRepoInfo 失败只影响默认名，不阻断 createSoftware
- 解决：`if (!info.ok) return 4xx/502 { code, message }`，前端 toast 展示"仓库校验失败: ..."
- 预防：新增类接口必须先验证外键存在性，失败即拒绝，不给用户留"半成功"状态

### 优化：POST 新增合并为一次 GitHub 请求（v0.1.2）

**TL;DR**：fetchRepoInfo 校验 + fetchReleases 拉取两次请求合并为一次——拉取成功本身就证明仓库存在。

- 问题：无 Token 时公共 API 限 60 次/h，每次新增占 2 个名额；且两请求间仓库可能变化（TOCTOU）
- 根因：校验与数据获取分离的设计冗余
- 解决：POST 直接 fetchReleases(page 1)，`!ok → 拒绝添加(透传 code/message)`，`ok → createSoftware + 写缓存`
- 预防：能用一个请求完成"校验+取数"的就不要分两个；合并后默认名退化为 `owner/repo`（用户可改）

### 优化：前端全量重建 → 局部刷新（v0.1.2）

**TL;DR**：刷新/删除/加载更多统一走 `replaceCard()` 局部重建或 `card.remove()`，仅设置保存/添加走 loadAll 全量（语义上应回顶部）。

- 问题：除加载更多外的操作仍 loadAll 全量重建 innerHTML，刷新/删除后滚动位置重置
- 根因：早期统一用 loadAll 兜底，未区分"全量刷新"与"局部变更"
- 解决：`replaceCard(card, s)` 抽取共用（记录 scrollY → replaceWith → 恢复）；删除局部 remove + 空态兜底
- 预防：列表 DOM 变更默认局部化，只有"筛选条件变化"这类影响全部卡片的操作才全量重建

## 开发记录

- 2026-08-06：项目初始化，四件套 + manifest + 骨架
- 2026-08-06（v0.1.1）：修复加载更多 page 计算 + 增量渲染 + 新增校验仓库存在；路由精确匹配重构；补路由层单测（22 例全绿）
- 2026-08-06（v0.1.2）：POST 新增合并为一次请求；尾部斜杠等价；刷新/删除局部化（replaceCard）；23 例全绿
- 2026-08-06（v0.1.3）：UI 重构——网格卡片 + 悬浮详情弹层（最新版主卡/LATEST 徽标/下载优先）+ 顶栏搜索/平台/分类筛选 + 批量添加；后端 check-updates API（NEW 角标数据源）；24 例全绿

### UI 重构记录（v0.1.3，原型驱动）

**设计定稿过程**：SVG 信息架构对比 → 三方案（列表/网格/表格）→ 融合「网格+展开」→ 改「悬浮弹层」（网格不被破坏）→ 视觉层级修正（下载为主角、GitHub 页面降弱）→「最新版主卡+历史折叠」（业界模式：下载页最新版首屏突出 + 历史版本收纳折叠）。

**实现要点**：
- 前端零依赖单文件保持，状态集中 `state` 对象（筛选/软件/map/hasNew/detailId）
- 平台过滤（Segmented）仅前端过滤，不再写回后端 settings（保持 settings 只存连接类配置）
- 资产下载用 `browser_download_url` 直链 `window.open`，公共仓库免登录；私有仓库降级走 GitHub 页
- 复制链接 `navigator.clipboard` + `execCommand` fallback（非 localhost 的 http 环境 clipboard API 不可用）
- check-updates 串行检查 perPage=1，避免大请求；对比缓存第一页 tag 判"有新版"（无缓存不算更新）
