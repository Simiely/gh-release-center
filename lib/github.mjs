// lib/github.mjs — GitHub API 客户端(零依赖)
// 核心能力:可选 HTTP 代理(CONNECT 隧道) / Bearer Token / 分页 / 错误归一化。
// 所有 GitHub 请求必须走 requestJson(),禁止散用 fetch(原生 fetch 不走代理)。
import http from "node:http";
import https from "node:https";

const API_HOST = "api.github.com";
const API_PORT = 443;
const REQ_TIMEOUT = 15000; // 单请求超时 15s

/** 解析仓库输入 → { owner, repo } | null。
 *  支持: owner/repo、https://github.com/owner/repo、github.com/owner/repo */
export function parseRepoUrl(input) {
  if (!input || typeof input !== "string") return null;
  const s = input.trim();
  let m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) m = s.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

/** 按文件名判断资产所属平台(明确扩展名优先;tar.gz 等通用压缩包按关键字) */
export function detectPlatform(name) {
  const n = (name || "").toLowerCase();
  if (/\.(exe|msi)$/.test(n)) return "win";
  if (/\.(dmg|pkg)$/.test(n)) return "mac";
  if (/\.(appimage|deb|rpm)$/.test(n)) return "linux";
  if (/win|windows/.test(n)) return "win";
  if (/mac|macos|osx|darwin/.test(n)) return "mac";
  if (/linux|ubuntu|debian/.test(n)) return "linux";
  return "other";
}

/** 从响应头提取速率元信息(etag + 限速余量),供条件请求与熔断使用 */
function metaOf(headers) {
  return {
    etag: headers && headers.etag ? String(headers.etag) : "",
    remaining:
      headers && headers["x-ratelimit-remaining"] !== undefined
        ? parseInt(headers["x-ratelimit-remaining"], 10)
        : null,
    reset:
      headers && headers["x-ratelimit-reset"] !== undefined
        ? parseInt(headers["x-ratelimit-reset"], 10)
        : null,
    limit:
      headers && headers["x-ratelimit-limit"] !== undefined
        ? parseInt(headers["x-ratelimit-limit"], 10)
        : null,
  };
}

function fmtSize(n) {
  if (!n) return "";
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + " KB";
  return n + " B";
}

/** 归一化一条 release 记录(平台响应 → 前端所需) */
export function normalizeRelease(r) {
  return {
    tag: r.tag_name || "",
    name: r.name || r.tag_name || "",
    publishedAt: r.published_at || r.created_at || "",
    updatedAt: r.updated_at || r.published_at || r.created_at || "",
    prerelease: !!r.prerelease,
    assets: (r.assets || []).map((a) => ({
      name: a.name,
      size: a.size,
      sizeText: fmtSize(a.size),
      downloads: a.download_count || 0,
      url: a.browser_download_url,
      platform: detectPlatform(a.name),
    })),
  };
}

/** 从 Link 响应头解析总页数 / 是否有下一页 */
export function hasNextPage(linkHeader) {
  return !!(linkHeader && /rel="next"/.test(linkHeader));
}

/**
 * GET api.github.com 上的一条 JSON 路径。
 * @param {string} apiPath 如 /repos/o/r/releases?per_page=3&page=1
 * @param {object} opts { token, proxy, timeout, etag } — etag 走 If-None-Match 条件请求,未变化返回 304(不计额度)
 * @returns {Promise<{ok:true, data:any, headers:object, meta:object}|{ok:true, notModified:true, meta:object}|{ok:false, code:string, message:string, status?:number}>}
 */
export function requestJson(apiPath, opts = {}) {
  const { token = "", proxy = "", timeout = REQ_TIMEOUT, etag = "" } = opts;
  return new Promise((resolve) => {
    const reqOpts = {
      host: API_HOST,
      port: API_PORT,
      path: apiPath,
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "gh-release-center/0.1",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(etag ? { "If-None-Match": etag } : {}),
      },
    };

    // 代理:建立 CONNECT 隧道,把裸 socket 交给 https
    if (proxy) {
      const p = /^https?:\/\//.test(proxy) ? proxy : `http://${proxy}`;
      const pu = new URL(p);
      const proxyReq = http.request({
        host: pu.hostname,
        port: pu.port || 80,
        method: "CONNECT",
        path: `${API_HOST}:${API_PORT}`,
        headers: { Host: `${API_HOST}:${API_PORT}` },
      });
      proxyReq.on("connect", (_res, socket) => {
        reqOpts.createConnection = () => socket;
        doHttps(reqOpts, timeout, resolve);
      });
      proxyReq.on("error", (e) =>
        resolve({ ok: false, code: "proxy_error", message: `代理连接失败: ${e.message}` })
      );
      proxyReq.setTimeout(timeout, () => proxyReq.destroy(new Error("proxy timeout")));
      proxyReq.end();
      return;
    }
    doHttps(reqOpts, timeout, resolve);
  });
}

function doHttps(reqOpts, timeout, resolve) {
  const req = https.request(reqOpts, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let json = null;
      try { json = JSON.parse(body); } catch { /* 非 JSON */ }
      const s = res.statusCode || 0;
      if (s === 304) {
        // 条件请求未变化:不计入主速率限制
        resolve({ ok: true, notModified: true, headers: res.headers, meta: metaOf(res.headers) });
        return;
      }
      if (s >= 200 && s < 300) {
        resolve({ ok: true, data: json, headers: res.headers, meta: metaOf(res.headers) });
        return;
      }
      // 错误归一化
      const ghMsg =
        json && json.message ? String(json.message) : `HTTP ${s}`;
      if (s === 404) resolve({ ok: false, code: "not_found", message: `仓库或资源不存在(404)`, status: s });
      else if (s === 403 || s === 429) resolve({ ok: false, code: "rate_limit", message: `请求受限(${s}): ${ghMsg}`, status: s });
      else if (s === 401) resolve({ ok: false, code: "bad_token", message: `Token 无效(401): ${ghMsg}`, status: s });
      else resolve({ ok: false, code: "http_error", message: `GitHub 返回 ${s}: ${ghMsg}`, status: s });
    });
  });
  req.on("error", (e) =>
    resolve({ ok: false, code: "network", message: `网络错误: ${e.message}` })
  );
  req.setTimeout(timeout, () => {
    req.destroy(new Error("request timeout"));
  });
  req.end();
}

/**
 * 按发布时间(published_at)降序排列 release——GitHub 列表接口不保证返回顺序
 * (排序受 tag 的 commit 日期 / SemVer / make_latest 标记影响),"最新版"必须自己排。
 * 时间相同(如自动发布批量打 tag)时保持稳定,不影响结果。
 */
export function sortReleasesByPublish(releases) {
  return [...releases].sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
}

/** 拉取某仓库第 page 页 release(per_page 个)。etag 传入上次响应的 etag,未变化时返回 notModified=true(304,不扣额度) */
export async function fetchReleases({ owner, repo, page, perPage, token, proxy, etag }) {
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${perPage}&page=${page}`;
  const r = await requestJson(apiPath, { token, proxy, etag });
  if (!r.ok) return r;
  if (r.notModified) return { ok: true, notModified: true, meta: r.meta };
  const releases = sortReleasesByPublish(Array.isArray(r.data) ? r.data.map(normalizeRelease) : []);
  return {
    ok: true,
    releases,
    hasMore: hasNextPage(r.headers.link || ""),
    meta: r.meta,
  };
}

/** 拉取仓库基本信息(新增软件时校验仓库存在 + 拿默认名)。etag 同上,未变化返回 notModified */
export async function fetchRepoInfo({ owner, repo, token, proxy, etag }) {
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const r = await requestJson(apiPath, { token, proxy, etag });
  if (!r.ok) return r;
  if (r.notModified) return { ok: true, notModified: true, meta: r.meta };
  return {
    ok: true,
    info: { fullName: r.data.full_name, desc: r.data.description, private: r.data.private, stars: r.data.stargazers_count ?? null, pushedAt: r.data.pushed_at || null },
    meta: r.meta,
  };
}

/** POST GraphQL 查询(GraphQL 必须带 token;走代理隧道;错误归一化) */
function requestGQL(query, { token = "", proxy = "", timeout = REQ_TIMEOUT }) {
  if (!token) return Promise.resolve({ ok: false, code: "no_token", message: "GraphQL 需要 GitHub Token" });
  const body = JSON.stringify({ query });
  const reqOpts = {
    host: API_HOST,
    port: API_PORT,
    path: "/graphql",
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "User-Agent": "gh-release-center/0.1",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Length": Buffer.byteLength(body),
    },
  };
  return new Promise((resolve) => {
    const done = (reqOpts2) => {
      const req = https.request(reqOpts2, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON */ }
          const s = res.statusCode || 0;
          const meta = metaOf(res.headers);
          if (s >= 200 && s < 300) {
            const d = json && json.data ? json.data : {};
            const errs = json && Array.isArray(json.errors) ? json.errors : [];
            if (errs.length && Object.keys(d).length === 0)
              return resolve({ ok: false, code: "graphql_error", message: `GraphQL 错误: ${errs[0].message || ""}`, meta });
            return resolve({ ok: true, data: d, errors: errs, meta });
          }
          const ghMsg = json && json.message ? String(json.message) : `HTTP ${s}`;
          if (s === 403 || s === 429) resolve({ ok: false, code: "rate_limit", message: `请求受限(${s}): ${ghMsg}`, meta, status: s });
          else if (s === 401) resolve({ ok: false, code: "bad_token", message: `Token 无效(401): ${ghMsg}`, status: s });
          else resolve({ ok: false, code: "http_error", message: `GraphQL 返回 ${s}: ${ghMsg}`, status: s });
        });
      });
      req.on("error", (e) => resolve({ ok: false, code: "network", message: `网络错误: ${e.message}` }));
      req.setTimeout(timeout, () => req.destroy(new Error("request timeout")));
      req.end(body);
    };
    if (proxy) {
      const p = /^https?:\/\//.test(proxy) ? proxy : `http://${proxy}`;
      const pu = new URL(p);
      const proxyReq = http.request({
        host: pu.hostname,
        port: pu.port || 80,
        method: "CONNECT",
        path: `${API_HOST}:${API_PORT}`,
        headers: { Host: `${API_HOST}:${API_PORT}` },
      });
      proxyReq.on("connect", (_res, socket) => done({ ...reqOpts, createConnection: () => socket }));
      proxyReq.on("error", (e) => resolve({ ok: false, code: "proxy_error", message: `代理连接失败: ${e.message}` }));
      proxyReq.setTimeout(timeout, () => proxyReq.destroy(new Error("proxy timeout")));
      proxyReq.end();
      return;
    }
    done(reqOpts);
  });
}

/** GraphQL aliases 批量查仓库信息(有 token):一次请求最多 BATCH 个仓库的 pushedAt/star/简介。
 *  返回 { ok:true, repos:{"owner/repo":{pushedAt,stars,desc}}, meta };无 token 返回 no_token(调用方退化逐个 REST) */
export async function fetchReposBatch({ repos = [], token = "", proxy = "" }) {
  const BATCH = 50;
  const out = {};
  let meta = null;
  for (let i = 0; i < repos.length; i += BATCH) {
    const slice = repos.slice(i, i + BATCH);
    const query = `query { ${slice
      .map((r, j) => `r${j}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) { pushedAt stargazerCount description }`)
      .join(" ")} }`;
    const r = await requestGQL(query, { token, proxy });
    if (!r.ok) return r;
    meta = r.meta;
    const d = r.data || {};
    slice.forEach((r2, j) => {
      const node = d[`r${j}`];
      if (node) out[r2.owner + "/" + r2.repo] = { pushedAt: node.pushedAt || "", stars: node.stargazerCount ?? null, desc: node.description || "" };
    });
    if (r.meta && r.meta.remaining !== null && r.meta.remaining <= 0) break; // 限速熔断
  }
  return { ok: true, repos: out, meta };
}
