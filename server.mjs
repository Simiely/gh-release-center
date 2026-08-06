// server.mjs — gh-release-center 入口
// 独立运行: node server.mjs [port]
// 平台托管: tools-center 以 node server.mjs <port> 启动,端口来自 manifest.port
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as store from "./lib/store.mjs";
import { parseRepoUrl, fetchReleases, fetchRepoInfo } from "./lib/github.mjs";
import * as webdav from "./lib/webdav.mjs";
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
async function apiSoftware(req, res, github) {
  // GET /api/software — 返回含缓存 releases(本地已拉取的部分),前端免网络直接渲染
  if (req.method === "GET") {
    const list = store.load().software.map((s) => ({
      id: s.id, name: s.name, owner: s.owner, repo: s.repo,
      category: s.category, note: s.note, desc: s.desc ?? null, createdAt: s.createdAt,
      stars: s.stars ?? null,
      total: s.cache?.total ?? null,
      hasMore: !!(s.cache && s.cache.hasMore),
      releases: s.cache?.releases ?? [],
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
    // 合并去重(按 tag)
    const merged = new Map(item.cache.releases.map((x) => [x.tag, x]));
    for (const rel of r.releases) merged.set(rel.tag, rel);
    const releases = [...merged.values()];
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

/** WebDAV 云同步:config 读写(密码脱敏)/test/upload/download/clear
 *  远端目录 = workbuddy/github下载/,数据文件 = data.json(本地 CAP_STORAGE_DIR 的完整数据)
 *  默认地址 = 积分仪表盘同款(192 内网),设置里不填地址时自动使用 */
const WEBDAV_DIR = "workbuddy/github下载";
const DEFAULT_WEBDAV_URL = "http://192.168.2.1:6086/";
const wdUrl = (s) => String(s.webdavUrl || "").trim() || DEFAULT_WEBDAV_URL;
const DATA_FILE = () => path.join(store.storageDir(), "data.json");

async function apiWebdav(req, res, action) {
  const s = store.getSettings();
  if (action === "config" && req.method === "GET") {
    return json(res, 200, { ok: true, url: s.webdavUrl, user: s.webdavUser, has: !!s.webdavPass, defaultUrl: DEFAULT_WEBDAV_URL });
  }
  if (action === "config" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, message: e.message }); }
    const patch = { webdavUrl: String(body.url || "").trim(), webdavUser: String(body.user || "").trim() };
    // 密码:显式传非空 → 更新;传空且已有密码 → 保留;传空且无密码 → 保持空
    if (body.pass !== undefined && String(body.pass) !== "") patch.webdavPass = String(body.pass);
    const r = store.updateSettings(patch);
    return json(res, 200, { ok: true, message: "WebDAV 配置已保存" });
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, message: "method not allowed" });
  if (action === "test") {
    try { await webdav.testConnection(wdUrl(s), s.webdavUser, s.webdavPass, WEBDAV_DIR); return json(res, 200, { ok: true, message: "连接成功" }); }
    catch (e) { return json(res, 502, { ok: false, message: "连接失败: " + e.message }); }
  }
  if (action === "upload") {
    try {
      await webdav.uploadFile(wdUrl(s), s.webdavUser, s.webdavPass, WEBDAV_DIR, "data.json", JSON.stringify(store.load(), null, 2));
      return json(res, 200, { ok: true, message: "已上传到云端" });
    } catch (e) { return json(res, 502, { ok: false, message: "上传失败: " + e.message }); }
  }
  if (action === "download") {
    try {
      const text = await webdav.downloadFile(wdUrl(s), s.webdavUser, s.webdavPass, WEBDAV_DIR, "data.json");
      if (text === null) return json(res, 404, { ok: false, message: "云端没有数据文件,请先上传" });
      // 结构校验:必须是 {software:[...]} 合法清单,防损坏数据静默覆盖
      let parsed;
      try { parsed = JSON.parse(text); } catch { return json(res, 502, { ok: false, message: "云端数据不是合法 JSON,已拒绝覆盖" }); }
      if (!Array.isArray(parsed.software)) return json(res, 502, { ok: false, message: "云端数据结构无效(缺 software 数组),已拒绝覆盖" });
      const file = DATA_FILE();
      const bak = file + ".bak-" + Date.now();
      try { fs.copyFileSync(file, bak); } catch {}
      fs.writeFileSync(file, text);
      store.resetCache();
      return json(res, 200, { ok: true, message: "已从云端恢复(本地已备份)" });
    } catch (e) { return json(res, 502, { ok: false, message: "下载失败: " + e.message }); }
  }
  if (action === "clear") {
    store.updateSettings({ webdavUrl: "", webdavUser: "", webdavPass: "" });
    return json(res, 200, { ok: true, message: "WebDAV 配置已清空" });
  }
  return json(res, 404, { ok: false, message: "unknown webdav action" });
}

// ---- 路由 ----
/** 创建 HTTP 服务。deps 用于测试注入 fake 的 GitHub 客户端;默认用真实实现 */
export function createServer(deps = {}) {
  const github = {
    fetchReleases: deps.fetchReleases || fetchReleases,
    fetchRepoInfo: deps.fetchRepoInfo || fetchRepoInfo,
  };

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
      // WebDAV 云同步:/api/webdav/<config|test|upload|download|clear>
      if (pathname.startsWith("/api/webdav/")) {
        const action = pathname.slice("/api/webdav/".length);
        return await apiWebdav(req, res, action);
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
