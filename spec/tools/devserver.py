"""Local dev server for the L0 package: serves the package folder on 127.0.0.1 and accepts
PUT /fixtures/<name>.json from reference/make-fixtures.html. Nothing else is writable.

    python tools/devserver.py [port] [root]

With a root other than the package (for example the repository, to run app/tests/selftest.html)
the server is read-only.
"""
import http.server
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else pathlib.Path(__file__).resolve().parent.parent
WRITABLE = len(sys.argv) <= 2
FIXTURES = ROOT / 'fixtures'
NAME = re.compile(r'^/fixtures/([a-z0-9][a-z0-9._-]{0,80}\.json)$')


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.json': 'application/json'}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_PUT(self):
        m = NAME.match(self.path)
        if not WRITABLE or not m or self.client_address[0] != '127.0.0.1':
            self.send_error(403)
            return
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        try:
            data = json.loads(body.decode('utf-8'))
        except ValueError:
            self.send_error(400)
            return
        FIXTURES.mkdir(exist_ok=True)
        (FIXTURES / m.group(1)).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        self.send_response(204)
        self.end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
