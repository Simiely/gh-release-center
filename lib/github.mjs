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
 * @param {object} opts { token, proxy, timeout }
 * @returns {Promise<{ok:true, data:any, headers:object}|{ok:false, code:string, message:string, status?:number}>}
 */
export function requestJson(apiPath, opts = {}) {
  const { token = "", proxy = "", timeout = REQ_TIMEOUT } = opts;
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
      if (s >= 200 && s < 300) {
        resolve({ ok: true, data: json, headers: res.headers });
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

/** 拉取某仓库第 page 页 release(per_page 个) */
export async function fetchReleases({ owner, repo, page, perPage, token, proxy }) {
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${perPage}&page=${page}`;
  const r = await requestJson(apiPath, { token, proxy });
  if (!r.ok) return r;
  const releases = Array.isArray(r.data) ? r.data.map(normalizeRelease) : [];
  return {
    ok: true,
    releases,
    hasMore: hasNextPage(r.headers.link || ""),
  };
}

/** 拉取仓库基本信息(新增软件时校验仓库存在 + 拿默认名) */
export async function fetchRepoInfo({ owner, repo, token, proxy }) {
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const r = await requestJson(apiPath, { token, proxy });
  if (!r.ok) return r;
  return { ok: true, info: { fullName: r.data.full_name, desc: r.data.description, private: r.data.private } };
}
