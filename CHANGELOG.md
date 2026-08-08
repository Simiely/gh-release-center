# CHANGELOG.md

## v0.5.9 (2026-08-08)

### 全部刷新失败时显示具体原因(便于排查网络/限速)
- 🟡 **toast 显示首个失败的具体原因**:`checkUpdates` 失败时不再只列仓库名,追加 `首个失败: <code>: <message>`(如 `network: 网络错误...`/`rate_limit: 请求受限(403)...`),立刻区分是网络、限速还是仓库问题

## v0.5.8 (2026-08-08)

### 采集方案升级(GraphQL 批量) + 搜索框禁用浏览器自动填充
- 🔴 **懒补采升级为 GraphQL 批量**(搜索 GitHub 最佳实践):有 token 时一次 GraphQL 请求查最多 50 个缺失仓库的 `pushedAt/stargazerCount/description`(aliases 写法,官方/社区推荐,大幅省额度——无 token 时退化 REST 并行逐个);失败删除节流标记,允许前端轮询重试
- 🟡 **前端待采集自动轮询**:页面存在"推送日期待采集"时自动定时重拉(4s/8s/12s/16s,最多 4 次),补齐后自动刷新显示,无需手动刷新;GitHub 不可达时安静放弃
- 🟡 **禁用浏览器自动填充**:搜索框 `#q` 加 `autocomplete="off"`(此前浏览器自动填入历史词 → 排序时被过滤显示"空白");全部输入框统一加 `autocomplete`(密码框 `new-password` 防保存/自动填)
- 🟢 测试:新增 GraphQL 批量懒补采用例;修复"设置读写"测试残留 token 污染(懒补采分支选择依赖 token)→ **53 例全绿**

## v0.5.7 (2026-08-08)

### 修复 WebDAV 同步崩溃(沙箱 safe-delete 拦截删除文件 → 同步报错)
- 🔴 **根因**:`store.save()` 原子写失败后执行 `fs.rmSync(data.json)`——沙箱的"安全删除"机制拦截该操作并把文件重定向到 `C:\Temp\codebuddy-safe-delete-bulk\`,重定向过程 EPERM 失败,抛 `SAFE_DELETE_BULK_GUARD_ERROR`,导致一键同步接口直接报错(本地写盘问题殃及云同步)
- 🔴 **修复**:`store.save()` 改为尽力而为、永不抛错——降级链:直接写 → tmp+rename → **copyFile 覆盖(不删除目标)** → 最后才删目标+rename(失败静默);任何失败都不让接口崩溃(数据已在内存,下次 save 再落盘)
- 🟢 **验证**:mock WebDAV 下 sync 全链路成功;用户真实配置(ddnsto + billpotter)只读 test 连接成功(检测到 3 个备份);52 例测试全绿
- 排查附注:修复期间沙箱测试覆盖过用户 WebDAV 配置,已从本地 .bak 备份恢复(url/账号/密码)

## v0.5.6 (2026-08-08)

### 推送日期保证每个项目都有(懒补采 + dirty 修复 + 待采集提示)
- 🔴 **懒补采**:`GET /api/software` 对推送日期缺失的软件后台自动补齐(`fetchRepoInfo`,10 分钟节流,失败静默不阻塞响应)——GitHub 仓库必然有 `pushed_at`,不显示 = 采集缺失(旧数据/云端同步数据/添加时请求失败);GitHub 可达时打开页面即自动补齐,无需手动刷新
- 🔴 **dirty bug 修复**:`checkUpdates` 更新 pushedAt/stars/desc 但响应无 etag 时 `dirty` 不置位 → 更新不落盘;现只要更新即落盘
- 🟡 **前端语义统一**:卡片日期只显示推送日期(去掉 release 发布兜底,与 v0.5.3 推送日期语义一致);无推送日期时显示「推送日期待采集」(弱化提示)而非空白;排序同样只用推送日期
- 测试:新增懒补采用例(缺失→GET→自动补齐),**52 例全绿**

## v0.5.5 (2026-08-08)

### 可访问性修复:表单控件关联 label(Lighthouse "No label associated with a form field")
- 12 个表单控件此前全部无 label 关联(11 个 `<label>` 缺 `for` + 搜索框无 label)——现 11 个 label 补 `for`(fName/fRepo/fCat/fNote/fBatch/fToken/fProxy/fPerPage/fWdUrl/fWdUser/fWdPass),搜索框 `#q` 加 `aria-label="搜索软件"`
- 「WebDAV 云同步」区块标题由 `<label>` 改为 `<div>`(非表单字段,语义正确)
- 验证:DOM 扫描 12/12 全部关联,Edge 渲染正常、无 JS 错误

## v0.5.4 (2026-08-08)

### 全面操作排查:渲染容错加固 + 字段兜底(针对"点排序空白"报告)
- 🔴 **渲染单卡片容错**:`render()` 对每条软件 try/catch——某条数据异常只跳过该卡,不再让整页 grid 空白(用户报告"点击推送日期就空白"的最可能防御点)
- 🟡 **releases 数组兜底**:`GET /api/software` 对 `cache.releases` 非数组(旧数据/手改)返回 [] 而非透传;前端 `platOf`/`openDetail` 同步加 Array.isArray 兜底(此前非数组会致 flatMap 崩溃、整页挂)
- 🟢 **apiSettings 补 defaultUrl**:前端"地址留空用默认"的回填判断与提示此前拿到 undefined,现服务端返回
- **排查过程**:CDP 驱动全部交互(排序×3/升降序/搜索/分类Tab/平台筛选/卡片详情/复制/刷新/编辑/删除/显示更早/添加校验/批量/设置/全部刷新),覆盖完整新格式、旧格式(缺 etag/updatedAt/sizeText)、无 cache、空名称、无效日期、无资产、releases 非数组、assets null 等脏数据——全部无 JS 异常;51 例测试全绿

## v0.5.3 (2026-08-08)

### 卡片日期 = 仓库推送日期(pushedAt,最后一次推到 GitHub),修正 v0.5.2 误解
- 🔴 **语义修正**:用户澄清"推送日期"= 仓库最后一次推送到 GitHub 的时间(`pushed_at`),不是 release 发布时间——卡片/排序恢复 pushedAt 优先:有 pushedAt 显示「推送 xxx」,未采集才退化为最新 release 发布时间「发布 xxx」,都无则不显示;排序按钮改回「按推送日期」
- 🟡 **添加时即采集推送日期**:POST /api/software 此前只拉 releases、不采集仓库信息 → 新添加软件 pushedAt=null 显示成添加时间(用户看到"有些显示添加日期"的根因);现添加时顺带 fetchRepoInfo 采集 pushedAt/stars/desc(失败静默不阻塞添加)
- 🟢 存量数据:点一次「全部刷新」即补齐推送日期(checkUpdates 已顺带采集)
- 测试:POST 添加采集断言 + refresh-stars 初始值断言随行为更新,**51 例全绿**;Edge 渲染验证「推送/发布」标签、排序(推送优先、兜底发布、无日期最后)

## v0.5.2 (2026-08-08)

### 卡片日期统一为「发布日期」+ 排序改为独立按钮
- 🔴 **日期统一**:卡片时间一律取最新 release 发布时间(publishedAt),不再退化到仓库推送/添加时间;无 release 的软件不显示时间(避免"添加日期"误导);排序同样只用发布日期,无 release 排最后
- 🔴 **排序方向 bug 修复**:`cmpSort` 的日期/Star 分支方向一直写反(`(db-da)` → `(da-db)`),默认降序实际把旧版本排前面——本次一并修正,并验证 date desc/asc、stars desc 全方向正确
- 🟡 **排序控件改独立按钮**:右上角下拉 `<select>` → 「按发布日期 / 按 Star / 按名称」三个按钮直接点击切换,选中态高亮(与分类 Tab 同款粉色);升降序切换按钮保留
- 验证:Edge headless 渲染确认卡片按日期降序(t1→t2→t3,无 release 最后)、无 JS 错误;51 例测试全绿

## v0.5.1 (2026-08-08)

### 修复「全部刷新」500 EPERM(Windows 写盘) + 端到端验证
- 🔴 **store.save 原子写加固**:Windows 上 rename 覆盖已有文件可能 EPERM(直接写被锁时回退路径)→ 先删目标再 rename;失败时确保清理 tmp 残留
- 🟡 **checkUpdates/refreshStars 仅在有数据变更时写盘**(dirty 标记):全仓库检查失败(GitHub 不通/限速)时不再无谓写盘,避免触发写锁
- 🟡 **写盘失败降级**:checkUpdates/refreshStars 的 save 失败不再让整个接口 500,结果照常返回
- 🟢 **端到端验证**(本地 mock WebDAV + Basic Auth):测试保存(表单值)/配置保存/首次同步只传/合并同步(本地独有保留)/远端保留 1 份/双端一致合并 全链路通过;check-updates 在 GitHub 不可达时返回 failed 列表而非 500

## v0.5.0 (2026-08-08)

### WebDAV 交互重构(范式对齐 edge-multi-account-cookie)
- 🔴 **「测试保存」合一**:原「保存配置/测试/上传/下载/清空」5 按钮 → 「测试保存/一键同步/清除配置」——测试连接成功即自动保存配置,失败不保存;输入框回车 = 触发测试保存
- 🔴 **一键同步(sync)= 先拉后传双向收敛**:拉远端最新备份 → 按 owner+repo smart 合并进本地(**只增不删**,同名取数据更"新鲜"的一份,本地独有保留) → 上传合并后全量;远端无备份(首次同步)自动只传首份;响应带拉取/新增/更新/上传明细
- 🟡 **远端多版本备份 + 保留策略**:备份文件名 `ghrc-backup-YYYYMMDDHHMMSS.json`(UTC 定宽时间戳),上传后只保留最近 1 份(自动 DELETE 旧文件);下载自动选"最新且可用"备份,损坏文件跳过,兼容旧版 data.json
- 🟡 **协议层补齐**:PROPFIND(Depth:0 探测目录/Depth:1 列目录解析 href)+ DELETE;401/403 统一归一为"认证失败,请检查用户名/密码";URL 格式校验(需 http/https)
- 🟡 **test 用表单值**:修复此前「测试」按钮实际只测已保存配置、表单编辑无效的交互 bug(留空回退已保存凭据)
- 🟢 **安全保留**:pull 覆盖前本地 .bak 兜底 + 结构校验(software 数组)拒绝损坏数据;密码仍留空即保留
- 测试:+6 协议用例 +5 路由用例,**51 例全绿**(修复:mock server 复用 listen 挂起、after 未 import 导致 runner 挂起)

## v0.4.1 (2026-08-08)

### 修复「最新版 / 更新日期」取错(GitHub 列表不保证顺序)
- 🔴 **根因**:`GET /releases` 列表不保证按发布时间排序(受 tag commit 日期 / SemVer / make_latest 影响,官方文档明确建议不要依赖返回顺序);此前取 `releases[0]` 当最新版,遇到乱序会取到旧版本,日期跟着错
- 🔴 **修复**:新增 `sortReleasesByPublish`(按 published_at 降序),`fetchReleases` 返回前统一排序——POST 添加 / 单条刷新 / 加载更多 / 更新检测全部拿到正确的"最新在前"
- 🟡 **检测窗口放大**:checkUpdates 从 per_page=1 提到 per_page=5,再按发布时间取最新(per_page=1 遇乱序会漏掉真正最新发布);服务层对上游结果二次排序兜底
- 🟢 **字段语义确认**(搜索官方文档):GitHub UI 的 "X hours ago" 基于 `published_at`(发布时间);`created_at` 是草稿创建时间;`updated_at` 是最后编辑/资产更新;`pushed_at` 是仓库 push,与版本无关——卡片日期 = 最新 release 的 published_at,无 release 才退化 pushedAt/createdAt
- 测试新增 3 例(sortReleasesByPublish 乱序/不可变 + checkUpdates 乱序兜底),**41 例全绿**

## v0.4.0 (2026-08-08)

### 更新检测算法优化:条件请求 + 写回 + 排序修复
- 🔴 **「全部刷新」发现新版即写回缓存**:checkUpdates 检测到新 tag(或同 tag 但 updatedAt 变化)后,把最新 release 直接写入 `cache.releases` 头部——NEW 角标与卡片数据一步到位,不再"只报不写";无缓存的首个 release 也会判新(原来漏报)
- 🟡 **ETag 条件请求(304 不扣额度)**:fetchReleases/fetchRepoInfo 支持 If-None-Match;checkUpdates 与 refreshStars 携带上次 etag,未变化返回 304 免费判定,并保存新 etag;store 新增 etag/repoEtag 字段
- 🟡 **额度熔断**:按响应头 x-ratelimit-remaining 跟踪剩余配额,耗尽后停止检查并将剩余仓库如实上报(`code: "rate_limit"`);check-updates 响应新增 `remaining`
- 🟡 **合并排序修复**:GET /software/:id/releases 合并去重后按 publishedAt 降序——修复新版本被追加到队尾、LATEST 主卡仍是旧版本的 bug
- 🟢 **日期语义对齐**:卡片/排序时间优先取最新 release 发布时间(有版本时以版本为准,无 release 才退化到仓库推送时间);卡片标签区分「发布/推送/添加」
- 🟢 **updatedAt 采集**:normalizeRelease 增加 updatedAt(检测同 tag 资产重传/重新发布)
- 测试新增 6 例(写回/304/熔断/repoEtag/合并排序/updatedAt),**38 例全绿**
- 注:存量数据首次刷新时因无 etag 走全量请求,之后自动转为条件请求

## v0.3.7 (2026-08-07)

### 卡片日期统一为「推送日期」
- **问题**：卡片日期 = 最新 release 发布时间，9/16 无 Release 的文档/指南类仓库退化为创建日期（添加时间），显示不准
- **修复**：统一采集并显示**仓库最后推送时间（pushed_at）**——fetchRepoInfo 携带 pushedAt，checkUpdates/refreshStars 顺带采集；卡片与排序均以推送日期为准（未采集时依次退化为 release 发布时间 → 创建时间）
- **命名**：排序选项「按更新日期」→「按推送日期」；卡片日期加「推送」前缀标签
- 测试新增 pushedAt 采集用例；**32 例全绿**
- 注：现有数据需限速恢复/配 Token 后点「全部刷新」采集推送日期

## v0.3.6 (2026-08-06)

### 服务层重构（主线/支线/模块化优化落地）
- **新增 lib/service.mjs 服务层**：checkUpdates（全量更新检查）/ refreshStars（全量 star 采集）从 server.mjs 路由内联循环抽离为独立模块——路由只做 HTTP 编排，业务组合进服务层
- **参数组装收敛**：`service.ghOpts(settings)` 统一 token/proxy，POST/releases/refresh 3 处 fetchReleases 调用去重复
- **测试**：新增 test/service.test.mjs（fake github 注入，不碰网络）4 例——有新版/无新版/失败三态 + star 顺带刷新 + 失败收集；**31 例全绿**
- 真机验证：check-updates 经 service 层正常返回（遇 GitHub 限速时 failed 列表如实反馈 16 项——v0.3.5 的失败反馈功能在真实场景生效）

## v0.3.5 (2026-08-06)

### 第二轮全盘审核修复（8 项）
- 🔴 **「加载更多」分页修复**：页数按已加载页记录（page 字段），不再硬编码 3——perPage 可配置后不跳页、不漏版本
- 🔴 **check-updates 失败反馈**：失败仓库返回 failed 列表，前端提示「N 个检查失败」而非误报「全部是最新版本」
- 🟡 **GitHub Token 清除入口**：`__CLEAR__` 特殊值 + 设置弹窗「清除」按钮（此前留空保留导致无法移除）
- 🟡 **加载更多后数据一致性**：同步更新 software 引用（弹层/网格/排序同源）
- 🟢 **readBody 字面 null → 空对象**（不再 500）；copyText 单次调用；load 清理原子写遗留 tmp
- 🟢 **save 直接写优先 + 原子写兜底**（兼容沙箱受限环境）
- 平台进程环境修复：发现平台被沙箱内进程接管（工具写 EPERM），重启为沙箱外进程后读写恢复正常
- 实测：数据文件被意外覆盖后，原子写临时文件成功救回全部 16 个软件数据（验证原子写价值）

## v0.3.4 (2026-08-06)

### 全盘审核安全加固（代码审查 12 项）
- 🔴 **PUT /api/settings 不再回传 settings 全量**（此前空 body PUT 会回显 webdavPass/githubToken 明文）
- 🔴 **静态文件路径边界校验**（PUBLIC_DIR + path.sep，防 /../publicX/ 前缀绕过）+ decodeURIComponent 异常兜底
- 🟡 **GET /api/settings githubToken 同步脱敏**（只回 githubTokenHas；Token 留空保存 = 保留原值，防误清）
- 🟡 **WebDAV 下载结构校验**（云端必须是合法 JSON 且含 software 数组，损坏数据拒绝覆盖）
- 🟡 **check-updates 前端超时放宽 90s**（16 仓库串行请求不再被 25s 切断）
- 🟢 **store 原子写**（temp + rename，进程被杀不截断 data.json）
- 🟢 **下载链接协议校验**（仅 http/https，防恶意数据注入 javascript:）
- 🟢 **manifest.json 补齐 version/dataFiles**（与 tool.json 双通道一致）；pack-platform.py 排除打包产物
- 测试扩展：settings 脱敏/token 保留/PUT 无明文断言；27 例全绿

## v0.3.3 (2026-08-06)

### WebDAV 默认地址（与积分仪表盘同款 192 内网）
- **默认 WebDAV 地址 `http://192.168.2.1:6086/`**（积分工具 SYNC_DEFAULT_URL 同款）：设置里不填地址时，测试/上传/下载自动使用默认地址
- config 接口返回 `defaultUrl`；前端地址框 placeholder 与状态提示同步展示默认地址
- 已配置地址（如 ddnsto）优先，默认地址仅兜底

## v0.3.2 (2026-08-06)

### 按 tools-center v0.12.1 打包标准重新发布
- **标准打包脚本** `pack-platform.py`（项目根，Python zipfile）：强制正斜杠 `/` 条目分隔符（APPNOTE 规范，禁反斜杠——Linux Info-ZIP unzip 遇反斜杠会 exit=1 误报解压失败）+ 打包后**自检条目名**（无 `\`/绝对路径/`..`/目录条目）
- tool.json 版本同步 0.3.2；产物：`gh-release-center-platform-v0.3.2.zip`（英文名，Release 资产）+ `平台版-v0.3.2.zip`（桌面存档）
- 说明：v0.3.0/0.3.1 zip 已实测正斜杠合规；本版将打包流程固化为脚本，后续每次发布执行 `python pack-platform.py . <版本> <输出目录>` 即可

## v0.3.1 (2026-08-06)

### WebDAV 云端路径调整
- **远端路径改为 `workbuddy/github下载/`**：上传/下载/测试均指向 `{WebDAV基地址}/workbuddy/github下载/data.json`（原为工具 id 目录）
- **中文路径 URL 编码**：webdav.mjs 对路径段 encodeURIComponent（支持中文目录名），实测 MKCOL/PUT/GET 均正确到达编码路径
- **测试连接建真实同步目录**：testConnection 改为在建同步目录（原空目录不发请求的 bug）
- 新增 webdav 集成测试（本地 mock 服务器验证中文编码 + 上传/下载全链路）；**27 例全绿**
- 真实环境验证：已配置 ddnsto WebDAV，上传成功

## v0.3.0 (2026-08-06)

### WebDAV 云同步（参考积分仪表盘 wb-credits 设计）
- **需要登录**：WebDAV 地址/用户名/密码配置（设置弹窗新增 WebDAV 区），密码仅存本机且 API 脱敏（只回 has，不回明文；留空保存 = 保留原密码）
- **上传/下载数据**：本地清单（data.json）↔ 云端 `/gh-release-center/data.json` 双向同步；下载前自动备份本地（`.bak-<时间戳>`），覆盖前 UI 确认
- **两个目录桥接**：本地 CAP_STORAGE_DIR + WebDAV 远端目录——换机/重装后登录 WebDAV「下载」即可恢复全部软件清单与缓存
- **API**：`/api/webdav/config`（GET/POST）/ `test` / `upload` / `download` / `clear`
- **lib/webdav.mjs**：零依赖 WebDAV 客户端（MKCOL/PUT/GET + Basic 认证，参考平台实现，工具独立）
- 测试 26 例全绿（新增 config 保存/密码脱敏/清空用例）

## v0.2.0 (2026-08-06)

### 适配 tools-center v0.12.0 V2 新规范
- **V2 manifest 声明制**：`runtime: "node"` + `capabilities: ["storage"]` + `entry/port/health` 显式声明（v0.1.x 已内置，本版正式确认并对照平台校验规则验证通过）
- **新增 tool.json（发布包标准）**：平台 zip 导入优先读取 tool.json——含 `version: "0.2.0"`（覆盖升级对比/降级保护）+ `dataFiles: []`（数据在 CAP_STORAGE_DIR，工具目录无数据文件，升级不清数据）
- **平台版发布包**：`gh-release-center-platform-v0.2.0.zip`（tool.json + manifest.json + 源码 + 四件套文档），已上传 Release v0.2.0 资产 + 存桌面（中文名副本）
- 平台实测：zip 上传 201 → 工具创建 → 16 个软件数据保留 ✓
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
