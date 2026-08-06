// lib/service.mjs — 服务层:多步业务组合(server 路由只做 HTTP 编排)
// 职责:checkUpdates(全量更新检查)/ refreshStars(全量 star 采集) + GitHub 请求参数收敛
// 依赖:仅 store + 外部注入的 github 客户端(createServer deps,便于测试注入 fake)
import * as store from "./store.mjs";

/** 收敛 GitHub 请求公共参数(与 settings 解耦,调用方只需 settings) */
export function ghOpts(settings) {
  return { token: settings.githubToken, proxy: settings.proxy };
}

/** 全量更新检查:逐仓库拉最新 release 对比缓存首条 tag;顺带刷新 star/简介
 *  返回 { hasNew:[id], failed:[{id,name,code,message}] } */
export async function checkUpdates(github, data) {
  const settings = store.getSettings();
  const hasNew = [];
  const failed = [];
  for (const s of data.software) {
    const r = await github.fetchReleases({ owner: s.owner, repo: s.repo, page: 1, perPage: 1, ...ghOpts(settings) });
    if (r.ok && r.releases.length) {
      const cached = s.cache?.releases?.[0]?.tag;
      if (cached && cached !== r.releases[0].tag) hasNew.push(s.id);
    } else {
      failed.push({ id: s.id, name: s.name, code: r.code || "", message: r.message || "" });
    }
    // 顺带刷新 star + 自动简介 + 推送日期(失败静默,不影响更新检查)
    const info = await github.fetchRepoInfo({ owner: s.owner, repo: s.repo, ...ghOpts(settings) });
    if (info.ok) { s.stars = info.info.stars ?? null; s.desc = info.info.desc ?? s.desc; s.pushedAt = info.info.pushedAt ?? s.pushedAt; }
  }
  store.save();
  return { hasNew, failed };
}

/** 全量刷新 star 数 + 自动简介(串行,失败收集不中断)
 *  返回 { updated, failed:[{id,code,message}] } */
export async function refreshStars(github, data) {
  const settings = store.getSettings();
  let updated = 0;
  const failed = [];
  for (const s of data.software) {
    const r = await github.fetchRepoInfo({ owner: s.owner, repo: s.repo, ...ghOpts(settings) });
    if (r.ok) { s.stars = r.info.stars ?? null; s.desc = r.info.desc ?? s.desc; s.pushedAt = r.info.pushedAt ?? s.pushedAt; updated++; }
    else failed.push({ id: s.id, code: r.code || "", message: r.message || "" });
  }
  if (updated) store.save();
  return { updated, failed };
}
