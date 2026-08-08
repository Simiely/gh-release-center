// test/server.test.mjs — 路由层测试(注入 fake GitHub 客户端,不碰真实网络)
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.mjs";
import * as store from "../lib/store.mjs";

// 隔离数据目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghrc-srv-"));
process.env.CAP_STORAGE_DIR = tmpDir;
store.resetCache();

// fake GitHub 客户端
const rel = (tag, assets = []) => ({
  tag, name: tag, publishedAt: "2026-01-01T00:00:00Z", prerelease: false,
  assets: assets.map((n) => ({ name: n, size: 100, sizeText: "100 B", downloads: 0, url: "https://x/" + n, platform: "other" })),
});
let calls = [];
const fakeReleases = async ({ page }) => {
  calls.push(page);
  if (page === 999) return { ok: false, code: "not_found", message: "仓库或资源不存在(404)", status: 404 };
  return {
    ok: true,
    releases: [rel(`v1.0.${page}a`), rel(`v1.0.${page}b`)],
    hasMore: page < 2,
  };
};

const fakeRepoInfo = async () => ({ ok: true, info: { fullName: "o/r", desc: "自动简介", private: false, stars: 42, pushedAt: "2026-08-05T00:00:00Z" } });

const server = createServer({ fetchReleases: fakeReleases, fetchRepoInfo: fakeRepoInfo });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function req(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

test("GET /health", async () => {
  const r = await req("GET", "/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
});

test("GET /api/software 空列表", async () => {
  const r = await req("GET", "/api/software");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.software, []);
});

test("GET /api/software/ 尾部斜杠等价", async () => {
  const r = await req("GET", "/api/software/");
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test("POST 拉取第一页失败 → 拒绝添加(不静默创建)", async () => {
  const bad = createServer({
    fetchReleases: async () => ({ ok: false, code: "not_found", message: "仓库或资源不存在(404)", status: 404 }),
  });
  await new Promise((r) => bad.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${bad.address().port}`;
  const r = await (await fetch(b + "/api/software", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: "ghost/repo" }),
  })).json();
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_found");
  bad.close();
  // 确认没有残留条目
  const list = await req("GET", "/api/software");
  assert.equal(list.data.software.length, 0);
});

test("POST 正常 → 201 + 拉第一页缓存", async () => {
  const r = await req("POST", "/api/software", { name: "测试", repoUrl: "owner/repo", category: "工具" });
  assert.equal(r.status, 201);
  assert.equal(r.data.ok, true);
  const item = r.data.item;
  assert.equal(item.owner, "owner");
  assert.equal(item.repo, "repo");
  assert.equal(item.cache.releases.length, 2);
  assert.equal(item.cache.hasMore, true);
  assert.equal(item.pushedAt, "2026-08-05T00:00:00Z", "添加时顺带采集推送日期");
  assert.equal(item.stars, 42, "添加时顺带采集 Star");
  assert.equal(item.desc, "自动简介", "添加时顺带采集简介");
});

test("GET /api/software/:id/releases?page=2 增量合并去重", async () => {
  const list = await req("GET", "/api/software");
  const id = list.data.software[0].id;
  const r = await req("GET", `/api/software/${id}/releases?page=2`);
  assert.equal(r.status, 200);
  // 2(第一页) + 2(第二页) = 4,无重复
  assert.equal(r.data.releases.length, 4);
  assert.equal(r.data.hasMore, false);
  assert.equal(r.data.total, 4);
  // 重复请求 page2 不产生新数据
  const again = await req("GET", `/api/software/${id}/releases?page=2`);
  assert.equal(again.data.releases.length, 4);
});

test("releases 合并后按发布时间降序(LATEST 主卡不被旧版本占位)", async () => {
  const mk = (tag, publishedAt) => ({ ...rel(tag), publishedAt });
  let rc = 0;
  const src = createServer({
    fetchReleases: async () => {
      rc++;
      // 第 1 次 = POST 添加(缓存 v1.0);第 2 次 = GET page=1 重拉,此时已出现更新版本
      if (rc === 1) return { ok: true, releases: [mk("v1.0", "2026-01-02T00:00:00Z")], hasMore: true };
      return { ok: true, releases: [mk("v2.0", "2026-02-01T00:00:00Z"), mk("v1.5", "2026-01-20T00:00:00Z")], hasMore: false };
    },
  });
  await new Promise((r) => src.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${src.address().port}`;
  await fetch(b + "/api/software", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoUrl: "o/merge" }) });
  const list = await (await fetch(b + "/api/software")).json();
  const id = list.software.find((x) => x.owner === "o").id;
  // 重拉 page=1(新版本 v2.0 出现),合并后必须按发布时间排序
  const r = await (await fetch(b + `/api/software/${id}/releases?page=1`)).json();
  assert.equal(r.releases[0].tag, "v2.0", "最新发布排首位,LATEST 主卡不占旧位");
  assert.deepEqual(r.releases.map((x) => x.tag), ["v2.0", "v1.5", "v1.0"]);
  src.close();
});

test("DELETE 不存在 → 404", async () => {
  const r = await req("DELETE", "/api/software/nonexistent");
  assert.equal(r.status, 404);
  assert.equal(r.data.code, "notfound");
});

test("未知子路径 → 404 bad_route", async () => {
  const list = await req("GET", "/api/software");
  const id = list.data.software[0].id;
  const r = await req("GET", `/api/software/${id}/weird`);
  assert.equal(r.status, 404);
  assert.equal(r.data.code, "bad_route");
});

test("releases 子路径 405 方法不允许", async () => {
  const list = await req("GET", "/api/software");
  const id = list.data.software[0].id;
  const r = await req("DELETE", `/api/software/${id}/releases`);
  assert.equal(r.status, 405);
});

test("check-updates: 有新版时返回 id,无更新时不返回", async () => {
  // 当前 fakeReleases 按 page 返回 v1.0.<page>a/b;缓存最新是 v1.0.1a(POST 时 page=1 拉的)
  // 构造一个"最新已变"的场景:先 POST 添加(缓存 v1.0.1a),再让 fake 返回新 tag
  const fakeRepoInfo = async () => ({ ok: true, info: { fullName: "o/r", desc: "", private: false, stars: 0 } });
  const src = createServer({ fetchReleases: fakeReleases, fetchRepoInfo: fakeRepoInfo });
  await new Promise((r) => src.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${src.address().port}`;
  await fetch(b + "/api/software", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoUrl: "o/updates" }) });
  // 替换 fake:最新变为 v2.0.0
  const changed = createServer({
    fetchReleases: async ({ page }) => ({
      ok: true, releases: [rel(`v2.0.0`)], hasMore: false,
    }),
    fetchRepoInfo: fakeRepoInfo,
  });
  await new Promise((r) => changed.listen(0, "127.0.0.1", r));
  const cb = `http://127.0.0.1:${changed.address().port}`;
  // 先查 software 拿 id(从共享 store 读)
  const list = await req("GET", "/api/software");
  const id = list.data.software.find((x) => x.owner === "o").id;
  const r = await (await fetch(cb + "/api/check-updates", { method: "POST" })).json();
  assert.equal(r.ok, true);
  assert.ok(r.hasNew.includes(id), "应有新版 id");
  // 无更新场景:写回后缓存头部已是 v2.0.0,fake 返回一致 → 不再判新
  const same = createServer({
    fetchReleases: async () => ({ ok: true, releases: [rel("v2.0.0")], hasMore: false }),
    fetchRepoInfo: fakeRepoInfo,
  });
  await new Promise((r) => same.listen(0, "127.0.0.1", r));
  const sb = `http://127.0.0.1:${same.address().port}`;
  const r2 = await (await fetch(sb + "/api/check-updates", { method: "POST" })).json();
  assert.ok(!r2.hasNew.includes(id), "无更新时不返回");
  src.close(); changed.close(); same.close();
});

test("refresh-stars: 拉取 star + 自动简介并缓存,GET 响应带 stars/desc", async () => {
  const repo = `starred-${Date.now()}`;
  const fakeRepo = async () => ({ ok: true, info: { fullName: "o/r", desc: "自动简介测试", private: false, stars: 42 } });
  const src = createServer({ fetchReleases: fakeReleases, fetchRepoInfo: fakeRepo });
  await new Promise((r) => src.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${src.address().port}`;
  await fetch(b + "/api/software", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoUrl: `o/${repo}` }) });
  const before = await (await fetch(b + "/api/software")).json();
  const item = before.software.find((x) => x.repo === repo);
  // v0.5.3:添加时即采集 star/简介/推送日期,初始即有值;refresh-stars 再次刷新保持
  assert.equal(item.stars, 42, "添加时已采集 stars");
  assert.equal(item.desc, "自动简介测试", "添加时已采集 desc");
  const r = await (await fetch(b + "/api/refresh-stars", { method: "POST" })).json();
  assert.equal(r.ok, true);
  assert.ok(r.updated >= 1, "至少更新 1 个");
  const after = await (await fetch(b + "/api/software")).json();
  const got = after.software.find((x) => x.id === item.id);
  assert.equal(got.stars, 42, "stars 已缓存并返回");
  assert.equal(got.desc, "自动简介测试", "desc 已缓存并返回");
  src.close();
});

test("编辑与删除", async () => {
  const list = await req("GET", "/api/software");
  const id = list.data.software[0].id;
  const u = await req("PUT", `/api/software/${id}`, { name: "改名", note: "备注" });
  assert.equal(u.status, 200);
  assert.equal(u.data.item.name, "改名");
  const d = await req("DELETE", `/api/software/${id}`);
  assert.equal(d.status, 200);
  assert.equal(d.data.ok, true);
});

test("webdav: 配置保存/密码脱敏/清空", async () => {
  // 保存配置(带密码)
  let r = await req("POST", "/api/webdav/config", { url: "https://dav.example.com/dav/", user: "u1", pass: "secret" });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  // GET config:密码不返回明文,只回 has;带默认地址
  r = await req("GET", "/api/webdav/config");
  assert.equal(r.data.url, "https://dav.example.com/dav/");
  assert.equal(r.data.user, "u1");
  assert.equal(r.data.has, true);
  assert.equal(r.data.pass, undefined, "config 不返回密码明文");
  assert.equal(r.data.defaultUrl, "http://192.168.2.1:6086/", "返回默认 WebDAV 地址");
  // GET /api/settings 同样脱敏(webdavPass + githubToken)
  r = await req("GET", "/api/settings");
  assert.equal(r.data.settings.webdavHas, true);
  assert.equal(r.data.settings.webdavPass, undefined);
  assert.equal(r.data.settings.githubTokenHas, false);
  assert.equal(r.data.settings.githubToken, undefined, "settings 不返回 token 明文");
  // PUT /api/settings 不回传 settings 全量(凭证防泄漏)
  r = await req("PUT", "/api/settings", { githubToken: "ghp_123" });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.settings, undefined, "PUT 响应不包含 settings");
  assert.equal(r.data.githubToken, undefined, "PUT 响应不包含 token");
  r = await req("GET", "/api/settings");
  assert.equal(r.data.settings.githubTokenHas, true, "token 已保存");
  // 清掉 token,避免污染后续测试(懒补采会按 token 选择 GraphQL/REST 分支)
  await req("PUT", "/api/settings", { githubToken: "__CLEAR__" });
  // 留空密码保存 → 保留原密码
  await req("POST", "/api/webdav/config", { url: "https://dav.example.com/dav/", user: "u1", pass: "" });
  r = await req("GET", "/api/webdav/config");
  assert.equal(r.data.has, true, "留空密码应保留原密码");
  // clear → 清空
  r = await req("POST", "/api/webdav/clear");
  assert.equal(r.data.ok, true);
  r = await req("GET", "/api/webdav/config");
  assert.equal(r.data.has, false);
  assert.equal(r.data.url, "");
});

test("GET /api/software 懒补采:推送日期缺失的软件自动补齐(不阻塞响应)", async () => {
  const src = createServer({
    fetchReleases: fakeReleases,
    fetchRepoInfo: async () => ({ ok: true, info: { stars: 7, desc: "d", pushedAt: "2026-08-06T00:00:00Z" } }),
  });
  await new Promise((r) => src.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${src.address().port}`;
  await fetch(b + "/api/software", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoUrl: "o/lazy" }) });
  const before = await (await fetch(b + "/api/software")).json();
  const id = before.software.find((x) => x.owner === "o").id;
  // 模拟旧数据:推送日期缺失
  const item = store.find(id);
  item.pushedAt = null;
  store.save();
  // GET 触发懒补采(fire-and-forget)→ 等待后台完成
  await (await fetch(b + "/api/software")).json();
  await new Promise((r) => setTimeout(r, 400));
  const after = await (await fetch(b + "/api/software")).json();
  const got = after.software.find((x) => x.id === id);
  assert.equal(got.pushedAt, "2026-08-06T00:00:00Z", "推送日期被自动补齐");
  // 清理
  await fetch(b + `/api/software/${id}`, { method: "DELETE" });
  src.close();
});

test("GET /api/software 懒补采 GraphQL 批量分支(有 token 时一次请求补齐)", async () => {
  const src = createServer({
    fetchReleases: fakeReleases,
    fetchRepoInfo: fakeRepoInfo,
    fetchReposBatch: async ({ repos }) => {
      const out = {};
      for (const r of repos) out[`${r.owner}/${r.repo}`] = { pushedAt: "2026-08-07T00:00:00Z", stars: 9, desc: "批量简介" };
      return { ok: true, repos: out };
    },
  });
  await new Promise((r) => src.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${src.address().port}`;
  const orig = store.getSettings().githubToken;
  await fetch(b + "/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ githubToken: "ghp_x" }) });
  await fetch(b + "/api/software", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoUrl: "o/batch" }) });
  const before = await (await fetch(b + "/api/software")).json();
  const id = before.software.find((x) => x.owner === "o").id;
  const item = store.find(id);
  item.pushedAt = null;
  store.save();
  await (await fetch(b + "/api/software")).json(); // 触发 GraphQL 批量补采
  await new Promise((r) => setTimeout(r, 400));
  const after = await (await fetch(b + "/api/software")).json();
  const got = after.software.find((x) => x.id === id);
  assert.equal(got.pushedAt, "2026-08-07T00:00:00Z", "批量分支补齐推送日期");
  assert.equal(got.desc, "批量简介", "批量分支补齐简介");
  // 清理 + 恢复 token
  await fetch(b + `/api/software/${id}`, { method: "DELETE" });
  await fetch(b + "/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ githubToken: orig ? orig : "__CLEAR__" }) });
  src.close();
});

/* ---------- WebDAV 路由:push/pull/sync(注入 fake wd,不碰真实网络) ---------- */
let wdPullImpl = async () => { throw new Error("远端没有备份文件"); };
const fakeWd = {
  testConnection: async () => ({ ok: true, count: 2 }),
  pushBackup: async (b, u, p, d, content, keep, filename) => ({ filename: filename || "ghrc-backup-20260808000000.json" }),
  pullLatest: async (...args) => wdPullImpl(...args),
};
const wdSrv = createServer({
  fetchReleases: fakeReleases,
  fetchRepoInfo: async () => ({ ok: true, info: {} }),
  webdav: fakeWd,
});
await new Promise((r) => wdSrv.listen(0, "127.0.0.1", r));
const wdBase = `http://127.0.0.1:${wdSrv.address().port}`;
const wdReq = async (method, p, body) => {
  const url = p.startsWith("/api/") ? p : "/api" + p;
  const res = await fetch(wdBase + url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};

test("webdav: test 缺凭据 → 400;保存配置后测试用已存凭据;URL 校验", async () => {
  await wdReq("POST", "/webdav/clear"); // 清干净
  let r = await wdReq("POST", "/webdav/test", {});
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "wd_need_cred");
  // URL 非法
  r = await wdReq("POST", "/webdav/test", { url: "ftp://x", user: "u", pass: "p" });
  assert.equal(r.data.code, "wd_bad_url");
  // 保存配置(带密码)
  r = await wdReq("POST", "/webdav/config", { url: "https://dav.example.com/dav/", user: "u1", pass: "p1" });
  assert.equal(r.status, 200);
  // 空 body 测试 → 回退已保存凭据
  r = await wdReq("POST", "/webdav/test", {});
  assert.equal(r.status, 200);
  assert.equal(r.data.count, 2);
  assert.ok(r.data.message.includes("检测到 2"));
});

test("webdav: push 用已保存配置上传新备份", async () => {
  const r = await wdReq("POST", "/webdav/push");
  assert.equal(r.status, 200);
  assert.ok(r.data.filename, "返回远端文件名");
  assert.ok(r.data.message.includes("已上传备份"));
});

test("webdav: pull 恢复最新备份(本地 .bak + 结构校验)", async () => {
  // 模拟真实 push 的完整备份:含 settings(否则覆盖后 WebDAV 配置会被重置)
  const remoteContent = JSON.stringify({
    settings: { webdavUrl: "https://dav.example.com/dav/", webdavUser: "u1", webdavPass: "p1" },
    software: [{ id: "wd1", name: "WDR", owner: "wd", repo: "r1", category: "工具", createdAt: Date.now(), cache: { total: null, releases: [] } }],
  });
  wdPullImpl = async () => ({ filename: "ghrc-backup-20260808000001.json", content: remoteContent });
  let r = await wdReq("POST", "/webdav/pull");
  assert.equal(r.status, 200);
  assert.ok(r.data.message.includes("已从「ghrc-backup-20260808000001.json」恢复"));
  // 本地已刷新出远端软件
  const list = await wdReq("GET", "/api/software");
  assert.ok(list.data.software.some((x) => x.owner === "wd" && x.repo === "r1"), "远端软件已恢复进本地");
  // 本地有 .bak 兜底文件
  const files = fs.readdirSync(tmpDir);
  assert.ok(files.some((f) => f.startsWith("data.json.bak-")), "覆盖前生成本地备份");
  // 结构校验:损坏内容拒绝覆盖
  wdPullImpl = async () => ({ filename: "bad.json", content: "not-json" });
  r = await wdReq("POST", "/webdav/pull");
  assert.equal(r.status, 502);
  assert.ok(r.data.message.includes("不是合法 JSON"));
});

test("webdav: sync 首次(远端无备份)只上传不拉", async () => {
  wdPullImpl = async () => { throw new Error("远端没有备份文件"); };
  const r = await wdReq("POST", "/webdav/sync");
  assert.equal(r.status, 200);
  assert.equal(r.data.pulled, null, "首次同步 pulled 为 null");
  assert.ok(r.data.pushed.filename, "上传了首份备份");
  // 本地既有软件不受影响
  const list = await wdReq("GET", "/api/software");
  assert.ok(list.data.software.some((x) => x.owner === "wd" && x.repo === "r1"));
});

test("webdav: sync 合并(远端独有新增 / 同名取新 / 本地独有保留)", async () => {
  wdPullImpl = async () => ({
    filename: "ghrc-backup-20260808000002.json",
    content: JSON.stringify({
      settings: { webdavUrl: "https://dav.example.com/dav/", webdavUser: "u1", webdavPass: "p1" },
      software: [
        // 远端独有 → imported
        { id: "wd2", name: "远端新", owner: "wd", repo: "r2", category: "工具", createdAt: 1, cache: { total: null, releases: [] } },
        // 与本地 wd/r1 同名:remote 发布时间(2030)比本地 createdAt 新 → updated
        { id: "wd3", name: "远端更新版", owner: "wd", repo: "r1", category: "工具", createdAt: 1, pushedAt: "2030-01-01T00:00:00Z", cache: { total: null, releases: [{ tag: "v9", publishedAt: "2030-01-01T00:00:00Z" }] } },
      ],
    }),
  });
  const r = await wdReq("POST", "/webdav/sync");
  assert.equal(r.status, 200);
  assert.equal(r.data.pulled.imported, 1, "远端独有 wd/r2 新增");
  assert.equal(r.data.pulled.updated, 1, "同名 wd/r1 远端更鲜 → 更新");
  assert.ok(r.data.pushed.filename, "上传合并后全量");
  const list = await wdReq("GET", "/api/software");
  assert.ok(list.data.software.some((x) => x.repo === "r2"), "r2 已合并进本地");
  const r1 = list.data.software.find((x) => x.repo === "r1");
  assert.equal(r1.name, "远端更新版", "r1 取远端更新数据");
  // 清理,避免污染后续
  for (const s of list.data.software) if (s.owner === "wd") await wdReq("DELETE", `/api/software/${s.id}`);
});

test("webdav: clear 清空配置", async () => {
  const r = await wdReq("POST", "/webdav/clear");
  assert.equal(r.status, 200);
  const cfg = await wdReq("GET", "/webdav/config");
  assert.equal(cfg.data.has, false);
  assert.equal(cfg.data.url, "");
});

after(() => { server.closeAllConnections?.(); server.close(); wdSrv.closeAllConnections?.(); wdSrv.close(); });
