#!/usr/bin/env python3
# Puts the fonts the README images use into the images themselves.
#   python3 docs/preview/fonts.py <file.svg>...   (bun docs/preview/render.ts runs it for you)
# Needs fontTools 4.60 or newer with WOFF2 support: pip install "fonttools>=4.60" brotli
#
# GitHub shows a README's SVG as an image, and an image may not fetch a font, so each SVG
# carries the letters it draws, as WOFF2 inside an @font-face: Inter for the words, JetBrains
# Mono for the terminal, Noto Sans TC and SC for Chinese. Without them every reader saw the
# system's own font (Segoe UI and Microsoft JhengHei on Windows, others elsewhere), and the
# Simplified Chinese pictures took Traditional Chinese shapes from the first CJK font found.
# The fonts are the SIL Open Font License 1.1 releases in github.com/google/fonts, fetched once
# at a fixed commit, checked against their SHA-256 and kept in docs/preview/out/fonts/.
import base64
import functools
import hashlib
import io
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

COMMIT = '47d54ca1ebb14fd864695f1d39dc734f39017c33'
CACHE = Path(__file__).resolve().parent / 'out' / 'fonts'

# family: (path in google/fonts, SHA-256, weight range the images use)
FONTS = {
    'Inter': ('ofl/inter/Inter[opsz,wght].ttf', '29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031', (400, 800)),
    'JetBrains Mono': ('ofl/jetbrainsmono/JetBrainsMono[wght].ttf', '48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda', (400, 700)),
    'Noto Sans TC': ('ofl/notosanstc/NotoSansTC[wght].ttf', '864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f', (400, 800)),
    'Noto Sans SC': ('ofl/notosanssc/NotoSansSC[wght].ttf', 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da', (400, 800)),
}
LATIN = ('Inter', 'JetBrains Mono')
# JetBrains Mono's ligatures draw `<!--` and `-->` as arrows, and the diagram shows a file as
# it is typed, so its subset leaves them out.
LIGATURES = {'calt', 'clig', 'dlig', 'liga'}
TYPED = {'JetBrains Mono'}
CJK = ('Noto Sans TC', 'Noto Sans SC')
MARK = 'data-fonts'


# Once per family and run: the Chinese fonts are 12 to 18 MB to hash.
@functools.cache
def fetch(family: str) -> Path:
    path, digest, _ = FONTS[family]
    local = CACHE / Path(path).name
    if not local.exists() or hashlib.sha256(local.read_bytes()).hexdigest() != digest:
        url = f'https://raw.githubusercontent.com/google/fonts/{COMMIT}/{urllib.parse.quote(path)}'
        data = urllib.request.urlopen(url, timeout=120).read()
        if hashlib.sha256(data).hexdigest() != digest:
            sys.exit(f'fonts.py: {url} is not the file this script was written for (SHA-256 differs)')
        CACHE.mkdir(parents=True, exist_ok=True)
        local.write_bytes(data)
    return local


_loaded: dict[str, TTFont] = {}


def font(family: str) -> TTFont:
    if family not in _loaded:
        _loaded[family] = TTFont(fetch(family))
    return _loaded[family]


def covers(family: str, ch: str) -> bool:
    return ord(ch) in font(family).getBestCmap()


def woff2(family: str, chars: set[str]) -> bytes:
    one = TTFont(fetch(family))
    options = subset.Options()
    options.flavor = 'woff2'
    options.notdef_outline = True
    if family in TYPED:
        options.layout_features = [feature for feature in options.layout_features if feature not in LIGATURES]
    if family in CJK:
        options.layout_features = [*options.layout_features, 'palt']
    cut = subset.Subsetter(options)
    cut.populate(text=''.join(sorted(chars)))
    cut.subset(one)
    one = instancer.instantiateVariableFont(one, {'wght': FONTS[family][2]})
    out = io.BytesIO()
    one.flavor = 'woff2'
    # Saving would stamp the time into the font, and every run would change every image.
    one.recalcTimestamp = False
    one.save(out)
    return out.getvalue()


# The letters an SVG draws: the text of its <text> and <tspan> elements, not its <title>,
# its aria-label or its CSS.
def drawn(svg: str) -> set[str]:
    body = re.sub(r'<(style|title)\b[^>]*>.*?</\1>', '', svg, flags=re.S)
    chars: set[str] = set()
    for run in re.findall(r'<text\b[^>]*>(.*?)</text>', body, flags=re.S):
        text = re.sub(r'<[^>]+>', '', run)
        text = text.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&#39;', "'").replace('&amp;', '&')
        chars |= set(text) - {'\n', '\r', '\t'}
    return chars


# Which embedded font draws each letter. The fonts are the ones the SVG names (render.ts
# quotes every family). Inter and JetBrains Mono take every letter they have; a Chinese font
# takes the rest, in the order the SVG names them, so its own script comes first and a sign
# one Latin font lacks still has a font of ours behind it.
def plan(svg: str, chars: set[str]) -> dict[str, set[str]]:
    named = sorted((family for family in FONTS if f"'{family}'" in svg), key=lambda family: svg.find(f"'{family}'"))
    latin = [family for family in named if family in LATIN]
    cjk = [family for family in named if family in CJK]
    parts: dict[str, set[str]] = {family: set() for family in named}
    for ch in chars:
        has = [family for family in latin if covers(family, ch)]
        for family in has:
            parts[family].add(ch)
        if latin and (ch.isascii() or len(has) == len(latin)):
            continue
        for family in cjk:
            if covers(family, ch):
                parts[family].add(ch)
                break
    return {family: part for family, part in parts.items() if part}


def face(family: str, data: bytes) -> str:
    low, high = FONTS[family][2]
    encoded = base64.b64encode(data).decode('ascii')
    return f"@font-face {{ font-family: '{family}'; font-weight: {low} {high}; src: url(data:font/woff2;base64,{encoded}) format('woff2'); }}"


def embed(path: Path) -> int:
    svg = re.sub(rf'<style {MARK}="1">.*?</style>\n?', '', path.read_text(encoding='utf-8'), flags=re.S)
    parts = plan(svg, drawn(svg))
    faces = '\n'.join(face(family, woff2(family, chars)) for family, chars in parts.items())
    if faces != '':
        opening = re.search(r'<svg\b[^>]*>\n?', svg)
        if opening is None:
            sys.exit(f'fonts.py: {path} has no <svg> tag')
        svg = f'{svg[:opening.end()]}<style {MARK}="1">\n{faces}\n</style>\n{svg[opening.end():]}'
    path.write_text(svg, encoding='utf-8', newline='\n')
    return len(parts)


if __name__ == '__main__':
    files = [Path(arg) for arg in sys.argv[1:]]
    if not files:
        sys.exit('usage: fonts.py <file.svg>...')
    for path in files:
        embed(path)
    print(f'fonts.py: embedded the fonts in {len(files)} SVG files')
