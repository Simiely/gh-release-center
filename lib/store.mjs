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

export function save() {
  fs.mkdirSync(storageDir(), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(load(), null, 2));
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
    createdAt: Date.now(),
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
  save();
  return { ok: true, settings: s };
}
