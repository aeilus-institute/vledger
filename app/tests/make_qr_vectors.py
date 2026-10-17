"""Writes tests/qr-vectors.json: QR matrices made by the independent `segno` library (byte mode, level M,
forced version and mask) for app/tests/selftest.js to compare with app/assets/vledger-qr.js module by module.

    python make_qr_vectors.py      (needs: pip install segno)
"""
import json
import pathlib

import segno

TEXTS = [
    'vw1:NZaxmJZy1D3YyMikLsTaZqY49rJACaW4NIHIPicjS1A',
    'https://aeilus.institute/w/#vw1:NZaxmJZy1D3YyMikLsTaZqY49rJACaW4NIHIPicjS1A?n=Example+Municipality&k=state',
    'https://aeilus.institute/w/#vw1:NZaxmJZy1D3YyMikLsTaZqY49rJACaW4NIHIPicjS1A?n=%D0%92%D0%B8%D0%BA%D1%82%D0%BE%D1%80&k=person&extra=padding-to-reach-version-ten-0123456789012345678901234567890123456789',
    'hello',
]
out = []
for text in TEXTS:
    base = segno.make(text, error='m', mode='byte', boost_error=False, micro=False)
    for mask in (0, 3, 5, 7):
        q = segno.make(text, error='m', mode='byte', version=base.version, mask=mask, boost_error=False, micro=False)
        out.append({'text': text, 'version': q.version, 'mask': mask, 'matrix': [''.join('1' if c else '0' for c in row) for row in q.matrix]})
path = pathlib.Path(__file__).with_name('qr-vectors.json')
path.write_text(json.dumps(out, indent=1) + '\n', encoding='utf-8')
print(len(out), 'vectors, versions', sorted({v['version'] for v in out}))
