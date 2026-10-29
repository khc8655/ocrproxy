#!/usr/bin/env python3
"""tests/test_html_structure.py — Admin HTML 结构/嵌套守卫。

防止批量样式迁移（sed/脚本改 class）再次产出结构性损坏：
  1. 属性重复（同一个标签上出现两个 class / style / onclick …）
  2. 空属性（`<span >`、`class=""`、`" >` 尾巴）——sed 删值后的典型残留
  3. 标签未闭合 / 嵌套错位
  4. 内联 style 回归（迁移完成后基线为 0）
"""
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML_PATH = ROOT / "shared/admin/admin.html"

VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}
# 允许自闭合/可选闭合的宽松集合（HTML 规范里可省略结束标签的元素）
OPTIONAL_END = {"p", "li", "option", "tr", "td", "th", "thead", "tbody", "dt", "dd"}


class AdminHtmlAudit(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.errors = []
        self.stack = []
        self.line = 1

    def handle_starttag(self, tag, attrs):
        # handle_startendtag 与 handle_starttag 共用逻辑
        self._audit_attrs(tag, attrs)
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_startendtag(self, tag, attrs):
        self._audit_attrs(tag, attrs)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        # 弹掉可省略结束标签的元素
        while self.stack and self.stack[-1][0] in OPTIONAL_END and self.stack[-1][0] != tag:
            self.stack.pop()
        if not self.stack:
            self.errors.append(f"L{self.getpos()[0]}: 多余的 </{tag}>")
            return
        open_tag, _line = self.stack.pop()
        if open_tag != tag:
            self.errors.append(
                f"L{self.getpos()[0]}: </{tag}> 与 <{open_tag}> 嵌套错位"
                f"（<{open_tag}> 开于 L{_line}）"
            )

    def _audit_attrs(self, tag, attrs):
        seen = {}
        for name, value in attrs:
            line = self.getpos()[0]
            if not name.strip():
                self.errors.append(f"L{line}: <{tag}> 存在空属性名（疑似 style= 值被删后残留）")
                continue
            if name in seen:
                self.errors.append(f"L{line}: <{tag}> 属性 `{name}` 重复定义")
            seen[name] = value
            if value is not None and value.strip() == "" and name != "value":
                self.errors.append(f"L{line}: <{tag}> 属性 `{name}` 值为空")


def audit_source():
    text = HTML_PATH.read_text(encoding="utf-8")
    parser = AdminHtmlAudit()
    parser.feed(text)
    parser.close()
    for tag, line in parser.stack:
        parser.errors.append(f"L{line}: <{tag}> 未闭合")

    # 内联 style 棘轮：迁移后基线为 0
    inline = re.findall(r'\sstyle\s*=\s*"', text)
    if inline:
        parser.errors.append(f"存在 {len(inline)} 处内联 style（应使用 admin.css 语义类）")

    if parser.errors:
        print(f"FAIL {HTML_PATH.relative_to(ROOT)} 结构异常 {len(parser.errors)} 处：")
        for e in parser.errors[:20]:
            print(f"  - {e}")
        return False
    print(f"PASS {HTML_PATH.relative_to(ROOT)}: 嵌套闭合 / 无重复或空属性 / 无内联 style")
    return True


if __name__ == "__main__":
    ok = audit_source()
    if not ok:
        sys.exit(1)
    print("ALL HTML STRUCTURE CHECKS PASSED")
