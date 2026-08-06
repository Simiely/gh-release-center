// lib/webdav.mjs — WebDAV 协议客户端(零依赖:MKCOL/PUT/GET + Basic 认证)
// 参考 tools-center 平台 lib/core/webdav.js,工具独立实现(不依赖平台 lib)。
// 用途:软件清单(data.json)云同步——登录 WebDAV 后上传/下载数据,本地/云端两个目录桥接。

const AUTH = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

async function req(method, url, user, pass, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    return await fetch(url, {
      method,
      headers: { Authorization: AUTH(user, pass), ...(body ? { "Content-Type": "application/octet-stream" } : {}) },
      body,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "WebDAV 请求超时(15s)" : "网络错误: " + e.message);
  } finally { clearTimeout(t); }
}

const baseOf = (base) => String(base || "").replace(/\/+$/, "");
/** 路径段 URL 编码(支持中文目录名,如 workbuddy/github下载) */
const encSeg = (seg) => encodeURIComponent(seg);
const encPath = (p) => String(p).split("/").filter(Boolean).map(encSeg).join("/");
const fileUrl = (base, dir, file) => `${baseOf(base)}/${encPath(dir)}/${encSeg(file)}`;

/** 确保远端目录存在:多级目录逐级 MKCOL(201 新建 / 405·301 已存在均成功) */
async function ensureDir(base, user, pass, dir) {
  const baseUrl = baseOf(base);
  let acc = "";
  for (const seg of String(dir).split("/").filter(Boolean)) {
    acc += "/" + encSeg(seg);
    const r = await req("MKCOL", baseUrl + acc + "/", user, pass);
    if (![200, 201, 301, 405].includes(r.status)) throw new Error("创建目录失败(HTTP " + r.status + ")");
  }
}

/** 测试连接:在指定目录下建目录验证可达 + 登录(默认 gh-release-center) */
export async function testConnection(base, user, pass, dir = "gh-release-center") {
  if (!base) throw new Error("未配置 WebDAV 地址");
  await ensureDir(base, user, pass, dir);
  return { ok: true };
}

/** 上传文件到远端 dir/file */
export async function uploadFile(base, user, pass, dir, file, content) {
  await ensureDir(base, user, pass, dir);
  const r = await req("PUT", fileUrl(base, dir, file), user, pass, content);
  if (r.status >= 200 && r.status < 300) return { ok: true };
  throw new Error(`上传 ${file} 失败(HTTP ${r.status})`);
}

/** 下载远端文件;不存在返回 null */
export async function downloadFile(base, user, pass, dir, file) {
  const r = await req("GET", fileUrl(base, dir, file), user, pass);
  if (r.status === 404) return null;
  if (r.status >= 200 && r.status < 300) return await r.text();
  throw new Error(`下载 ${file} 失败(HTTP ${r.status})`);
}
