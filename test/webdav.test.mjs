// test/webdav.test.mjs — WebDAV 客户端集成测试(本地 mock 服务器)
// 验证:中文目录路径正确编码(MKCOL/PUT/GET 到达 /workbuddy/github下载/data.json)
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { uploadFile, downloadFile, testConnection } from "../lib/webdav.mjs";

// mock WebDAV 服务器:记录请求,PUT/GET 存内存
const seen = [];
let stored = null;
const mock = http.createServer((req, res) => {
  seen.push(req.method + " " + req.url);
  if (req.method === "MKCOL") { res.writeHead(201); res.end(); return; }
  if (req.method === "PUT") {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { stored = b; res.writeHead(201); res.end(); });
    return;
  }
  if (req.method === "GET") {
    if (stored === null) { res.writeHead(404); res.end(); return; }
    res.writeHead(200); res.end(stored); return;
  }
  res.writeHead(405); res.end();
});

test("webdav: 中文目录路径编码 + 上传/下载全链路", async () => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  const dir = "workbuddy/github下载";

  // 测试连接(MKCOL 建真实同步目录)
  await testConnection(base, "u", "p", dir);
  assert.ok(seen.some((s) => s === "MKCOL /workbuddy/github%E4%B8%8B%E8%BD%BD/"),
    "MKCOL 路径应包含中文 URL 编码,实际: " + JSON.stringify(seen));

  // 上传
  await uploadFile(base, "u", "p", dir, "data.json", '{"hello":1}');
  assert.ok(seen.some((s) => s === "PUT /workbuddy/github%E4%B8%8B%E8%BD%BD/data.json"),
    "PUT 路径应包含中文 URL 编码,实际: " + JSON.stringify(seen));
  assert.equal(stored, '{"hello":1}');

  // 下载(存在)
  const got = await downloadFile(base, "u", "p", dir, "data.json");
  assert.equal(got, '{"hello":1}');

  // 下载(不存在 → null)
  stored = null;
  const none = await downloadFile(base, "u", "p", dir, "nope.json");
  assert.equal(none, null);

  mock.close();
});
