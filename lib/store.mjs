// lib/store.mjs — data.json 持久化（单点封装）
// 数据目录:平台托管时 = CAP_STORAGE_DIR;独立运行 = ./cwd/.data
// 所有持久化数据走这里,不写代码目录。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function storageDir() {
  return process.env.CAP_STORAGE_DIR || path.join(process.cwd(), ".data");
}

const FILE = () => path.join(storageDir(), "data.json");

export const DEFAULT_SETTINGS = {
  githubToken: "",     // 可选 PAT(仅存本机)
  proxy: "",           // 可选,如 http://127.0.0.1:7890
  perPage: 3,          // 每次「加载更多」增量数
  assetFilter: "all",  // all | win | mac | linux
  webdavUrl: "",       // WebDAV 地址(云同步)
  webdavUser: "",      // WebDAV 用户名
  webdavPass: "",      // WebDAV 密码(仅存本机)
};

function defaults() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    software: [],
  };
}

let cache = null; // 内存缓存,避免每次请求读盘

export function load() {
  if (cache) return cache;
  const f = FILE();
  // 清理原子写遗留的临时文件(进程被杀可能残留)
  try { for (const n of fs.readdirSync(path.dirname(f))) if (n.startsWith(path.basename(f) + ".tmp-")) fs.rmSync(path.join(path.dirname(f), n), { force: true }); } catch {}
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    data = defaults();
  }
  // 合并默认(补缺失字段,保证结构稳定)
  const merged = {
    ...defaults(),
    ...data,
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    software: Array.isArray(data.software) ? data.software : [],
  };
  cache = merged;
  return cache;
}

/** 尽力而为的写盘:任何失败都不抛出(数据已在内存,下次 save 再落盘)。
 *  注意:避免 rmSync 目标文件——沙箱 safe-delete 会拦截删除并重定向,重定向失败会抛
 *  SAFE_DELETE_BULK_GUARD_ERROR 导致接口崩溃(如 WebDAV 同步)。降级链:
 *  直接写 → tmp+rename → copyFile 覆盖(tmp 残留,load 时清理) → 最后才删目标+rename(失败静默) */
export function save() {
  try {
    fs.mkdirSync(storageDir(), { recursive: true });
    const file = FILE();
    const content = JSON.stringify(load(), null, 2);
    try {
      fs.writeFileSync(file, content);
      return;
    } catch { /* 直接写被拒(锁/只读)→ 原子写 */ }
    const tmp = file + ".tmp-" + Date.now();
    try {
      fs.writeFileSync(tmp, content);
      try {
        fs.renameSync(tmp, file);
        return;
      } catch { /* rename 覆盖被拒 → copyFile 覆盖(不删除目标) */ }
      try {
        fs.copyFileSync(tmp, file);
        return;
      } catch { /* copyFile 也失败 → 最后手段 */ }
      try {
        fs.rmSync(file, { force: true });
        fs.renameSync(tmp, file);
      } catch { /* 全部失败:保留 tmp,静默降级(load 时清理 tmp) */ }
    } catch { /* tmp 写失败:静默 */ }
  } catch { /* mkdir 失败:静默 */ }
}

/** 平台恢复/重扫后数据目录可能变化,调用以重读 */
export function resetCache() {
  cache = null;
}

export function newId() {
  return randomUUID().slice(0, 8);
}

/** 查找软件,不存在返回 null */
export function find(id) {
  return load().software.find((s) => s.id === id) || null;
}

/** 新增软件;repoUrl 已由调用方解析为 {owner, repo} */
export function createSoftware({ name, owner, repo, category, note }) {
  const data = load();
  if (data.software.some((s) => s.owner === owner && s.repo === repo)) {
    return { ok: false, code: "duplicate", message: "该仓库已在清单中" };
  }
  const item = {
    id: newId(),
    name: name.trim() || `${owner}/${repo}`,
    owner,
    repo,
    category: (category || "未分类").trim(),
    note: (note || "").trim(),
    pushedAt: null,       // 仓库最后推送时间(采集时写入,卡片"推送日期"数据源)
    desc: null,           // 自动获取的 GitHub 仓库描述(采集时写入)
    createdAt: Date.now(),
    stars: null,
    etag: null,           // 更新检测条件请求缓存(per_page=5&page=1 的 etag,304 不扣额度)
    repoEtag: null,       // 仓库信息条件请求缓存(/repos/o/r 的 etag)
    cache: { total: null, releases: [] },
  };
  data.software.unshift(item);
  save();
  return { ok: true, item };
}

export function updateSoftware(id, patch) {
  const item = find(id);
  if (!item) return { ok: false, code: "notfound", message: "软件不存在" };
  if (patch.name !== undefined) item.name = patch.name.trim() || item.name;
  if (patch.category !== undefined) item.category = (patch.category || "未分类").trim();
  if (patch.note !== undefined) item.note = (patch.note || "").trim();
  save();
  return { ok: true, item };
}

export function deleteSoftware(id) {
  const data = load();
  const i = data.software.findIndex((s) => s.id === id);
  if (i < 0) return { ok: false, code: "notfound", message: "软件不存在" };
  data.software.splice(i, 1);
  save();
  return { ok: true };
}

export function getSettings() {
  return load().settings;
}

export function updateSettings(patch) {
  const s = load().settings;
  if (patch.githubToken !== undefined) s.githubToken = String(patch.githubToken || "");
  if (patch.proxy !== undefined) s.proxy = String(patch.proxy || "").trim();
  if (patch.perPage !== undefined) {
    const n = Math.min(50, Math.max(1, parseInt(patch.perPage, 10) || 3));
    s.perPage = n;
  }
  if (patch.assetFilter !== undefined) {
    s.assetFilter = ["all", "win", "mac", "linux"].includes(patch.assetFilter)
      ? patch.assetFilter
      : "all";
  }
  if (patch.webdavUrl !== undefined) s.webdavUrl = String(patch.webdavUrl || "").trim();
  if (patch.webdavUser !== undefined) s.webdavUser = String(patch.webdavUser || "").trim();
  if (patch.webdavPass !== undefined) s.webdavPass = String(patch.webdavPass || "");
  save();
  return { ok: true, settings: s };
}
