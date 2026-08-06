// test/store.test.mjs — lib/store.mjs CRUD 单测(隔离临时数据目录)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../lib/store.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghrc-test-"));
process.env.CAP_STORAGE_DIR = tmpDir;
store.resetCache();

test("默认设置与空清单", () => {
  const data = store.load();
  assert.equal(data.version, 1);
  assert.equal(data.software.length, 0);
  assert.equal(data.settings.perPage, 3);
});

test("新增软件 → 查重 → 更新 → 删除", () => {
  const r1 = store.createSoftware({ name: "Tools Center", owner: "Simiely", repo: "tools-center", category: "平台", note: "" });
  assert.equal(r1.ok, true);
  const id = r1.item.id;

  // 重复仓库被拒
  const dup = store.createSoftware({ name: "x", owner: "Simiely", repo: "tools-center", category: "", note: "" });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, "duplicate");

  // 找到
  assert.ok(store.find(id));

  // 更新
  const u = store.updateSoftware(id, { name: "TC", category: "平台工具", note: "备注" });
  assert.equal(u.ok, true);
  assert.equal(store.find(id).name, "TC");
  assert.equal(store.find(id).note, "备注");

  // 删除
  assert.equal(store.deleteSoftware(id).ok, true);
  assert.equal(store.find(id), null);
  assert.equal(store.deleteSoftware(id).ok, false); // 再删报 notfound
});

test("设置读写与非法值兜底", () => {
  store.updateSettings({ githubToken: "ghp_xxx", proxy: "http://127.0.0.1:7890", perPage: 5, assetFilter: "win" });
  let s = store.getSettings();
  assert.equal(s.githubToken, "ghp_xxx");
  assert.equal(s.proxy, "http://127.0.0.1:7890");
  assert.equal(s.perPage, 5);
  assert.equal(s.assetFilter, "win");

  // 非法 perPage / assetFilter 兜底
  store.updateSettings({ perPage: 9999, assetFilter: "weird" });
  s = store.getSettings();
  assert.equal(s.perPage, 50);
  assert.equal(s.assetFilter, "all");
});

test("数据落盘可重读", () => {
  store.createSoftware({ name: "A", owner: "o", repo: "r", category: "", note: "" });
  store.resetCache();
  const data = store.load();
  assert.equal(data.software.length, 1);
  assert.equal(data.software[0].name, "A");
});
