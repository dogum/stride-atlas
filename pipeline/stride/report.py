"""Shared HTML for the reports in reports/, in the Stride Atlas look.

Reports are standalone files. Fonts are loaded from reports/_assets/fonts when
present (copied from the app's local @fontsource packages); otherwise the
system fallback stack is used. No network requests.
"""
from __future__ import annotations

import html
from pathlib import Path

CSS = r"""
@font-face{font-family:"Overpass";font-weight:400 800;src:url(_assets/fonts/overpass-latin-wght-normal.woff2) format("woff2")}
@font-face{font-family:"Public Sans";font-weight:400 700;src:url(_assets/fonts/public-sans-latin-wght-normal.woff2) format("woff2")}
@font-face{font-family:"Overpass Mono";font-weight:400 700;src:url(_assets/fonts/overpass-mono-latin-wght-normal.woff2) format("woff2")}
:root{color-scheme:dark;--page:#0b1220;--panel:#101a2b;--raised:#16223a;--raised-2:#1c2a45;--chip:#233350;--edge:#22314c;--edge-soft:#1a2740;--edge-strong:#33476a;--ink-1:#eef2f7;--ink-2:#c3cddb;--ink-3:#97a5bb;--ink-4:#8090a8;--signal:#ff8f4a;--signal-ghost:rgba(255,143,74,.10);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s8:#e66767;--good:#0ca30c;--critical:#d03b3b;--map-bg:#070c16;
--font-ui:"Public Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-display:"Overpass","Public Sans",ui-sans-serif,system-ui,sans-serif;--font-mono:"Overpass Mono",ui-monospace,"SF Mono",Menlo,monospace}
@media (prefers-color-scheme: light){:root{color-scheme:light;--page:#f1f4f0;--panel:#fff;--raised:#f6f8f5;--raised-2:#eaeee8;--chip:#dfe5dd;--edge:#d5dcd3;--edge-soft:#e6ebe4;--edge-strong:#b5c0b3;--ink-1:#13202a;--ink-2:#2f3d47;--ink-3:#4b5a63;--ink-4:#637079;--signal:#b84a0e;--signal-ghost:rgba(184,74,14,.08);--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s8:#e34948}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink-1);font:14px/1.5 var(--font-ui);-webkit-font-smoothing:antialiased}
main{max-width:1180px;margin:0 auto;padding:28px 20px 64px}
h1{font-family:var(--font-display);font-weight:800;font-size:clamp(28px,4vw,42px);line-height:1.05;margin:6px 0 8px;letter-spacing:-.01em}
h1 em{font-style:normal;color:var(--signal)}
h2{font-family:var(--font-display);font-weight:800;font-size:22px;margin:34px 0 10px}
h3{font-size:15px;margin:18px 0 6px}
p{color:var(--ink-2);max-width:80ch}.muted{color:var(--ink-3)}
.eyebrow{font-family:var(--font-display);font-weight:700;font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);display:inline-flex;align-items:center;gap:9px}
.eyebrow::before{content:"";width:7px;height:15px;border-radius:1.5px;background:var(--signal);box-shadow:0 0 0 3px var(--signal-ghost)}
.panel{background:var(--panel);border-top:2px solid var(--edge);border-radius:2px 2px 6px 6px;padding:14px 16px;margin:12px 0;overflow-x:auto}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:16px 0}
.tile{background:var(--panel);border-left:2px solid var(--edge);border-radius:0 6px 6px 0;padding:10px 14px}
.tile .l{font-family:var(--font-display);font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.tile .v{font-family:var(--font-display);font-weight:800;font-size:26px}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{padding:5px 9px;border-bottom:1px solid var(--edge-soft);text-align:left;vertical-align:top}
th{background:var(--raised);font-family:var(--font-display);font-weight:600;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);position:sticky;top:0}
td.n,th.n{text-align:right;font-family:var(--font-mono);font-variant-numeric:tabular-nums}
code,.mono{font-family:var(--font-mono);font-size:12px;color:var(--ink-2)}
.ok{color:var(--good);font-weight:600}.bad{color:var(--critical);font-weight:600}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--chip);font-size:11.5px;margin:1px 2px}
.scroll{max-height:420px;overflow:auto}
svg text{font-family:var(--font-mono);font-size:10.5px;fill:var(--ink-3)}
footer{color:var(--ink-4);font-size:12px;margin-top:40px}
"""


def esc(x) -> str:
    return html.escape("" if x is None else str(x))


def table(cols: list[tuple[str, str] | tuple[str, str, bool]], rows: list[dict], cls: str = "") -> str:
    """cols: (key, label[, numeric])"""
    h = "".join(f'<th class="{"n" if len(c) > 2 and c[2] else ""}">{esc(c[1])}</th>' for c in cols)
    body = []
    for r in rows:
        tds = "".join(
            f'<td class="{"n" if len(c) > 2 and c[2] else ""}">{r.get(c[0], "") if str(r.get(c[0], "")).startswith("<") else esc(r.get(c[0], ""))}</td>'
            for c in cols
        )
        body.append(f"<tr>{tds}</tr>")
    return f'<div class="{cls}"><table><thead><tr>{h}</tr></thead><tbody>{"".join(body)}</tbody></table></div>'


def tiles(items: list[tuple[str, str]]) -> str:
    return '<div class="tiles">' + "".join(f'<div class="tile"><div class="l">{esc(k)}</div><div class="v">{esc(v)}</div></div>' for k, v in items) + "</div>"


def page(title: str, eyebrow: str, headline: str, body: str, extra_css: str = "", script: str = "") -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(title)}</title><style>{CSS}{extra_css}</style></head><body><main>
<div class="eyebrow">{esc(eyebrow)}</div><h1>{headline}</h1>{body}
<footer>Stride Atlas · generated locally from the Apple Health export · nothing here left this computer</footer></main>{script}</body></html>"""


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    print(f"wrote {path}")
