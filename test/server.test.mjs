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

const server = createServer({ fetchReleases: fakeReleases });
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
  // 无更新场景:fake 返回与缓存一致
  const same = createServer({ fetchReleases: fakeReleases, fetchRepoInfo: fakeRepoInfo });
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
  assert.equal(item.stars, null, "初始 stars 为 null");
  assert.equal(item.desc, null, "初始 desc 为 null");
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
  // GET /api/settings 同样脱敏
  r = await req("GET", "/api/settings");
  assert.equal(r.data.settings.webdavHas, true);
  assert.equal(r.data.settings.webdavPass, undefined);
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

after(() => server.close());
