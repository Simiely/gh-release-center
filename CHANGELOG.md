# CHANGELOG.md

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
