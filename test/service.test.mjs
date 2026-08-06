// test/service.test.mjs — 服务层测试(checkUpdates/refreshStars/ghOpts, fake github 注入)
import test from "node:test";
import assert from "node:assert/strict";
import { ghOpts, checkUpdates, refreshStars } from "../lib/service.mjs";

const mkSoftware = (id, tag) => ({
  id, name: id, owner: id, repo: "r", stars: null, desc: null, // owner=id 便于测试区分
  cache: { total: 1, hasMore: false, releases: tag ? [{ tag }] : [] },
});

test("ghOpts: 收敛 token/proxy", () => {
  assert.deepEqual(ghOpts({ githubToken: "t", proxy: "p" }), { token: "t", proxy: "p" });
  assert.deepEqual(ghOpts({ githubToken: "", proxy: "" }), { token: "", proxy: "" });
});

test("checkUpdates: 有新版/无新版/失败 三态 + 顺带刷新 star", async () => {
  const data = { software: [
    mkSoftware("a", "v1"),          // 缓存 v1,云端 v2 → 有新版
    mkSoftware("b", "v9"),          // 缓存 v9,云端 v9 → 无新版
    mkSoftware("c", null),          // 无缓存 tag → 不判新(保持空)
  ] };
  const github = {
    fetchReleases: async ({ owner, repo }) => {
      if (repo === "r") return { ok: true, releases: [{ tag: repo === "a" ? "" : "v9" }] };
      return { ok: false, code: 404, message: "nope" };
    },
    fetchRepoInfo: async () => ({ ok: true, info: { stars: 42, desc: "自动简介" } }),
  };
  // 用 owner 区分: a 返回 v2,其余返回 v9
  github.fetchReleases = async ({ owner }) => ({
    ok: true, releases: [{ tag: owner === "a" ? "v2" : "v9" }],
  });
  const r = await checkUpdates(github, data);
  assert.deepEqual(r.hasNew, ["a"], "a 缓存 v1 vs 云端 v2 → 有新版");
  assert.deepEqual(r.failed, []);
  // 顺带刷新生效
  assert.equal(data.software[0].stars, 42);
  assert.equal(data.software[0].desc, "自动简介");
});

test("checkUpdates: 拉取失败进 failed 不中断", async () => {
  const data = { software: [mkSoftware("x", "v1"), mkSoftware("y", "v1")] };
  const github = {
    fetchReleases: async ({ owner }) => (owner === "x" ? { ok: false, code: 403, message: "rate" } : { ok: true, releases: [{ tag: "v2" }] }),
    fetchRepoInfo: async () => ({ ok: true, info: { stars: 1, desc: "d" } }),
  };
  const r = await checkUpdates(github, data);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].name, "x");
  assert.equal(r.failed[0].code, 403);
  assert.deepEqual(r.hasNew, ["y"]);
});

test("refreshStars: updated 计数 + 失败收集", async () => {
  const data = { software: [mkSoftware("a"), mkSoftware("b")] };
  const github = {
    fetchRepoInfo: async ({ owner }) => (owner === "a" ? { ok: true, info: { stars: 5, desc: "x" } } : { ok: false, code: 0, message: "net" }),
  };
  const r = await refreshStars(github, data);
  assert.equal(r.updated, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(data.software[0].stars, 5);
  assert.equal(data.software[1].stars, null, "失败不改值");
});
