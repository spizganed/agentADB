"""Reads a uiautomator dump on stdin and prints what the commands need.

find.py tap "label" [n]   prints the centre "x y" of the n-th node (default the first) whose text or content-desc equals the label
find.py has "text"    exit 0 when the text or content-desc of a node contains the text (as texts and tap see it)
find.py texts         prints each visible text, one per line
"""
import html
import re
import sys

mode = sys.argv[1]
arg = sys.argv[2] if len(sys.argv) > 2 else ""
xml = sys.stdin.read()
nodes = []
for n in re.finditer(r"<node [^>]*>", xml):
    s = n.group(0)
    # uiautomator quotes a value with ' when it holds a ". Was: only "...", so a JSON error text was not seen.
    t = re.search(r""" text=(?:"([^"]*)"|'([^']*)')""", s)
    d = re.search(r"""content-desc=(?:"([^"]*)"|'([^']*)')""", s)
    b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', s)
    val = lambda m: html.unescape(m.group(1) if m.group(1) is not None else m.group(2)) if m else ""
    nodes.append((val(t), val(d), b.groups() if b else None))

if mode == "tap":
    nth = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    seen = 0
    for text, desc, b in nodes:
        if b and arg in (text, desc):
            seen += 1
            if seen == nth:
                x1, y1, x2, y2 = map(int, b)
                print((x1 + x2) // 2, (y1 + y2) // 2)
                break
elif mode == "has":
    # Was: the text only, so pp wait missed a node that pp texts lists by its description (a search field).
    sys.exit(0 if any(arg in text or arg in desc for text, desc, _ in nodes) else 1)
elif mode == "texts":
    for text, desc, _ in nodes:
        if text or desc:
            print((text or desc).replace("\n", " / ")[:100])
