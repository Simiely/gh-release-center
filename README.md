# gh-release-center · 软件下载中心

> 采集指定 GitHub 仓库的 Release 下载链接，统一入口访问下载——不用到处找。
> 形态：**tools-center 平台的一个 app 型工具**（manifest.json 声明式接入，平台托管进程）。

## 这是什么

你维护了一堆 GitHub 仓库（工具、插件、脚本），每次要下载最新版都得挨个打开仓库页面找 Release。这个工具把「软件 → 下载链接」集中管理：

- 网页上维护软件清单（仓库链接、分类、备注）
- 一键拉取各仓库的 Release 下载资产，增量加载（默认最新 3 个，可「加载更多」）
- 按平台过滤（Windows / macOS / Linux / 全部），点击直达下载
- 已拉取的 Release 本地缓存，离线可看，不重复请求

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
2. 右上角「设置」：可填 GitHub Token（可选，提高速率 60→5000 次/h 并支持私有仓库）、代理地址（如 `http://127.0.0.1:7890`）、每次增量数、平台过滤
3. 「+ 添加软件」：填名称 + 仓库链接（如 `https://github.com/Simiely/tools-center`）→ 自动拉取最新 Release
4. 点「加载更多」逐步拉取更早版本；点资产文件名直接跳转 GitHub 下载

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
