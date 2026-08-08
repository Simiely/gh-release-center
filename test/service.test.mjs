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

test("checkUpdates: 有新版/无新版/首次发布 三态 + 顺带刷新 star", async () => {
  const data = { software: [
    mkSoftware("a", "v1"),          // 缓存 v1,云端 v2 → 有新版
    mkSoftware("b", "v9"),          // 缓存 v9,云端 v9 → 无新版
    mkSoftware("c", null),          // 无缓存,云端有首个 release → 判新并写回
  ] };
  const github = {
    fetchReleases: async ({ owner }) => ({
      ok: true, releases: [{ tag: owner === "a" ? "v2" : "v9" }],
    }),
    fetchRepoInfo: async () => ({ ok: true, info: { stars: 42, desc: "自动简介" } }),
  };
  const r = await checkUpdates(github, data);
  assert.deepEqual(r.hasNew, ["a", "c"], "a 缓存 v1 vs 云端 v2 → 有新版;c 首个 release → 判新");
  assert.deepEqual(r.failed, []);
  // 顺带刷新生效
  assert.equal(data.software[0].stars, 42);
  assert.equal(data.software[0].desc, "自动简介");
  // 首次发布写回缓存
  assert.equal(data.software[2].cache.releases[0].tag, "v9");
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

test("checkUpdates: 顺带采集推送日期(pushedAt)", async () => {
  const data = { software: [mkSoftware("a", "v1")] };
  const github = {
    fetchReleases: async () => ({ ok: true, releases: [{ tag: "v1" }] }),
    fetchRepoInfo: async () => ({ ok: true, info: { stars: 1, desc: "d", pushedAt: "2026-08-01T00:00:00Z" } }),
  };
  await checkUpdates(github, data);
  assert.equal(data.software[0].pushedAt, "2026-08-01T00:00:00Z", "采集 pushedAt");
});

test("checkUpdates: 发现新版直接写回缓存头部(NEW 与数据一步到位)", async () => {
  const data = { software: [mkSoftware("a", "v1")] };
  const github = {
    fetchReleases: async () => ({ ok: true, releases: [{ tag: "v2", publishedAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" }] }),
    fetchRepoInfo: async () => ({ ok: true, info: { stars: 1, desc: "d", pushedAt: "2026-08-01T00:00:00Z" } }),
  };
  const r = await checkUpdates(github, data);
  assert.deepEqual(r.hasNew, ["a"]);
  const rels = data.software[0].cache.releases;
  assert.equal(rels[0].tag, "v2", "新 release 写回缓存头部,卡片立即显示最新");
  assert.equal(rels.length, 2, "旧版本保留在下方");
  assert.equal(rels[1].tag, "v1");
});

test("checkUpdates: 304 未变化不判新、不失败,并保存新 etag", async () => {
  const data = { software: [mkSoftware("a", "v1")] };
  let etagSent = null;
  const github = {
    fetchReleases: async ({ etag }) => {
      etagSent = etag;
      return { ok: true, notModified: true, meta: { etag: "etag-v1-new", remaining: 58 } };
    },
    fetchRepoInfo: async () => ({ ok: true, info: { stars: 1, desc: "d" } }),
  };
  const r = await checkUpdates(github, data);
  assert.equal(etagSent, "", "首次检查无 etag,走全量请求");
  assert.deepEqual(r.hasNew, []);
  assert.deepEqual(r.failed, []);
  assert.equal(data.software[0].etag, "etag-v1-new", "保存 etag 供下次条件请求(304 免费)");
});

test("checkUpdates: 额度耗尽提前熔断,剩余仓库如实上报", async () => {
  const data = { software: [mkSoftware("a", "v1"), mkSoftware("b", "v1")] };
  let n = 0;
  const github = {
    fetchReleases: async () => {
      n++;
      return { ok: true, releases: [{ tag: "v1" }], meta: { remaining: n === 1 ? 0 : 0 } };
    },
    fetchRepoInfo: async () => ({ ok: true, info: { stars: 1, desc: "d" }, meta: { remaining: 0 } }),
  };
  const r = await checkUpdates(github, data);
  assert.deepEqual(r.hasNew, []);
  assert.equal(r.failed.length, 1, "第二个仓库因配额耗尽被熔断");
  assert.equal(r.failed[0].name, "b");
  assert.equal(r.failed[0].code, "rate_limit");
});

test("refreshStars: 304 未变化不计 updated,保存 repoEtag", async () => {
  const data = { software: [mkSoftware("a")] };
  const github = { fetchRepoInfo: async () => ({ ok: true, notModified: true, meta: { etag: "repo-e1" } }) };
  const r = await refreshStars(github, data);
  assert.equal(r.updated, 0);
  assert.equal(data.software[0].repoEtag, "repo-e1");
});

test("checkUpdates: API 乱序返回时按发布时间取真正最新版(不信列表顺序)", async () => {
  const data = { software: [mkSoftware("a", "v1")] };
  const github = {
    // 模拟 GitHub 列表乱序:发布时间最新的 v2.0 排在第二位,旧版 v1.5 反而在首位
    fetchReleases: async () => ({
      ok: true,
      releases: [
        { tag: "v1.5", publishedAt: "2026-01-20T00:00:00Z", updatedAt: "2026-01-20T00:00:00Z" },
        { tag: "v2.0", publishedAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      ],
    }),
    fetchRepoInfo: async () => ({ ok: true, info: { stars: 1, desc: "d" } }),
  };
  const r = await checkUpdates(github, data);
  assert.deepEqual(r.hasNew, ["a"], "应判 v2.0 为新版");
  assert.equal(data.software[0].cache.releases[0].tag, "v2.0", "写回的是真正最新发布的 v2.0,而非列表首位的 v1.5");
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
