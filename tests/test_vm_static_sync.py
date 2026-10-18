#!/usr/bin/env python3
"""shared/admin 是 VM 控制台的唯一源码；vm-app/static 是发布副本 (install.sh 只拷贝后者)。

两者一旦漂移，线上 VM 跑的就不是仓库里改过的代码。本测试要求：
  * js/*.js 与 admin.css 逐字节一致；
  * admin.html 除版本号 (?v=..., topVersionBadge) 外一致。
修复方法：`node agent-edgeone/scripts/build-admin.mjs` (会同步 shared/admin -> vm-app/static)。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC, DST = ROOT / "shared" / "admin", ROOT / "vm-app" / "static"
bad = []

for f in sorted((SRC / "js").glob("*.js")):
    d = DST / "js" / f.name
    if not d.exists() or d.read_bytes() != f.read_bytes():
        bad.append(f"js/{f.name}")
extra = {p.name for p in (DST / "js").glob("*.js")} - {p.name for p in (SRC / "js").glob("*.js")}
bad += [f"js/{n} (仅存在于 vm-app/static)" for n in sorted(extra)]
if (SRC / "admin.css").read_bytes() != (DST / "admin.css").read_bytes():
    bad.append("admin.css")


def norm(html: str) -> str:
    html = re.sub(r"(\.js\?v=)[^\"']+", r"\1X", html)
    return re.sub(r'(id="topVersionBadge"[^>]*>)[^<]*', r"\1X", html)


if norm((SRC / "admin.html").read_text("utf-8")) != norm((DST / "admin.html").read_text("utf-8")):
    bad.append("admin.html")

if bad:
    print("FAIL: vm-app/static 与 shared/admin 不一致:", ", ".join(bad))
    print("      运行 node agent-edgeone/scripts/build-admin.mjs 同步")
    sys.exit(1)
print("PASS: vm-app/static 与 shared/admin 同步一致")
