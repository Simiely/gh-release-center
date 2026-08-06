# CHANGELOG.md

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
