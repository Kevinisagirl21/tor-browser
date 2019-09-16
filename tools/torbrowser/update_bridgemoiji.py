#!/usr/bin/env python3
# Script to update bridgemoji files from Twemoji, and from Unicode
# datasets.
# Please be sure to grab and extract twe-svg.zip from
# https://github.com/mozilla/twemoji-colr, and to get the latest
# version of https://github.com/unicode-org/cldr.git.

import json
from pathlib import Path
from shutil import copyfile
import sys
from xml.dom.minidom import parse


if len(sys.argv) < 3:
    print(f'Usage: {sys.argv[0]} twemoji-svg-dir cldr-dir')
    sys.exit(1)
twemoji_dir = Path(sys.argv[1])
cldr_dir = Path(sys.argv[2])

LANGS = [
    "ar",
    "ca",
    "cs",
    "da",
    "de",
    "el",
    "en",
    "es",
    "fa",
    "fr",
    "ga",
    "he",
    "hu",
    "id",
    "is",
    "it",
    "ja",
    "ka",
    "ko",
    "lt",
    "mk",
    "ms",
    "my",
    # "nb",  # Empty file, currently!!
    "nl",
    "pl",
    "pt",
    "ro",
    "ru",
    "sv",
    "th",
    "tr",
    "uk",
    "vi",
    "zh",  # zh-CN, zh-hans
    "zh_Hant",  # zh-TW, zh-hant
]

# Currently the script is in tools/torbrowser/
firefox_root = Path(__file__).parents[2]
panel_dir = firefox_root / 'browser/components/torpreferences/content'

with (panel_dir / 'connectionPane.js').open() as f:
    pane_js = f.read()
make_id_offset = pane_js.find('function makeBridgeId(bridgeString) {')
emojis_var = 'const emojis = '
emojis_offset = pane_js.find(emojis_var, make_id_offset) + len(emojis_var)
close_offset = pane_js.find(']', emojis_offset)
emojis_str = pane_js[emojis_offset:close_offset].strip('\t \n,')
emojis_str += ']'
emojis = json.loads(emojis_str)
codepoints = []
for idx, e in enumerate(emojis):
    if len(e) > 2 or (len(e) == 2 and ord(e[1]) != 0xfe0f):
        # U+FE0F is "VARIATION SELECTOR-16" and tells the emoji to be
        # colored, or something like that.
        print(f'Unsupported emoji {e}: too many codepoints')
        sys.exit(2)
    codepoints.append(ord(e[0]))

emojis_dest = panel_dir / 'bridgemoji'
emojis_dest.mkdir(exist_ok=True)
for f in emojis_dest.iterdir():
    f.unlink()
for cp in codepoints:
    src = twemoji_dir / f'{cp:x}.svg'
    dst = emojis_dest / f'{cp:x}.svg'
    copyfile(src, dst)

data = {l: {} for l in LANGS}

for l in LANGS:
    with (cldr_dir / f'common/annotations/{l}.xml').open() as f:
        doc = parse(f)
    anns = doc.getElementsByTagName('annotation')
    for ann in anns:
        cp = ann.getAttribute('cp')
        if len(cp) != 1:
            continue
        try:
            idx = codepoints.index(ord(cp))
            if ann.getAttribute('type') == 'tts':
                ann.normalize()
                data[l][emojis[idx]] = ann.firstChild.data
        except ValueError:
            pass
    if len(data[l]) != len(emojis):
        print(f'Lang {l} doesn\'t have all the emoji descriptions!')

data['zh-CN'] = data.pop('zh')
data['zh-TW'] = data.pop('zh_Hant')

with (panel_dir / 'bridgemoji-annotations.json').open('w') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
