#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pack-platform.py — 平台版 zip 打包（tools-center v0.12.1 打包标准）

规范要点（docs/使用指南.md「十·一」）：
1. 条目分隔符必须正斜杠 /（APPNOTE），禁用反斜杠
2. 条目禁止绝对路径 / .. / 空名 / 以 / 结尾的目录条目
3. tool.json / manifest.json 放 zip 顶层
4. 打包后自检条目名（无 \\ 即合格）

用法: python pack-platform.py <项目目录> <版本号> [输出目录]
产物: <输出目录>/gh-release-center-platform-v<版本>.zip  (英文名,发布用)
      <输出目录>/gh-release-center-平台版-v<版本>.zip     (中文名,桌面存档)
"""
import os
import sys
import zipfile

ITEMS = ["tool.json", "manifest.json", "server.mjs", "lib", "public",
         "README.md", "AGENTS.md", "DEVELOPMENT.md", "CHANGELOG.md"]
EXCLUDE_DIRS = {".git", ".data", "__pycache__", "node_modules", "test"}

def collect(root, rel=""):
    """递归收集 (zip内路径, 绝对路径) 列表,全部用 / 分隔,不含目录条目"""
    out = []
    full = os.path.join(root, rel)
    for name in sorted(os.listdir(full)):
        p = os.path.join(full, name)
        r = f"{rel}/{name}" if rel else name
        r = r.replace("\\", "/")  # 保险:强制正斜杠
        if os.path.isdir(p):
            if name in EXCLUDE_DIRS:
                continue
            out.extend(collect(root, r))
        else:
            out.append((r, p))
    return out

def pack(src, version, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    en = os.path.join(out_dir, f"gh-release-center-platform-v{version}.zip")
    cn = os.path.join(out_dir, f"gh-release-center-平台版-v{version}.zip")
    for target in (en, cn):
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
            for r, p in collect(src):
                z.write(p, r)
        # 自检:条目名必须全正斜杠
        with zipfile.ZipFile(target) as z:
            names = [i.filename for i in z.infolist()]
            bad = [n for n in names if "\\" in n or n.startswith("/") or ".." in n.split("/")]
            if bad:
                print("❌ 自检失败,非法条目:", bad)
                sys.exit(1)
            print(f"✅ {os.path.basename(target)} ({os.path.getsize(target)} bytes)")
            for n in names:
                print("   ", n)
    return en

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python pack-platform.py <项目目录> <版本号> [输出目录]")
        sys.exit(1)
    src, ver = sys.argv[1], sys.argv[2]
    out = sys.argv[3] if len(sys.argv) > 3 else "."
    pack(src, ver, out)
