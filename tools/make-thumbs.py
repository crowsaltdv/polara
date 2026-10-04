"""Builds small square WebP thumbnails for every game cover, so the Games page doesn't download 14+ MB of full-size art."""
import json, os, re, sys
from PIL import Image

root = sys.argv[1]
src = open(os.path.join(root, "games.js"), encoding="utf-8").read()
games = json.loads(src[src.index("=") + 1 :].rstrip().rstrip(";"))
out_dir = os.path.join(root, "vendor", "thumbs")
os.makedirs(out_dir, exist_ok=True)
SIZE = 256
made = skipped = 0
before = after = 0

for g in games:
    gid = g["id"]
    cands = ([g["img"]] if g.get("img") else []) + ["icon.png", "cover.png", "logo.png"]
    path = None
    for c in cands:
        p = os.path.join(root, "games", gid, c)
        if os.path.isfile(p) and not p.lower().endswith(".svg"):
            path = p
            break
    if not path:
        skipped += 1
        continue
    try:
        im = Image.open(path)
        im.load()
        im = im.convert("RGBA")
        w, h = im.size
        s = min(w, h)
        im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
        im = im.resize((SIZE, SIZE), Image.LANCZOS)
        dest = os.path.join(out_dir, gid + ".webp")
        im.save(dest, "WEBP", quality=76, method=6)
        made += 1
        before += os.path.getsize(path)
        after += os.path.getsize(dest)
    except Exception as e:
        skipped += 1
        print("skip", gid, type(e).__name__, str(e)[:60])

print(f"made {made}, skipped {skipped}")
print(f"originals {before/1e6:.1f} MB  ->  thumbnails {after/1e6:.1f} MB")
