#!/usr/bin/env python3
"""Regenerate packages/analytics/src/story/playerFonts.ts: a Latin subset of the six report faces, base64, so a shared story page carries its own fonts.
Needs `pip install fonttools` (and `brotli` for woff2; without it woff is written). Run from the repository root."""
import base64, os
from fontTools import subset
from fontTools.ttLib import TTFont
src = 'apps/studio/public/report-fonts'
files = {'Inter': ('Inter_400Regular.ttf', 'Inter_700Bold.ttf'), 'Source Serif 4': ('SourceSerif4_400Regular.ttf', 'SourceSerif4_700Bold.ttf'), 'Montserrat': ('Montserrat_400Regular.ttf', 'Montserrat_700Bold.ttf')}
uni = list(range(0x20, 0x7f)) + list(range(0xa0, 0x100)) + [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x2212, 0x2192, 0x2190, 0x2265, 0x2264, 0x00d7, 0x2020, 0x25b6, 0x2713]
try:
    import brotli  # noqa: F401
    flavor = 'woff2'
except Exception:
    flavor = 'woff'
out = {}
for fam, (r, b) in files.items():
    for w, f in ((400, r), (700, b)):
        opts = subset.Options(); opts.flavor = flavor; opts.layout_features = ['kern', 'liga', 'tnum', 'lnum']; opts.notdef_outline = True; opts.hinting = False; opts.desubroutinize = True
        font = TTFont(os.path.join(src, f))
        s = subset.Subsetter(opts); s.populate(unicodes=uni); s.subset(font)
        path = f'/tmp/{fam.replace(" ", "")}{w}.{flavor}'
        font.flavor = flavor; font.save(path)
        out[(fam, w)] = base64.b64encode(open(path, 'rb').read()).decode()
lines = ['// GENERATED from apps/studio/public/report-fonts (SIL OFL) — Latin subset, so a shared story carries its own fonts (audit Phase 4: /report-fonts/* is not publicly reachable).',
         '// Regenerate with scripts/subset-story-fonts.py. Do not edit by hand.',
         f'export const PLAYER_FONT_FORMAT = "{flavor}" as const;', 'export const PLAYER_FONTS: Record<string, { 400: string; 700: string }> = {']
for fam in files:
    lines.append(f'  "{fam}": {{ 400: "{out[(fam, 400)]}", 700: "{out[(fam, 700)]}" }},')
lines.append('};')
open('packages/analytics/src/story/playerFonts.ts', 'w').write("\n".join(lines) + "\n")
