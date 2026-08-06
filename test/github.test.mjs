// test/github.test.mjs — lib/github.mjs 纯函数单测
import test from "node:test";
import assert from "node:assert/strict";
import { parseRepoUrl, detectPlatform, normalizeRelease } from "../lib/github.mjs";

test("parseRepoUrl: owner/repo", () => {
  assert.deepEqual(parseRepoUrl("Simiely/tools-center"), { owner: "Simiely", repo: "tools-center" });
});

test("parseRepoUrl: https github 链接", () => {
  assert.deepEqual(
    parseRepoUrl("https://github.com/Simiely/knowledge-base"),
    { owner: "Simiely", repo: "knowledge-base" }
  );
  assert.deepEqual(
    parseRepoUrl("github.com/Simiely/tools-center"),
    { owner: "Simiely", repo: "tools-center" }
  );
});

test("parseRepoUrl: 去掉尾部 .git", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/Simiely/tools-center.git"), {
    owner: "Simiely",
    repo: "tools-center",
  });
});

test("parseRepoUrl: 非法输入返回 null", () => {
  assert.equal(parseRepoUrl(""), null);
  assert.equal(parseRepoUrl("随便写"), null);
  assert.equal(parseRepoUrl("https://gitlab.com/a/b"), null);
  assert.equal(parseRepoUrl(null), null);
});

test("detectPlatform: Windows 资产", () => {
  assert.equal(detectPlatform("app-1.2.0-win64.exe"), "win");
  assert.equal(detectPlatform("setup.msi"), "win");
  assert.equal(detectPlatform("tool_windows.zip"), "win");
});

test("detectPlatform: macOS 资产", () => {
  assert.equal(detectPlatform("app-1.2.0.dmg"), "mac");
  assert.equal(detectPlatform("installer.pkg"), "mac");
  assert.equal(detectPlatform("app_macos.tar.gz"), "mac");
});

test("detectPlatform: Linux 资产", () => {
  assert.equal(detectPlatform("app-1.2.0.AppImage"), "linux");
  assert.equal(detectPlatform("app_linux.tar.gz"), "linux");
  assert.equal(detectPlatform("app.deb"), "linux");
});

test("detectPlatform: 其他返回 other", () => {
  assert.equal(detectPlatform("source.zip"), "other");
  assert.equal(detectPlatform(""), "other");
});

test("normalizeRelease: 资产字段归一化", () => {
  const r = normalizeRelease({
    tag_name: "v1.0.0",
    name: "v1.0.0",
    published_at: "2026-01-01T00:00:00Z",
    prerelease: false,
    assets: [
      { name: "app.exe", size: 1048576, download_count: 10, browser_download_url: "https://x/app.exe" },
    ],
  });
  assert.equal(r.tag, "v1.0.0");
  assert.equal(r.assets.length, 1);
  assert.equal(r.assets[0].platform, "win");
  assert.equal(r.assets[0].sizeText, "1.0 MB");
  assert.equal(r.assets[0].downloads, 10);
});
