// lib/service.mjs — 服务层:多步业务组合(server 路由只做 HTTP 编排)
// 职责:checkUpdates(全量更新检查)/ refreshStars(全量 star 采集) + GitHub 请求参数收敛
// 依赖:仅 store + 外部注入的 github 客户端(createServer deps,便于测试注入 fake)
import * as store from "./store.mjs";
import { sortReleasesByPublish } from "./github.mjs";

/** 收敛 GitHub 请求公共参数(与 settings 解耦,调用方只需 settings) */
export function ghOpts(settings) {
  return { token: settings.githubToken, proxy: settings.proxy };
}

/** 判断最新 release 是否较缓存有变化:tag 不同,或同 tag 但 updatedAt 变化(资产重传/重新发布) */
function changed(latest, cachedRel) {
  if (!cachedRel) return true;
  if (cachedRel.tag !== latest.tag) return true;
  return !!(cachedRel.updatedAt && latest.updatedAt && cachedRel.updatedAt !== latest.updatedAt);
}

/** 把最新 release 写到缓存头部(按 tag 去重),NEW 角标与卡片数据一步到位 */
function writeLatest(s, latest) {
  const rels = (s.cache?.releases || []).filter((x) => x.tag !== latest.tag);
  s.cache = { ...(s.cache || {}), releases: [latest, ...rels] };
  if (typeof s.cache.hasMore !== "boolean") s.cache.hasMore = false;
}

/**
 * 全量更新检查:逐仓库带 ETag 条件请求拉最新 5 条 release 并按发布时间取最新
 * (GitHub 列表不保证顺序,per_page=1 可能取到非最新发布;304 未变化不扣额度),
 * 发现新版直接写回缓存头部并标记 hasNew;顺带刷新 star/简介/推送日期(同样条件请求);
 * 按 x-ratelimit-remaining 提前熔断,剩余仓库如实记入 failed。
 * 返回 { hasNew:[id], failed:[{id,name,code,message}], remaining } */
export async function checkUpdates(github, data) {
  const settings = store.getSettings();
  const hasNew = [];
  const failed = [];
  let remaining = null;
  let dirty = false; // 有数据变更才写盘,避免全失败时无谓写盘(也降低 Windows 写锁触发概率)
  for (const s of data.software) {
    if (remaining !== null && remaining <= 0) {
      failed.push({ id: s.id, name: s.name, code: "rate_limit", message: "GitHub 配额已耗尽,停止继续检查" });
      continue;
    }
    const r = await github.fetchReleases({ owner: s.owner, repo: s.repo, page: 1, perPage: 5, etag: s.etag || "", ...ghOpts(settings) });
    if (r.meta && r.meta.remaining !== null) remaining = r.meta.remaining;
    if (r.ok && r.notModified) {
      // 304:无新版,不扣额度;顺带把新 etag 存下
      if (r.meta?.etag) { s.etag = r.meta.etag; dirty = true; }
    } else if (r.ok && r.releases && r.releases.length) {
      if (r.meta?.etag) { s.etag = r.meta.etag; dirty = true; }
      const latest = sortReleasesByPublish(r.releases)[0]; // 双保险:不信任上游顺序,取发布时间最新
      if (changed(latest, s.cache?.releases?.[0])) {
        hasNew.push(s.id);
        writeLatest(s, latest); // 关键:写回缓存,卡片立即显示最新版
        dirty = true;
      }
    } else {
      failed.push({ id: s.id, name: s.name, code: r.code || "", message: r.message || "" });
    }
    // 顺带刷新 star + 自动简介 + 推送日期(带 repoEtag 条件请求,304 免费;失败静默,不影响更新检查)
    const info = await github.fetchRepoInfo({ owner: s.owner, repo: s.repo, etag: s.repoEtag || "", ...ghOpts(settings) });
    if (info.meta && info.meta.remaining !== null) remaining = info.meta.remaining;
    if (info.ok && info.notModified) {
      if (info.meta?.etag) { s.repoEtag = info.meta.etag; dirty = true; }
    } else if (info.ok) {
      s.stars = info.info.stars ?? null;
      s.desc = info.info.desc ?? s.desc;
      s.pushedAt = info.info.pushedAt ?? s.pushedAt;
      if (info.meta?.etag) s.repoEtag = info.meta.etag;
      dirty = true; // 只要更新过推送日期/star/简介就必须落盘(不依赖 etag 是否存在)
    }
  }
  if (dirty) {
    try { store.save(); } catch (e) { /* 写盘失败降级:结果照常返回,前端可提示 */ }
  }
  return { hasNew, failed, remaining };
}

/** 全量刷新 star 数 + 自动简介 + 推送日期(串行,失败收集不中断;repoEtag 条件请求,304 免费)
 *  返回 { updated, failed:[{id,code,message}] } */
export async function refreshStars(github, data) {
  const settings = store.getSettings();
  let updated = 0;
  const failed = [];
  for (const s of data.software) {
    const r = await github.fetchRepoInfo({ owner: s.owner, repo: s.repo, etag: s.repoEtag || "", ...ghOpts(settings) });
    if (r.ok && r.notModified) {
      if (r.meta?.etag) s.repoEtag = r.meta.etag;
    } else if (r.ok) {
      s.stars = r.info.stars ?? null;
      s.desc = r.info.desc ?? s.desc;
      s.pushedAt = r.info.pushedAt ?? s.pushedAt;
      if (r.meta?.etag) s.repoEtag = r.meta.etag;
      updated++;
    } else {
      failed.push({ id: s.id, code: r.code || "", message: r.message || "" });
    }
  }
  if (updated) {
    try { store.save(); } catch (e) { /* 写盘失败降级:结果照常返回 */ }
  }
  return { updated, failed };
}
