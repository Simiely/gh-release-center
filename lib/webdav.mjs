// lib/webdav.mjs — WebDAV 协议客户端(零依赖:PROPFIND/MKCOL/PUT/GET/DELETE + Basic 认证)
// 交互范式参考 edge-multi-account-cookie:
//   - 远端多版本时间戳备份(ghrc-backup-YYYYMMDDHHMMSS.json)+ 保留最近 keep 份
//   - 下载自动选"最新且可用"的备份,损坏文件自动跳过
//   - 401/403 统一归一为"认证失败,请检查用户名/密码"
// 用途:软件清单云同步——「一键同步」先拉后传双向收敛(只增不删)

export const DEFAULT_WEBDAV_URL = "http://192.168.2.1:6086/";
// 云端目录(与旧版一致,兼容历史 data.json)
export const BACKUP_DIR = "workbuddy/github下载";
export const BACKUP_PREFIX = "ghrc-backup-";
export const BACKUP_EXT = ".json";
export const DEFAULT_KEEP = 1;

const AUTH = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const baseOf = (base) => String(base || "").replace(/\/+$/, "");
const encSeg = (seg) => encodeURIComponent(seg);
const encPath = (p) => String(p).split("/").filter(Boolean).map(encSeg).join("/");
const fileUrl = (base, dir, file) => `${baseOf(base)}/${encPath(dir)}/${encSeg(file)}`;
const dirUrl = (base, dir) => `${baseOf(base)}/${encPath(dir)}/`;

/** 归一化 WebDAV URL:仅去空白;留空用默认服务器 */
export function normalizeUrl(url) {
  const t = String(url || "").trim();
  return t || DEFAULT_WEBDAV_URL;
}

/** 校验 URL 是否为 http(s) 的 WebDAV 地址 */
export function isValidUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

async function req(method, url, user, pass, body, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    return await fetch(url, {
      method,
      headers: { Authorization: AUTH(user, pass), ...headers },
      body,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "WebDAV 请求超时(15s)" : "网络错误: " + e.message);
  } finally {
    clearTimeout(t);
  }
}

function checkAuth(res) {
  if (res.status === 401 || res.status === 403) throw new Error("认证失败，请检查用户名/密码");
}

/** 确保远端目录存在:PROPFIND(Depth:0) 探测 → 404 则 MKCOL(逐级,只建一层) */
export async function ensureDir(base, user, pass, dir) {
  const baseUrl = baseOf(base);
  let acc = "";
  for (const seg of String(dir).split("/").filter(Boolean)) {
    acc += "/" + encSeg(seg);
    const url = baseUrl + acc + "/";
    const probe = await req("PROPFIND", url, user, pass, undefined, { Depth: "0" });
    checkAuth(probe);
    if (probe.status !== 404) continue; // 200/207/405 = 已存在
    const mk = await req("MKCOL", url, user, pass);
    checkAuth(mk);
    if (![200, 201, 301, 405].includes(mk.status)) throw new Error("创建目录失败(HTTP " + mk.status + ")");
  }
}

/** 列目录(Depth:1),解析 href 返回文件名数组;目录不存在返回 [] */
export async function webdavList(base, user, pass, dir) {
  const r = await req("PROPFIND", dirUrl(base, dir), user, pass, undefined, { Depth: "1" });
  checkAuth(r);
  if (r.status === 404) return [];
  if (r.status !== 207) throw new Error("列目录失败(HTTP " + r.status + ")");
  const text = await r.text();
  const names = [];
  const re = /<[a-zA-Z0-9_-]*:?href[^>]*>([^<]+)<\/[a-zA-Z0-9_-]*:?href>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const href = decodeURIComponent(m[1]).replace(/^https?:\/\/[^/]+/i, "");
    const name = href.split("/").filter(Boolean).pop();
    if (name && name !== ".") names.push(name);
  }
  return names;
}

/** 测试连接:确保同步目录可创建 + 列目录,返回项目数 */
export async function testConnection(base, user, pass, dir = BACKUP_DIR) {
  await ensureDir(base, user, pass, dir);
  const names = await webdavList(base, user, pass, dir);
  return { ok: true, count: names.length };
}

/** 当前 UTC 时间戳备份文件名:ghrc-backup-YYYYMMDDHHMMSS.json(定宽,字典序=时间序) */
export function backupFilename(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${BACKUP_PREFIX}${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}${BACKUP_EXT}`;
}

/** 从备份文件名解析 UTC 时间戳(失败返回 0),用于选最新 */
export function parseBackupStamp(filename) {
  const m = String(filename || "").match(/(\d{14})/);
  if (!m) return 0;
  const s = m[1];
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
}

/** 列出全部时间戳备份文件名(升序=旧→新) */
export async function listBackups(base, user, pass, dir = BACKUP_DIR) {
  const files = await webdavList(base, user, pass, dir);
  return files.filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_EXT)).sort();
}

/** 上传备份:时间戳文件名 + 远端保留最近 keep 份(清理失败不阻断上传)。
 *  filename 可选(测试注入),默认当前 UTC 时间戳 */
export async function pushBackup(base, user, pass, dir, content, keep = DEFAULT_KEEP, filename = backupFilename()) {
  await ensureDir(base, user, pass, dir);
  const r = await req("PUT", fileUrl(base, dir, filename), user, pass, content, { "Content-Type": "application/json" });
  checkAuth(r);
  if (![200, 201, 204].includes(r.status)) throw new Error("上传失败(HTTP " + r.status + ")");
  try {
    const backups = await listBackups(base, user, pass, dir);
    while (backups.length > keep) {
      const old = backups.shift();
      await req("DELETE", fileUrl(base, dir, old), user, pass);
    }
  } catch { /* 清理失败不阻断上传成功 */ }
  return { filename };
}

/** 下载"最新且可用"的备份:从最新往前逐个取,JSON 损坏自动跳过;
 *  兼容旧版固定文件 data.json(无新备份时作为兜底)。返回 { filename, content, totalBackups } */
export async function pullLatest(base, user, pass, dir = BACKUP_DIR) {
  const files = await webdavList(base, user, pass, dir);
  const backups = files.filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_EXT)).sort().reverse(); // 新 → 旧
  const candidates = backups.length ? backups : files.includes("data.json") ? ["data.json"] : [];
  if (!candidates.length) throw new Error("远端没有备份文件");
  for (const name of candidates) {
    try {
      const r = await req("GET", fileUrl(base, dir, name), user, pass);
      checkAuth(r);
      if (!r.ok) continue;
      const content = await r.text();
      try { JSON.parse(content); } catch { continue; } // 损坏文件跳过
      return { filename: name, content, totalBackups: candidates.length };
    } catch (e) {
      if (e && e.message && e.message.includes("认证失败")) throw e;
      continue;
    }
  }
  throw new Error("远端备份均不可用");
}
