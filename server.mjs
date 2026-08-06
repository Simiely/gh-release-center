// server.mjs — gh-release-center 入口
// 独立运行: node server.mjs [port]
// 平台托管: tools-center 以 node server.mjs <port> 启动,端口来自 manifest.port
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as store from "./lib/store.mjs";
import { parseRepoUrl, fetchReleases, fetchRepoInfo } from "./lib/github.mjs";

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
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid JSON body");
  }
}

// ---- 静态文件 ----
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === "/" || p === "") p = "/index.html";
  const full = path.normalize(path.join(PUBLIC_DIR, p));
  if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { ok: false, message: "forbidden" });
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return json(res, 404, { ok: false, message: "not found" });
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(full).pipe(res);
}

// ---- API ----
async function apiSoftware(req, res) {
  // GET /api/software — 返回含缓存 releases(本地已拉取的部分),前端免网络直接渲染
  if (req.method === "GET") {
    const list = store.load().software.map((s) => ({
      id: s.id, name: s.name, owner: s.owner, repo: s.repo,
      category: s.category, note: s.note, createdAt: s.createdAt,
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
    const info = await fetchRepoInfo({ ...parsed, token: settings.githubToken, proxy: settings.proxy });
    const r = store.createSoftware({ name: body.name || (info.ok ? info.info.fullName : `${parsed.owner}/${parsed.repo}`), ...parsed, category: body.category, note: body.note });
    if (!r.ok) return json(res, 409, r);
    // 新增后立即拉第一页
    const first = await fetchReleases({ ...parsed, page: 1, perPage: settings.perPage, token: settings.githubToken, proxy: settings.proxy });
    if (first.ok) {
      r.item.cache = { total: first.hasMore ? null : first.releases.length, hasMore: first.hasMore, releases: first.releases };
      store.save();
    }
    return json(res, 201, { ok: true, item: r.item, fetch: first.ok ? { hasMore: first.hasMore } : first });
  }
  return json(res, 405, { ok: false, message: "method not allowed" });
}

async function apiSoftwareId(req, res, id, qs) {
  // GET /api/software/:id/releases?page=N — 增量拉取并合并缓存
  if (req.url.includes("/releases") && req.method === "GET") {
    const item = store.find(id);
    if (!item) return json(res, 404, { ok: false, code: "notfound", message: "软件不存在" });
    const page = Math.max(1, parseInt(qs.get("page") || "1", 10) || 1);
    const settings = store.getSettings();
    const r = await fetchReleases({ owner: item.owner, repo: item.repo, page, perPage: settings.perPage, token: settings.githubToken, proxy: settings.proxy });
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
  // POST /api/software/:id/refresh — 清缓存重拉第一页
  if (req.url.includes("/refresh") && req.method === "POST") {
    const item = store.find(id);
    if (!item) return json(res, 404, { ok: false, code: "notfound", message: "软件不存在" });
    const settings = store.getSettings();
    const r = await fetchReleases({ owner: item.owner, repo: item.repo, page: 1, perPage: settings.perPage, token: settings.githubToken, proxy: settings.proxy });
    if (!r.ok) return json(res, r.status || 502, r);
    item.cache = { total: r.hasMore ? null : r.releases.length, hasMore: r.hasMore, releases: r.releases };
    store.save();
    return json(res, 200, { ok: true, releases: r.releases, hasMore: r.hasMore, total: item.cache.total });
  }
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

async function apiSettings(req, res) {
  if (req.method === "GET") {
    const s = store.getSettings();
    return json(res, 200, { ok: true, settings: s });
  }
  if (req.method === "PUT") {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, message: e.message }); }
    const r = store.updateSettings(body);
    return json(res, 200, r);
  }
  return json(res, 405, { ok: false, message: "method not allowed" });
}

// ---- 路由 ----
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    const { pathname, searchParams } = u;

    if (pathname === "/health") return json(res, 200, { ok: true });
    if (pathname === "/api/software") return await apiSoftware(req, res);
    if (pathname.startsWith("/api/settings")) return await apiSettings(req, res);
    if (pathname.startsWith("/api/software/")) {
      const rest = pathname.slice("/api/software/".length);
      const id = rest.split("/")[0];
      return await apiSoftwareId(req, res, id, searchParams);
    }
    if (pathname.startsWith("/api/")) return json(res, 404, { ok: false, message: "unknown api" });
    return serveStatic(req, res, pathname);
  } catch (e) {
    return json(res, 500, { ok: false, message: e.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`gh-release-center running on ${port}`);
});
