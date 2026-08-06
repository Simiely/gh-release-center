# CHANGELOG.md

## v0.2.0 (2026-08-06)

### 适配 tools-center v0.12.0 V2 新规范
- **V2 manifest 声明制**：`runtime: "node"` + `capabilities: ["storage"]` + `entry/port/health` 显式声明（v0.1.x 已内置，本版正式确认并对照平台校验规则验证通过）
- **SDK 语义对齐**：存储边界 = CAP_STORAGE_DIR（`capStorageDir()` 同语义），独立运行降级 `cwd/.data`——与平台 lib/sdk.js 规范一致
- **平台 v0.12.0 实测**：工具在最新平台下 running + health ok；capabilities 注册表（browser/storage/network）校验通过；数据读写正常
- 功能状态：v0.1.9 全量功能（网格/弹层/筛选/排序/Star/简介双来源/磨砂玻璃）

## v0.1.9 (2026-08-06)

### 卡片简介双来源（自动获取 + 自定义优先）
- **自动简介**：采集时写入 GitHub 仓库 description（check-updates / refresh-stars 顺带获取）；store 新增 desc 字段，GET /api/software 响应带 desc
- **自定义优先**：编辑弹层「备注」留空时显示自动简介，填写自定义内容则优先显示自定义（intro() = note || desc）；清空备注即恢复自动
- 搜索范围扩展到简介（名称/仓库/分类/简介）
- 测试扩展：refresh-stars 用例验证 desc 一并采集

## v0.1.8 (2026-08-06)

### 排序控件优化
- **排序选择器移入统计条行**：与「N 个软件 · 更新状态」同行，右对齐（顶栏 bar 少一个元素，更清爽）
- **新增升序/降序切换**：排序旁 ↑/↓ 按钮，主排序方向可翻转（date/stars 默认降序，name 默认升序；次级级联条件固定方向）

## v0.1.7 (2026-08-06)

### 卡片排序（名称 / 更新日期 / Star + 级联）
- **顶栏排序选择器**：按更新日期（默认）/ 按 Star / 按名称
- **级联排序**：主排序相同时按更新时间 → 名称兜底（name 主排序时名称 → 更新时间 → Star）
- **Star 采集**：POST /api/refresh-stars（独立刷新）+ check-updates 顺带刷新（点「全部刷新」一次拿全量）；fetchRepoInfo 增加 stargazers_count；GET /api/software 响应带 stars
- **卡片 Star 徽标**：时间行右侧显示 ★ N（≥1000 显示 1.2k 格式），无数据不占位
- **修复平台工具写入 EPERM**：沙箱内启动的 tools-center 平台 ACL 受限传导给工具子进程（写 data.json 被拒），沙箱外重启平台恢复正常

## v0.1.6 (2026-08-06)

### 卡片简介 + 删除仓库内设计规范
- **卡片显示简介**：首页卡片名称下方显示软件备注（限 2 行截断），详情弹层同步显示完整简介；编辑弹层原有「备注」字段即可自定义编辑（点 ✎ / 弹层内编辑）
- 移除仓库内 DESIGN.md（设计规范仅在桌面保留）

## v0.1.5 (2026-08-06)

### 磨砂玻璃 UI 重构（解决页面拥挤）
- **背景光斑**：body::before 三个 radial-gradient 光斑（粉 #ff9292 / 青 #92ffff / 紫 #a78bfa），玻璃层有可磨的层次
- **玻璃化三件套**：顶栏（rgba .55 + blur 16px + 白描边）、卡片（rgba .045 + blur 14px + inset 高光 + hover 上浮粉描边）、弹层（rgba .82 + blur 20px + 遮罩 blur 4px）；@supports 降级纯半透明
- **卡片信息瘦身**：6 层 → 4 项（tile + 名称 + 版本徽标 + 更新时间）；仓库地址行移入弹层头部并做成可点击链接；网格 minmax 205→225px、间距 10→18px

## v0.1.4 (2026-08-06)

### 配色改版（#ff9292 主色系）
- **主色**：#ff9292 替换原 #ff6b9d，配套主色阶 5 档（#ff9292 主 / #ff7a7a hover / #e67878 active / #cc7575 边框 / #995858 深边框）
- **对比度修正**：#ff9292 底上的文字改用深色 #2d1414（9.78:1 AAA，替代不可读的白字 2.15:1）——主按钮/平台 Segmented 选中态/NEW 角标全部套用
- **辅助色**：互补青 #92ffff（链接/信息）、蜜桃 #ffc892（警告/标签）、粉紫 #ff92c8、蓝紫 #b0a0ff
- **语义色**：成功/LATEST #6dd58c、危险 #ff6b6b（原 #f87171）
- 下载按钮/latest 主卡/分类 Tab 选中态统一换主色系；版本徽标 rgba 同步

## v0.1.3 (2026-08-06)

### UI 重构（按高保真原型终稿）
- **网格卡片布局**：16 个软件一屏浏览，分类色图标块 + 名称 + 仓库 + 版本徽标 + 更新时间 + NEW 角标 + hover 提示；auto-fill 自适应
- **悬浮详情弹层**：点击卡片弹出居中弹层（Esc/遮罩/✕ 关闭），网格纹丝不动
- **最新版主卡**：最新版本独占粉色高亮主卡（LATEST 徽标 + 大号下载按钮），历史版本折叠为灰色次级区 + 「显示更早」进度——下载主操作视觉最重
- **资产直接下载**：点资产文件即触发下载（GitHub 直链），复制链接带 clipboard+fallback
- **顶栏升级**：搜索框 + 平台 Segmented（从设置提升）+ 分类 Tabs（动态生成）+ 统计条
- **批量添加**：多行仓库 URL 一次导入，逐条校验，重复自动跳过

### 功能
- **POST /api/check-updates**：串行检查全部软件最新 tag 对比缓存，返回有新版的 id 列表 → NEW 角标 + 统计条「N 个有新版本」数据源

### 测试
- 新增 check-updates 用例（有新版返回 id / 无更新不返回），共 24 例全绿

## v0.1.2 (2026-08-06)

### 优化
- **POST 新增合并为一次 GitHub 请求**:去掉 fetchRepoInfo 前置校验,直接 fetchReleases 第一页——拉取失败(404/网络/限速)即拒绝添加,成功即创建+写缓存。省 1 次请求 + 1 个限速名额
- **`/api/software/`(尾部斜杠)与 `/api/software` 等价**,不再 404
- **刷新(↻)改为局部重建该卡片**:不再 loadAll 全量重建,滚动位置保留
- **删除改为局部移除卡片**:列表不闪动,删空自动显示空态
- **新增 `replaceCard()` 辅助函数**:加载更多/刷新共用局部重建逻辑,消除剩余闪顶

### 测试
- server.test.mjs:POST 拒绝用例改为 fetchReleases 失败即拒;新增尾部斜杠用例;移除不再使用的 fetchRepoInfo fake。共 23 例全绿

## v0.1.1 (2026-08-06)

### 修复
- **修复「加载更多」无效**:page 计算改基于缓存 release 总数(卡片 data-count),不再依赖 DOM 渲染行数——无资产/被过滤的 release 不再导致 page 回退重复拉取
- **无资产 release 也显示版本行**(标"无下载资产"/"无匹配平台的资产"),版本列表不再消失
- **加载更多改为增量渲染**:只重建当前卡片,不再 loadAll 全量重建,滚动位置保留,不再闪到顶部
- **新增软件校验仓库存在**:仓库不存在(404)/网络错误时拒绝添加并提示,不再静默创建空条目
- **前端清理**:删 PLATFORM_NAME 死代码、修正 releaseCount 契约漂移、api() 加 20s 超时、openEdit 改用内存快照免重复请求

### 重构
- 路由改 pathname 精确分段匹配(去掉 url.includes 字符串匹配),apiSoftwareId 按子路径拆分为 releases/refresh/PUT/DELETE 独立处理
- server.mjs 导出 createServer(deps 可注入 fake GitHub 客户端)+ main 检测,具备可测试性
- 新增 test/server.test.mjs 路由层单测 9 例(新增拒绝/增量合并去重/404/405/编辑删除),共 22 例全绿

## v0.1.0 (2026-08-06)

- 初始化项目：四件套文档 + manifest + 可运行骨架
- 后端：lib/github.mjs（代理 CONNECT / Token / 分页 / 错误归一化）+ lib/store.mjs + API 路由
- 前端：public/index.html 单文件 UI（软件 CRUD + Release 卡片 + 加载更多 + 设置弹层 + 平台过滤）
- 测试：node --test 单测（仓库 URL 解析 / 平台识别 / 代理解析 / store 读写）
- 接入：tools-center 平台托管验证通过（反代 /tool/gh-release-center/、CAP_STORAGE_DIR 落盘、健康检查）
