# gh-release-center · 软件下载中心

> 采集指定 GitHub 仓库的 Release 下载链接，统一入口访问下载——不用到处找。
> 形态：**tools-center 平台的一个 app 型工具**（manifest.json 声明式接入，平台托管进程）。

## 这是什么

你维护了一堆 GitHub 仓库（工具、插件、脚本），每次要下载最新版都得挨个打开仓库页面找 Release。这个工具把「软件 → 下载链接」集中管理：

- **网格卡片一屏浏览**：分类色图标 + 名称 + 简介 + 版本徽标 + 更新时间 + ★ Star 数 + NEW 更新角标
- **悬浮详情弹层**：点卡片弹出，最新版主卡（LATEST 徽标 + 大号下载按钮），历史版本折叠为次级区，**点资产文件直接下载**（GitHub 直链）
- **筛选三件套**：搜索（名称/仓库/分类/简介）+ 分类 Tabs + 平台 Segmented（Win/Mac/Linux）
- **排序 + 级联**：按更新日期 / Star / 名称，升降序切换；主排序相同时自动按「更新时间 → 名称」级联
- **简介双来源**：自动获取 GitHub 仓库描述，自定义备注优先（清空恢复自动）
- **更新感知**：一键「全部刷新」检查全部软件新版本（NEW 角标）+ 顺带刷新 Star 与简介
- **批量添加**：粘贴多行仓库 URL 一次导入；清单数据本地缓存，离线可看
- **WebDAV 云同步**：登录 WebDAV（地址/账号/密码）后一键上传/下载清单——本地与云端两个目录桥接，换机/重装后「从云端下载」即恢复全部软件清单与缓存

## 安装（接入 tools-center）

前提：本机已运行 [tools-center](https://github.com/Simiely/tools-center) 平台（默认 `http://127.0.0.1:8080`）。

**方式 A：zip 上传（推荐）**

```bash
# 在项目根目录打包（不含 .git）
zip -r gh-release-center.zip server.mjs manifest.json lib public README.md
```

平台首页 →「+ 添加工具」→「托管进程」→ 上传 zip → 保存后自动托管。

**方式 B：Git 导入**

```bash
curl -X POST http://127.0.0.1:8080/api/tools/import \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com/Simiely/gh-release-center.git"}'
```

**方式 C：直接放目录**

```bash
cp -r gh-release-center <tools-center>/tools/
# 重启平台或 POST /api/reload
```

## 快速开始

1. 接入后打开 `http://127.0.0.1:8080/tool/gh-release-center/`
2. 右上角「设置」：可填 GitHub Token（可选，提高速率 60→5000 次/h 并支持私有仓库）、代理地址（如 `http://127.0.0.1:7890`）、「显示更早」增量数
3. 「+ 添加软件」：填名称 + 仓库链接（如 `https://github.com/Simiely/tools-center`）→ 校验仓库存在并自动拉取最新 Release
4. 点卡片 → 弹层里点资产文件**直接下载**；「显示更早」逐步拉取历史版本
5. 顶栏搜索 / 分类 / 平台筛选，统计条旁切换排序与升降序；「全部刷新」检查更新

## WebDAV 云同步

> 换机器 / 重装 / 换部署环境时，软件清单不想重新录入？登录 WebDAV 后「上传」备份，「下载」恢复，一步到位。

**配置与使用**（v0.3.x+）：
1. 打开工具 → ⚙️ 设置 → 拉到「WebDAV 云同步」区
2. 填 WebDAV **地址**（如坚果云 `https://dav.jianguoyun.com/dav/` / 自建 Nextcloud）、**用户名**、**密码** →「保存配置」→「测试」（验证登录）
3. 「上传到云端」：把本地完整数据（软件清单 + Release 缓存 + Star + 简介 + 设置）备份到 WebDAV
4. 换机器部署后：「从云端下载」→ 本地自动备份旧数据后覆盖恢复（下载前有确认）

**云端路径**：`{WebDAV 基地址}/workbuddy/github下载/data.json`（目录自动创建，支持中文路径）

**接口**：`/api/webdav/config`（GET/POST，密码脱敏：只回 has 不回明文；留空保存 = 保留原密码）/ `test` / `upload` / `download` / `clear`

> ⚠️ 注意：备份文件含 WebDAV 密码明文（为「恢复后零配置」设计）。请确保 WebDAV 服务为私人私有，勿上传到公开位置。

## 独立运行（开发调试）

```bash
node server.mjs 8130
# 打开 http://127.0.0.1:8130
```

脱离平台时数据落在 `./.data/`，`__BASE__` 为空，功能完整可用。

## 文档

- [开发文档 DEVELOPMENT.md](DEVELOPMENT.md) — 架构说明与关键问题记录
- [变更日志 CHANGELOG.md](CHANGELOG.md) — 版本记录
- [AI 项目规则 AGENTS.md](AGENTS.md) — 技术栈 / 关键坑 / 约定
