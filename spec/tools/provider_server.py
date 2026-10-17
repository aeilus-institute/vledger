"""Reference storage provider for aevri.vledger (openapi/provider.yaml), for tests and as a model for real providers.

    python tools/provider_server.py [port] [--delay SECONDS] [--test]

- Stores keyrings and envelopes in memory as sets, with a server cursor (SPEC 8). Never sees plain text.
- Wallet proof for writes (X-Vledger-Address / -Challenge / -Proof); the first keyring binds wallet id to address.
- Offers recovery (SPEC 4.4): its own P-256 recovery key, requests with notices, cancel by the holder, and release of
  the DEK wrapped to the requesting device's key after the procedure (identity approved and delay over).
- With --test: GET /debug/dump (everything stored, for leak checks) and POST /debug/approve/<requestId> (stands for
  the identity check), plus a minimal mock of the GitHub contents API under /gh/ (bearer token "test-token").
Needs: cryptography.
"""
import base64
import hashlib
import json
import os
import re
import secrets
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

ARGS = sys.argv[1:]
PORT = int(ARGS[0]) if ARGS and ARGS[0].isdigit() else 8793
DELAY = float(ARGS[ARGS.index('--delay') + 1]) if '--delay' in ARGS else 0.0
TEST = '--test' in ARGS
LOCK = threading.Lock()

wallets = {}      # walletId -> {address, createdAt, keyring, records: {id: (cursor, item)}, cursor}
challenges = {}   # challenge -> expiry
recoveries = {}   # requestId -> {...}
github = {}       # (owner, repo, path) -> {content(bytes), sha}

REC_KEY = ec.generate_private_key(ec.SECP256R1())
KEY_ID = 'reference-recovery-' + secrets.token_hex(4)


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def ub64(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def now():
    return datetime.now(timezone.utc)


def iso(t):
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


def pub_jwk(key):
    n = key.public_key().public_numbers() if hasattr(key, 'public_key') else key.public_numbers()
    return {'kty': 'EC', 'crv': 'P-256', 'x': b64u(n.x.to_bytes(32, 'big')), 'y': b64u(n.y.to_bytes(32, 'big'))}


def ec_pub(jwk):
    return ec.EllipticCurvePublicNumbers(int.from_bytes(ub64(jwk['x']), 'big'), int.from_bytes(ub64(jwk['y']), 'big'), ec.SECP256R1()).public_key()


def hkdf(shared, info):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=bytes(32), info=info.encode()).derive(shared)


def open_recovery_slot(wallet_id, slot):
    shared = REC_KEY.exchange(ec.ECDH(), ec_pub(slot['epk']))
    wk = hkdf(shared, f"aevri.vledger/1|recovery|{wallet_id}|{slot['keyId']}")
    aad = f"aevri.vledger/1|slot|{wallet_id}|{slot['id']}".encode()
    return AESGCM(wk).decrypt(ub64(slot['wrap']['iv']), ub64(slot['wrap']['ct']), aad)


def release(request_id, dek, client_epk):
    eph = ec.generate_private_key(ec.SECP256R1())
    info = f'aevri.vledger/1|recovery-release|{request_id}'
    key = hkdf(eph.exchange(ec.ECDH(), ec_pub(client_epk)), info)
    iv = os.urandom(12)
    return {'epk': pub_jwk(eph), 'iv': b64u(iv), 'ct': b64u(AESGCM(key).encrypt(iv, dek, info.encode()))}


class Handler(BaseHTTPRequestHandler):
    server_version = 'vledger-provider/1'

    def log_message(self, fmt, *a):  # counts only, no content
        pass

    def send(self, code, body=None, ctype='application/json'):
        data = b'' if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Vledger-Address, X-Vledger-Challenge, X-Vledger-Proof')
        self.send_header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS')
        self.send_header('Cache-Control', 'no-store')
        if data:
            self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def problem(self, code, name):
        self.send(code, {'type': 'about:blank', 'title': name, 'code': 'vledger/' + name}, 'application/problem+json')

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 20 * 1024 * 1024:
            raise ValueError('too large')
        return json.loads(self.rfile.read(n) or b'null')

    def proven(self, address):
        ch = self.headers.get('X-Vledger-Challenge', '')
        addr = self.headers.get('X-Vledger-Address', '')
        sig = self.headers.get('X-Vledger-Proof', '')
        with LOCK:
            exp = challenges.pop(ch, None)
        if not exp or exp < time.time() or addr != address or not re.fullmatch(r'vw1:[A-Za-z0-9_-]{43}', addr):
            return False
        try:
            Ed25519PublicKey.from_public_bytes(ub64(addr[4:])).verify(ub64(sig), ch.encode())
            return True
        except (InvalidSignature, ValueError):
            return False

    def do_OPTIONS(self):
        self.send(204)

    def route(self, method):
        path = self.path.split('?')[0]
        q = dict(p.split('=', 1) for p in self.path.split('?', 1)[1].split('&') if '=' in p) if '?' in self.path else {}
        try:
            if path.startswith('/gh/') and TEST:
                return self.github(method, path[3:], q)
            if not path.startswith('/v1/'):
                return self.problem(404, 'not-found')
            parts = path[4:].strip('/').split('/')
            return self.v1(method, parts, q)
        except (ValueError, KeyError, TypeError) as e:
            return self.problem(400, 'bad-request:' + type(e).__name__)

    def v1(self, method, parts, q):
        if parts == ['challenge'] and method == 'GET':
            ch = secrets.token_urlsafe(24)
            with LOCK:
                challenges[ch] = time.time() + 300
            return self.send(200, {'challenge': ch, 'expiresAt': iso(now() + timedelta(minutes=5))})
        if parts == ['recovery'] and method == 'GET':
            return self.send(200, {'providerId': f'http://127.0.0.1:{PORT}/v1', 'keyId': KEY_ID, 'publicJwk': pub_jwk(REC_KEY),
                                   'procedureUrl': f'http://127.0.0.1:{PORT}/procedure', 'delayDays': DELAY / 86400, 'notifies': ['devices'],
                                   'minimumAge': 18, 'canRead': True})
        if parts[:2] == ['recovery', 'requests']:
            return self.recovery(method, parts[2] if len(parts) > 2 else None)
        if TEST and parts[0] == 'debug':
            if parts[1:2] == ['dump'] and method == 'GET':
                with LOCK:
                    return self.send(200, {'wallets': wallets, 'recoveries': {k: {kk: vv for kk, vv in v.items()} for k, v in recoveries.items()}})
            if parts[1:2] == ['approve'] and method == 'POST':
                with LOCK:
                    recoveries[parts[2]]['approved'] = True
                return self.send(204)
        if parts[0] != 'wallets' or len(parts) < 2:
            return self.problem(404, 'not-found')
        wid = parts[1]
        w = wallets.get(wid)
        sub = parts[2] if len(parts) > 2 else None
        if sub is None:
            if method == 'GET':
                if not w:
                    return self.problem(404, 'no-wallet')
                return self.send(200, {'walletId': wid, 'createdAt': w['createdAt'], 'revision': w['keyring']['revision'], 'records': len(w['records']),
                                       'bytes': sum(len(json.dumps(i)) for _, i in w['records'].values())})
            if method == 'DELETE':
                if not w or not self.proven(w['address']):
                    return self.problem(403, 'proof')
                with LOCK:
                    del wallets[wid]
                    for k in [k for k, r in recoveries.items() if r['walletId'] == wid]:
                        del recoveries[k]
                return self.send(204)
        if sub == 'keyring':
            if method == 'GET':
                return self.send(200, w['keyring']) if w else self.problem(404, 'no-wallet')
            if method == 'PUT':
                b = self.body()
                kr = b['keyring']
                addr = 'vw1:' + kr['identity']['publicKey']['x']
                if w and addr != w['address']:
                    return self.problem(403, 'other-address')
                if not self.proven(addr):
                    return self.problem(403, 'proof')
                with LOCK:
                    if w and kr['revision'] < w['keyring']['revision']:
                        return self.problem(409, 'older-revision')
                    if not w:
                        wallets[wid] = {'address': addr, 'createdAt': b['createdAt'], 'keyring': kr, 'records': {}, 'cursor': 0}
                    else:
                        w['keyring'] = kr
                return self.send(204)
        if sub == 'records':
            if not w:
                return self.problem(404, 'no-wallet')
            if method == 'GET':
                after, limit = int(q.get('after', 0)), min(int(q.get('limit', 500)), 1000)
                items = sorted(((c, i) for c, i in w['records'].values() if c > after), key=lambda x: x[0])[:limit]
                cursor = items[-1][0] if items else after
                return self.send(200, {'items': [i for _, i in items], 'cursor': cursor, 'more': any(c > cursor for c, _ in w['records'].values())})
            if method == 'POST':
                if not self.proven(w['address']):
                    return self.problem(403, 'proof')
                added = erased = 0
                with LOCK:
                    for it in self.body():
                        rid = it['id']
                        cur = w['records'].get(rid)
                        if cur is None:
                            w['cursor'] += 1
                            w['records'][rid] = (w['cursor'], it)
                            added += 1
                        elif 'erased' in it and 'erased' not in cur[1]:
                            w['cursor'] += 1
                            w['records'][rid] = (w['cursor'], it)  # ciphertext dropped
                            erased += 1
                return self.send(200, {'added': added, 'erased': erased})
        if sub == 'notices' and method == 'GET':
            with LOCK:
                out = [{'kind': 'recovery-request', 'requestId': k, 'createdAt': r['createdAt'], 'readyAfter': r['readyAfter']}
                       for k, r in recoveries.items() if r['walletId'] == wid and r['status'] == 'waiting']
            return self.send(200, out)
        return self.problem(404, 'not-found')

    def recovery(self, method, rid):
        if rid is None and method == 'POST':
            b = self.body()
            w = wallets.get(b['walletId'])
            slot = w and next((s for s in w['keyring']['slots'] if s['id'] == b['slotId'] and s['kind'] == 'provider-recovery' and s['keyId'] == KEY_ID), None)
            if not slot:
                return self.problem(404, 'no-recovery-slot')
            rid = secrets.token_urlsafe(16)
            with LOCK:
                recoveries[rid] = {'walletId': b['walletId'], 'slotId': b['slotId'], 'clientEpk': b['clientEpk'], 'contact': b.get('contact', ''),
                                   'createdAt': iso(now()), 'readyAfter': iso(now() + timedelta(seconds=DELAY)), 'ready_ts': time.time() + DELAY,
                                   'approved': False, 'status': 'waiting'}
            return self.send(202, {'requestId': rid, 'readyAfter': recoveries[rid]['readyAfter']})
        r = recoveries.get(rid)
        if not r:
            return self.problem(404, 'no-request')
        if method == 'DELETE':
            w = wallets.get(r['walletId'])
            if not w or not self.proven(w['address']):
                return self.problem(403, 'proof')
            with LOCK:
                r['status'] = 'cancelled'
            return self.send(204)
        if method == 'GET':
            with LOCK:
                if r['status'] == 'waiting' and r['approved'] and time.time() >= r['ready_ts']:
                    w = wallets[r['walletId']]
                    slot = next(s for s in w['keyring']['slots'] if s['id'] == r['slotId'])
                    try:
                        dek = open_recovery_slot(r['walletId'], slot)
                    except InvalidTag:
                        return self.problem(409, 'slot-does-not-open')
                    r['status'] = 'released'
                    return self.send(200, {'status': 'ready', 'release': release(rid, dek, r['clientEpk'])})
                return self.send(200, {'status': r['status'], 'readyAfter': r['readyAfter']})
        return self.problem(405, 'method')

    # ---- GitHub contents API mock (subset), test mode only ----
    def github(self, method, path, q):
        if self.headers.get('Authorization') not in ('Bearer test-token', 'token test-token'):
            return self.send(401, {'message': 'Bad credentials'})
        m = re.fullmatch(r'/repos/([^/]+)/([^/]+)/contents/?(.*)', path)
        if not m:
            return self.send(404, {'message': 'Not Found'})
        owner, repo, fp = m.group(1), m.group(2), m.group(3).strip('/')
        key = (owner, repo, fp)
        with LOCK:
            if method == 'GET':
                if key in github:
                    f = github[key]
                    return self.send(200, {'type': 'file', 'path': fp, 'sha': f['sha'], 'content': base64.b64encode(f['content']).decode(), 'encoding': 'base64'})
                children = sorted({k[2][len(fp) + 1:].split('/')[0] for k in github if k[0] == owner and k[1] == repo and k[2].startswith(fp + '/')})
                if not children:
                    return self.send(404, {'message': 'Not Found'})
                out = []
                for c in children:
                    full = fp + '/' + c
                    if (owner, repo, full) in github:
                        out.append({'type': 'file', 'name': c, 'path': full, 'sha': github[(owner, repo, full)]['sha']})
                    else:
                        out.append({'type': 'dir', 'name': c, 'path': full})
                return self.send(200, out)
            if method == 'PUT':
                b = self.body()
                if key in github and b.get('sha') != github[key]['sha']:
                    return self.send(409, {'message': 'sha mismatch'})
                content = base64.b64decode(b['content'])
                github[key] = {'content': content, 'sha': hashlib.sha1(content).hexdigest()}
                return self.send(201 if 'sha' not in b else 200, {'content': {'path': fp, 'sha': github[key]['sha']}})
            if method == 'DELETE':
                b = self.body()
                if key not in github or b.get('sha') != github[key]['sha']:
                    return self.send(409, {'message': 'sha mismatch'})
                del github[key]
                return self.send(200, {'commit': {}})
        return self.send(405, {'message': 'method'})

    def do_GET(self):
        self.route('GET')

    def do_PUT(self):
        self.route('PUT')

    def do_POST(self):
        self.route('POST')

    def do_DELETE(self):
        self.route('DELETE')


if __name__ == '__main__':
    print(f'vledger reference provider on http://127.0.0.1:{PORT}/v1 (delay {DELAY}s, test={TEST})', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
