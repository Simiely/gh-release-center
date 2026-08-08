// server.mjs — gh-release-center 入口
// 独立运行: node server.mjs [port]
// 平台托管: tools-center 以 node server.mjs <port> 启动,端口来自 manifest.port
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as store from "./lib/store.mjs";
import { parseRepoUrl, fetchReleases, fetchRepoInfo, fetchReposBatch } from "./lib/github.mjs";
import * as webdav from "./lib/webdav.mjs";
import { normalizeUrl } from "./lib/webdav.mjs";
import * as service from "./lib/service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const port = parseInt(process.argv[2] || process.env.PORT || "8130", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---- 小工具 ----
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw new Error("body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {}; // 字面 null/标量 → 空对象
  } catch {
    throw new Error("invalid JSON body");
  }
}

// ---- 静态文件 ----
function serveStatic(req, res, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return json(res, 400, { ok: false, message: "bad url encoding" }); }
  if (p === "/" || p === "") p = "/index.html";
  const full = path.normalize(path.join(PUBLIC_DIR, p));
  // 边界校验:归一化后必须在 PUBLIC_DIR 内(防 /../publicX/ 前缀绕过)
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { ok: false, message: "forbidden" });
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return json(res, 404, { ok: false, message: "not found" });
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(full).pipe(res);
}

// ---- API ----
// 懒补采节流:每个仓库 10 分钟内只补采一次(服务重启后重置,可接受)
const pushedFetchAt = new Map();
const BACKFILL_TTL = 10 * 60 * 1000;

/** 后台补齐缺失的推送日期(pushedAt)/Star/简介——GitHub 仓库必然有 pushed_at,不显示=采集缺失。
 *  有 token → GraphQL 一次批量查全部;无 token → REST 并行逐个。失败删除节流标记,允许前端轮询重试。
 *  fire-and-forget:不阻塞响应;成功才写盘 */
function lazyBackfillPushed(github, data) {
  const settings = store.getSettings();
  const now = Date.now();
  const missing = data.software.filter(
    (s) => !s.pushedAt && now - (pushedFetchAt.get(s.owner + "/" + s.repo) || 0) > BACKFILL_TTL
  );
  if (!missing.length) return;
  missing.forEach((s) => pushedFetchAt.set(s.owner + "/" + s.repo, now));
  const keyOf = (s) => s.owner + "/" + s.repo;
  (async () => {
    let changed = false;
    const apply = (s, info) => {
      if (!info || !info.pushedAt) return;
      s.pushedAt = info.pushedAt;
      s.stars = info.stars ?? s.stars;
      s.desc = info.desc ?? s.desc;
      changed = true;
    };
    if (settings.githubToken) {
      // GraphQL 批量:一次请求全部缺失仓库
      const r = await github.fetchReposBatch({ repos: missing.map((s) => ({ owner: s.owner, repo: s.repo })), token: settings.githubToken, proxy: settings.proxy });
      if (r.ok) {
        missing.forEach((s) => apply(s, r.repos[keyOf(s)]));
      } else {
        missing.forEach((s) => pushedFetchAt.delete(keyOf(s))); // 失败:允许重试
      }
    } else {
      // 无 token:REST 并行逐个
      const results = await Promise.allSettled(
        missing.map((s) => github.fetchRepoInfo({ owner: s.owner, repo: s.repo, ...service.ghOpts(settings) }))
      );
      results.forEach((res, i) => {
        if (res.status === "fulfilled" && res.value.ok && !res.value.notModified) {
          apply(missing[i], res.value.info);
        } else {
          pushedFetchAt.delete(keyOf(missing[i])); // 失败:允许重试
        }
      });
    }
    if (changed) { try { store.save(); } catch {} }
  })();
}

async function apiSoftware(req, res, github) {
  // GET /api/software — 返回含缓存 releases(本地已拉取的部分),前端免网络直接渲染
  if (req.method === "GET") {
    const data = store.load();
    // 懒补采:推送日期缺失的软件后台自动补齐(GitHub 可达时,无需手动刷新)
    lazyBackfillPushed(github, data);
    const list = data.software.map((s) => ({
      id: s.id, name: s.name, owner: s.owner, repo: s.repo,
      category: s.category, note: s.note, desc: s.desc ?? null, createdAt: s.createdAt,
      pushedAt: s.pushedAt ?? null,
      stars: s.stars ?? null,
      total: s.cache?.total ?? null,
      hasMore: !!(s.cache && s.cache.hasMore),
      releases: Array.isArray(s.cache?.releases) ? s.cache.releases : [],
    }));
    return json(res, 200, { ok: true, software: list });
  }
  // POST /api/software
  if (req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, message: e.message }); }
    const parsed = parseRepoUrl(body.repoUrl || body.repo || "");
    if (!parsed) return json(res, 400, { ok: false, code: "bad_repo", message: "无法解析仓库链接,支持 owner/repo 或 github.com 链接" });
    const settings = store.getSettings();
    // 一次请求双重用途:拉第一页失败(404/网络/限速)即拒绝添加(证明仓库不存在或不可达),成功即创建+写缓存
    const first = await github.fetchReleases({ ...parsed, page: 1, perPage: settings.perPage, ...service.ghOpts(settings) });
    if (!first.ok) return json(res, first.status || 502, { ok: false, code: first.code, message: `无法添加: ${first.message}` });
    const r = store.createSoftware({ name: body.name || `${parsed.owner}/${parsed.repo}`, ...parsed, category: body.category, note: body.note });
    if (!r.ok) return json(res, 409, r);
    r.item.cache = { total: first.hasMore ? null : first.releases.length, hasMore: first.hasMore, releases: first.releases };
    // 顺带采集推送时间(pushedAt)/Star/简介——新添加的软件卡片立刻显示"推送日期"而非添加时间(失败静默,不阻塞添加)
    const info = await github.fetchRepoInfo({ ...parsed, ...service.ghOpts(settings) });
    if (info.ok && !info.notModified) {
      r.item.pushedAt = info.info.pushedAt ?? null;
      r.item.stars = info.info.stars ?? null;
      r.item.desc = info.info.desc ?? r.item.desc;
      if (info.meta?.etag) r.item.repoEtag = info.meta.etag;
    }
    store.save();
    return json(res, 201, { ok: true, item: r.item, fetch: { hasMore: first.hasMore } });
  }
  return json(res, 405, { ok: false, message: "method not allowed" });
}

/** 单软件操作:按 sub 路径段区分( [] → PUT/DELETE 编辑删除; ["releases"] → 增量拉取; ["refresh"] → 清缓存重拉 ) */
async function apiSoftwareItem(req, res, id, sub, qs, github) {
  const action = sub[0] || "";
  if (!action) {
    // PUT /api/software/:id — 编辑
    if (req.method === "PUT") {
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, message: e.message }); }
      const r = store.updateSoftware(id, body);
      if (!r.ok) return json(res, 404, r);
      return json(res, 200, r);
    }
    // DELETE /api/software/:id
    if (req.method === "DELETE") {
      const r = store.deleteSoftware(id);
      if (!r.ok) return json(res, 404, r);
      return json(res, 200, r);
    }
    return json(res, 405, { ok: false, message: "method not allowed" });
  }
  if (action === "releases" && req.method === "GET") {
    const item = store.find(id);
    if (!item) return json(res, 404, { ok: false, code: "notfound", message: "软件不存在" });
    const page = Math.max(1, parseInt(qs.get("page") || "1", 10) || 1);
    const settings = store.getSettings();
    const r = await github.fetchReleases({ owner: item.owner, repo: item.repo, page, perPage: settings.perPage, ...service.ghOpts(settings) });
    if (!r.ok) return json(res, r.status || 502, r);
    // 合并去重(按 tag),再按发布时间降序——防止新版本被追加到队尾导致 LATEST 主卡仍是旧版
    const merged = new Map(item.cache.releases.map((x) => [x.tag, x]));
    for (const rel of r.releases) merged.set(rel.tag, rel);
    const releases = [...merged.values()].sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
    item.cache.releases = releases;
    item.cache.hasMore = r.hasMore;
    item.cache.total = r.hasMore ? null : releases.length;
    store.save();
    return json(res, 200, { ok: true, releases, hasMore: r.hasMore, total: item.cache.total });
  }
  if (action === "refresh" && req.method === "POST") {
    const item = store.find(id);
    if (!item) return json(res, 404, { ok: false, code: "notfound", message: "软件不存在" });
    const settings = store.getSettings();
    const r = await github.fetchReleases({ owner: item.owner, repo: item.repo, page: 1, perPage: settings.perPage, ...service.ghOpts(settings) });
    if (!r.ok) return json(res, r.status || 502, r);
    item.cache = { total: r.hasMore ? null : r.releases.length, hasMore: r.hasMore, releases: r.releases };
    store.save();
    return json(res, 200, { ok: true, releases: r.releases, hasMore: r.hasMore, total: item.cache.total });
  }
  if (action === "releases" || action === "refresh") return json(res, 405, { ok: false, message: "method not allowed" });
  return json(res, 404, { ok: false, code: "bad_route", message: "未知子路径" });
}

async function apiSettings(req, res) {
  if (req.method === "GET") {
    const s = { ...store.getSettings() };
    // 凭证脱敏:只返回是否已设置,不返回明文
    s.webdavHas = !!s.webdavPass;
    delete s.webdavPass;
    s.githubTokenHas = !!s.githubToken;
    delete s.githubToken;
    s.defaultUrl = webdav.DEFAULT_WEBDAV_URL; // 前端"地址留空用默认"提示与回填判断
    return json(res, 200, { ok: true, settings: s });
  }
  if (req.method === "PUT") {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, message: e.message }); }
    // Token:留空 = 保留原值;显式 "__CLEAR__" = 清除
    if (body.githubToken !== undefined) {
      const t = String(body.githubToken).trim();
      if (t === "__CLEAR__") body.githubToken = "";
      else if (t !== "") body.githubToken = t;
      else delete body.githubToken;
    }
    store.updateSettings(body);
    // 不回传 settings 全量(避免凭证明文回显)
    return json(res, 200, { ok: true, message: "设置已保存" });
  }
  return json(res, 405, { ok: false, message: "method not allowed" });
}

/** WebDAV 云同步:config(脱敏)/test/push/pull/sync/clear
 *  交互范式参考 edge-multi-account-cookie:
 *   - test 用表单值(留空回退已保存),前端"测试成功即自动保存"
 *   - 远端多版本时间戳备份 + 保留最近 1 份;pull 自动选最新可用备份
 *   - sync = 先拉最新备份 smart 合并进本地(只增不删)→ 上传合并后全量;首次同步只传
 *   - pull 覆盖前本地 .bak 兜底;结构校验拒绝损坏数据 */
const WEBDAV_DIR = "workbuddy/github下载";
const DATA_FILE = () => path.join(store.storageDir(), "data.json");

/** 组装有效配置:表单值优先,留空回退已保存(密码留空=保留已存密码) */
function wdCfg(s, body = {}) {
  const url = normalizeUrl(body.url ?? s.webdavUrl);
  const user = String(body.user ?? s.webdavUser ?? "").trim();
  const pass = body.pass !== undefined && String(body.pass) !== "" ? String(body.pass) : (s.webdavPass || "");
  return { url, user, pass };
}

/** 已保存配置(用于 push/pull/sync,凭据来自设置) */
function wdSaved(s) {
  return { url: normalizeUrl(s.webdavUrl), user: String(s.webdavUser || "").trim(), pass: s.webdavPass || "" };
}

function requireWd(cfg) {
  if (!cfg.user || !cfg.pass) throw new Error("请先配置 WebDAV（含用户名与密码）");
  return cfg;
}

/** 数据"新鲜度":最新 release 发布时间 → 仓库推送时间 → 本地创建时间,谁大谁新 */
function freshnessOf(s) {
  const relTimes = (s.cache?.releases || [])
    .map((r) => Date.parse(r.publishedAt || ""))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  if (relTimes.length) return relTimes[0];
  const p = Date.parse(s.pushedAt || "");
  if (Number.isFinite(p)) return p;
  return s.createdAt || 0;
}

/** 远端条目规范化(补全字段,防御旧格式/手改数据) */
function ensureItem(r) {
  return {
    id: r.id || store.newId(),
    name: r.name || `${r.owner}/${r.repo}`,
    owner: r.owner,
    repo: r.repo,
    category: (r.category || "未分类").trim(),
    note: (r.note || "").trim(),
    pushedAt: r.pushedAt ?? null,
    desc: r.desc ?? null,
    createdAt: r.createdAt || Date.now(),
    stars: r.stars ?? null,
    etag: r.etag ?? null,
    repoEtag: r.repoEtag ?? null,
    cache: r.cache && Array.isArray(r.cache.releases) ? r.cache : { total: null, releases: [] },
  };
}

/** 只增不删 smart 合并:远端独有 → 新增;同名(owner+repo)取更"新鲜"一份;本地独有保留 */
function mergeRemote(data, remote) {
  let imported = 0;
  let updated = 0;
  let kept = 0;
  for (const r of remote) {
    if (!r || !r.owner || !r.repo) continue;
    const local = data.software.find((x) => x.owner === r.owner && x.repo === r.repo);
    if (!local) {
      data.software.unshift(ensureItem(r));
      imported++;
    } else if (freshnessOf(r) > freshnessOf(local)) {
      const { id, createdAt } = local;
      Object.assign(local, ensureItem(r));
      local.id = id;
      local.createdAt = createdAt;
      updated++;
    } else {
      kept++;
    }
  }
  if (imported || updated) store.save();
  return { imported, updated, kept };
}

async function apiWebdav(req, res, action, wd) {
  const s = store.getSettings();
  if (action === "config" && req.method === "GET") {
    return json(res, 200, { ok: true, url: s.webdavUrl, user: s.webdavUser, has: !!s.webdavPass, defaultUrl: webdav.DEFAULT_WEBDAV_URL });
  }
  if (action === "config" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, message: e.message }); }
    const patch = { webdavUrl: String(body.url || "").trim(), webdavUser: String(body.user || "").trim() };
    if (patch.webdavUrl && !webdav.isValidUrl(patch.webdavUrl))
      return json(res, 400, { ok: false, code: "wd_bad_url", message: "URL 格式不正确（需 http/https）" });
    // 密码:显式传非空 → 更新;传空且已有密码 → 保留;传空且无密码 → 保持空
    if (body.pass !== undefined && String(body.pass) !== "") patch.webdavPass = String(body.pass);
    const r = store.updateSettings(patch);
    return json(res, 200, { ok: true, message: "WebDAV 配置已保存" });
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, message: "method not allowed" });
  if (action === "test") {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    const cfg = wdCfg(s, body);
    if (!cfg.user || !cfg.pass) return json(res, 400, { ok: false, code: "wd_need_cred", message: "请填写用户名与密码" });
    if (!webdav.isValidUrl(cfg.url)) return json(res, 400, { ok: false, code: "wd_bad_url", message: "URL 格式不正确（需 http/https）" });
    try {
      const r = await wd.testConnection(cfg.url, cfg.user, cfg.pass, WEBDAV_DIR);
      return json(res, 200, { ok: true, count: r.count, message: `连接成功（检测到 ${r.count} 个项目）` });
    } catch (e) {
      return json(res, 502, { ok: false, message: "连接失败: " + e.message });
    }
  }
  if (action === "push") {
    try {
      const cfg = requireWd(wdSaved(s));
      const { filename } = await wd.pushBackup(cfg.url, cfg.user, cfg.pass, WEBDAV_DIR, JSON.stringify(store.load(), null, 2));
      return json(res, 200, { ok: true, filename, message: `已上传备份「${filename}」到云端` });
    } catch (e) {
      return json(res, 502, { ok: false, message: "上传失败: " + e.message });
    }
  }
  if (action === "pull") {
    try {
      const cfg = requireWd(wdSaved(s));
      const { filename, content } = await wd.pullLatest(cfg.url, cfg.user, cfg.pass, WEBDAV_DIR);
      // 结构校验:必须是 {software:[...]} 合法清单,防损坏数据静默覆盖
      let parsed;
      try { parsed = JSON.parse(content); } catch { return json(res, 502, { ok: false, message: "远端数据不是合法 JSON,已拒绝覆盖" }); }
      if (!Array.isArray(parsed.software)) return json(res, 502, { ok: false, message: "远端数据结构无效(缺 software 数组),已拒绝覆盖" });
      const file = DATA_FILE();
      const bak = file + ".bak-" + Date.now();
      try { fs.copyFileSync(file, bak); } catch {}
      fs.writeFileSync(file, content);
      store.resetCache();
      return json(res, 200, { ok: true, filename, message: `已从「${filename}」恢复(本地已备份)` });
    } catch (e) {
      return json(res, 502, { ok: false, message: "下载失败: " + e.message });
    }
  }
  if (action === "sync") {
    try {
      const cfg = requireWd(wdSaved(s));
      const result = { pulled: null, pushed: null };
      // 第一步:拉远端最新备份 → smart 合并进本地(只增不删)
      try {
        const { filename, content } = await wd.pullLatest(cfg.url, cfg.user, cfg.pass, WEBDAV_DIR);
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed.software)) throw new Error("远端数据结构无效(缺 software 数组)");
        const m = mergeRemote(store.load(), parsed.software);
        result.pulled = { filename, ...m };
      } catch (e) {
        if (e && e.message && e.message.includes("远端没有备份文件")) result.pulled = null; // 首次同步:只上传
        else throw e;
      }
      // 第二步:导出合并后的本地全量上传新备份(保留策略自动清理旧文件)
      const { filename } = await wd.pushBackup(cfg.url, cfg.user, cfg.pass, WEBDAV_DIR, JSON.stringify(store.load(), null, 2));
      result.pushed = { filename };
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 502, { ok: false, message: "同步失败: " + e.message });
    }
  }
  if (action === "clear") {
    store.updateSettings({ webdavUrl: "", webdavUser: "", webdavPass: "" });
    return json(res, 200, { ok: true, message: "WebDAV 配置已清空" });
  }
  return json(res, 404, { ok: false, message: "unknown webdav action" });
}

// ---- 路由 ----
/** 创建 HTTP 服务。deps 用于测试注入 fake 的 GitHub/WebDAV 客户端;默认用真实实现 */
export function createServer(deps = {}) {
  const github = {
    fetchReleases: deps.fetchReleases || fetchReleases,
    fetchRepoInfo: deps.fetchRepoInfo || fetchRepoInfo,
    fetchReposBatch: deps.fetchReposBatch || fetchReposBatch,
  };
  const wd = deps.webdav || webdav;

  return http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      const { pathname, searchParams } = u;

      if (pathname === "/health") return json(res, 200, { ok: true });
      if (pathname === "/api/software" || pathname === "/api/software/") return await apiSoftware(req, res, github);
      if (pathname === "/api/settings") return await apiSettings(req, res);
      // POST /api/check-updates — 串行检查全部软件最新 tag + 顺带刷新 star 数(逻辑在服务层)
      if (pathname === "/api/check-updates" && req.method === "POST") {
        const result = await service.checkUpdates(github, store.load());
        return json(res, 200, { ok: true, ...result });
      }
      // POST /api/refresh-stars — 串行拉取全部仓库 star 数并缓存(逻辑在服务层)
      if (pathname === "/api/refresh-stars" && req.method === "POST") {
        const result = await service.refreshStars(github, store.load());
        return json(res, 200, { ok: true, ...result });
      }
      // WebDAV 云同步:/api/webdav/<config|test|push|pull|sync|clear>
      if (pathname.startsWith("/api/webdav/")) {
        const action = pathname.slice("/api/webdav/".length);
        return await apiWebdav(req, res, action, wd);
      }
      // 精确分段:/api/software/<id>[/releases|/refresh]
      const PREFIX = "/api/software/";
      if (pathname.startsWith(PREFIX)) {
        const seg = pathname.slice(PREFIX.length).split("/").filter(Boolean);
        if (seg.length >= 1) return await apiSoftwareItem(req, res, seg[0], seg.slice(1), searchParams, github);
        return json(res, 404, { ok: false, code: "bad_route", message: "未知路由" });
      }
      if (pathname.startsWith("/api/")) return json(res, 404, { ok: false, message: "unknown api" });
      return serveStatic(req, res, pathname);
    } catch (e) {
      return json(res, 500, { ok: false, message: e.message });
    }
  });
}

// ---- 启动(仅主模块执行;测试 import 时不监听) ----
export function start(server) {
  server.listen(port, "127.0.0.1", () => {
    console.log(`gh-release-center running on ${port}`);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) start(createServer());
