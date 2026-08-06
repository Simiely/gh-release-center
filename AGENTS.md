# AGENTS.md · 项目规则

> 📌 **文档基线**：2026-08-06（commit `2ca093f`）v0.2.0 适配 tools-center v0.12.0 V2 规范
> **更新文档/代码后，请更新此行**（日期 + 新 commit hash），并在 CHANGELOG 追加版本

## 技术栈
- Node.js 22+（ESM，`.mjs`），**零第三方依赖**（只用 node:http / node:https / node:fs / node:path / node:test / node:crypto）
- 平台：tools-center v0.11.x（manifest V2，`runtime+entry`，`port` 8100-8199）
- 前端：单文件 `public/index.html`，零框架，深色风格对齐平台门户

## 关键坑（3~5 条，越具体越好）
- Node 原生 fetch 不走系统代理：GitHub 请求必须走 `lib/github.mjs` 的 `requestJson()`（内部实现 HTTPS CONNECT 隧道），不要直接用 fetch
- 平台反代注入 `__BASE__`：前端资源/API 路径必须用 `__BASE__ + "/api/.."`，不能写死 `/api/..`（独立运行时 `__BASE__=""`）
- 数据只写 `CAP_STORAGE_DIR`（store.mjs 单点封装），不要写代码目录（可能被更新覆盖）；独立运行 fallback `./.data/`
- 端口从 `process.argv[2]` 读，不写死
- 无 Token 时 GitHub 公共 API 限 60 次/h，多软件刷新易 403——UI 需提示配 Token

## 约定
- UI 标签用中文；注释用中文；文件名/变量用英文
- API 返回统一 `{ ok, ... }` 或 `{ ok:false, code, message }`，前端据此内联提示
- Release 资产平台识别按文件名关键字：win/exe/msi/setup → Windows；mac/dmg/pkg → macOS；linux/appimage/deb → Linux

## 常用命令
```bash
node server.mjs 8130          # 独立运行（开发调试）
node --test test/             # 单测（node:test）
node --check server.mjs       # 语法检查
# 平台内冒烟：平台跑在 8080，工具挂 /tool/gh-release-center/
```

## 详细规则（按需 @引用）
- 单项目文档规范见 knowledge-base：`单项目规范/README.md`（四件套 + 文档基线断点续传）
