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

after(() => server.close());
