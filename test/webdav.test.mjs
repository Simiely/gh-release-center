// test/webdav.test.mjs — WebDAV 协议客户端集成测试(本地 mock 服务器)
// 验证:PROPFIND 探测/MKCOL 建目录/PUT 时间戳备份/保留策略/DELETE 清理/
//      pull 选最新(损坏跳过)/旧版 data.json 兜底/认证失败归一化/中文目录编码
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  testConnection, pushBackup, pullLatest, webdavList,
  backupFilename, parseBackupStamp, normalizeUrl, isValidUrl,
} from "../lib/webdav.mjs";

// ---- mock WebDAV 服务器:内存目录树(url → {content|isDir}) ----
const seen = [];
const tree = new Map(); // key: 路径(已编码), value: { isDir } | { content }
let authFail = false;

function mount(server) {
  server.on("request", (req, res) => {
    seen.push(req.method + " " + req.url);
    const key = req.url.split("?")[0];
    if (authFail) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' }); res.end(); return; }
    if (req.method === "PROPFIND") {
      const node = tree.get(key);
      if (!node || !node.isDir) { res.writeHead(404); res.end(); return; }
      // Depth:1 → 目录下所有条目 href
      const items = [...tree.keys()].filter((k) => k.startsWith(key) && k !== key);
      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(
        '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
        items.map((k) => `<D:response><D:href>${k}</D:href></D:response>`).join("") +
        "</D:multistatus>"
      );
      return;
    }
    if (req.method === "MKCOL") { tree.set(key, { isDir: true }); res.writeHead(201); res.end(); return; }
    if (req.method === "PUT") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { tree.set(key, { content: b }); res.writeHead(201); res.end(); });
      return;
    }
    if (req.method === "GET") {
      const node = tree.get(key);
      if (!node || node.isDir || node.content === undefined) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(node.content); return;
    }
    if (req.method === "DELETE") { tree.delete(key); res.writeHead(204); res.end(); return; }
    res.writeHead(405); res.end();
  });
}

const mock = http.createServer();
mount(mock);
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${mock.address().port}`;
const DIR = "workbuddy/github下载";
const DIR_ENC = "/workbuddy/github%E4%B8%8B%E8%BD%BD";

function reset() {
  seen.length = 0;
  tree.clear();
  authFail = false;
}

function putFile(path, content) { tree.set(path, { content }); }

test("backupFilename/parseBackupStamp: 定宽 UTC 时间戳", () => {
  const f = backupFilename(new Date(Date.UTC(2026, 7, 8, 9, 40, 30)));
  assert.equal(f, "ghrc-backup-20260808094030.json");
  assert.equal(parseBackupStamp("ghrc-backup-20260808094030.json"), Date.UTC(2026, 7, 8, 9, 40, 30));
  assert.equal(parseBackupStamp("abc"), 0);
});

test("normalizeUrl/isValidUrl: 默认地址与格式校验", () => {
  assert.equal(normalizeUrl(""), "http://192.168.2.1:6086/");
  assert.equal(normalizeUrl("  https://dav.example.com/dav/  "), "https://dav.example.com/dav/");
  assert.equal(isValidUrl("https://dav.example.com"), true);
  assert.equal(isValidUrl("ftp://x.com"), false);
  assert.equal(isValidUrl("not a url"), false);
});

test("webdav: 全链路(PROPFIND 探测/MKCOL/PUT 时间戳备份/保留策略/DELETE/pull 选最新)", async () => {
  reset();

  // 测试连接:目录不存在 → PROPFIND 404 → 逐级 MKCOL;再列目录得 count
  const t = await testConnection(BASE, "u", "p", DIR);
  assert.equal(t.ok, true);
  assert.equal(t.count, 0);
  assert.ok(seen.includes("MKCOL /workbuddy/"), "逐级建 workbuddy,实际: " + JSON.stringify(seen));
  assert.ok(seen.includes("MKCOL " + DIR_ENC + "/"), "中文目录 URL 编码,实际: " + JSON.stringify(seen));

  // push 两次(不同文件名)→ 保留策略只留最近 1 份 → 旧文件被 DELETE
  await pushBackup(BASE, "u", "p", DIR, '{"v":1}', 1, "ghrc-backup-20260808000001.json");
  await pushBackup(BASE, "u", "p", DIR, '{"v":2}', 1, "ghrc-backup-20260808000002.json");
  assert.ok(seen.includes("DELETE " + DIR_ENC + "/ghrc-backup-20260808000001.json"),
    "旧备份应被清理,实际: " + JSON.stringify(seen));
  const names = await webdavList(BASE, "u", "p", DIR);
  assert.deepEqual(names.filter((n) => n.startsWith("ghrc-backup-")).sort(),
    ["ghrc-backup-20260808000002.json"], "远端只保留最近 1 份");

  // pull 选最新(文件名时间戳最大的)
  const latest = await pullLatest(BASE, "u", "p", DIR);
  assert.equal(latest.filename, "ghrc-backup-20260808000002.json");
  assert.equal(latest.content, '{"v":2}');

  // 最新备份损坏 → 自动跳过取次新
  putFile(DIR_ENC + "/ghrc-backup-20260808000003.json", "not-json{{{");
  const fallback = await pullLatest(BASE, "u", "p", DIR);
  assert.equal(fallback.filename, "ghrc-backup-20260808000002.json", "损坏备份被跳过");
});

test("webdav: pull 无备份但有旧版 data.json 时兜底;全无则报错", async () => {
  reset();
  // 重建目录节点(reset 清空了 tree)
  tree.set("/workbuddy/", { isDir: true });
  tree.set(DIR_ENC + "/", { isDir: true });
  putFile(DIR_ENC + "/data.json", '{"legacy":1}');
  const legacy = await pullLatest(BASE, "u", "p", DIR);
  assert.equal(legacy.filename, "data.json", "兼容旧版固定文件");

  reset();
  await assert.rejects(() => pullLatest(BASE, "u", "p", DIR), /远端没有备份文件/);
});

test("webdav: 认证失败归一化(401 → 请检查用户名/密码)", async () => {
  reset();
  authFail = true;
  await assert.rejects(() => testConnection(BASE, "u", "wrong", DIR), /认证失败/);
});

after(() => { mock.closeAllConnections?.(); mock.close(); });
