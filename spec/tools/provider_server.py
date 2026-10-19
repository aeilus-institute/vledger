"""Reference storage provider for aevri.vledger (openapi/provider.yaml), for tests and as a model for real providers.

    python tools/provider_server.py [port] [--delay SECONDS] [--test]

- Stores keyrings and envelopes in memory as sets, with a server cursor (SPEC 8). Never sees plain text.
- Wallet proof for writes (X-Vledger-Address / -Challenge / -Proof); the first keyring binds wallet id to address.
- Offers recovery (SPEC 4.4): its own P-256 recovery key, requests with notices, cancel by the holder, and release of
  the DEK wrapped to the requesting device's key after the procedure (identity approved and delay over).
- With --test: GET /debug/dump (everything stored, for leak checks) and POST /debug/approve/<requestId> (stands for
  the identity check), plus a minimal mock of the GitHub contents API under /gh/ (bearer token "test-token").
- Event streams (SPEC 20): three reference stream providers under /v1/streams/<name>:
  `city` (open, https, the holder finds themself), `brain` (private, https and relay, identifies the subscriber),
  `home` (private, relay only, reached by its address and the card directory, like a provider at home).
  With --test, /v1/debug/streams/<action>/<name> stands for the provider owner's screen: pairing codes, the pairing
  list with fingerprints, approval, emitting events, reading and moderating feedback.
- Attestations (SPEC 20.13): a reference issuer under /v1/attest (key, challenge, POST) like the institute's, and a
  closed stream `dept` (access "attested", requires member:test-unit; feedback requires account-verified). With
  --test, POST /v1/debug/attest/signin {"on": bool} stands for being signed in at the issuer.
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
import urllib.parse
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
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
ARB_KEY = Ed25519PrivateKey.generate()
inboxes = {}   # address -> [(received_ts, message)]
cards = {}     # address -> signed card
stamps = {}    # receiptDigest -> [stamp]
cases = {}     # caseId -> case
RELAY_MAX = 256 * 1024
RELAY_DAYS = 14
KEY_ID = 'reference-recovery-' + secrets.token_hex(4)
ORG_KEY = Ed25519PrivateKey.generate()          # a test organisation that publishes a registry
ORG_EC = ec.generate_private_key(ec.SECP256R1())


def canon(v):
    if v is None:
        return 'null'
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return repr(v) if not v.is_integer() else str(int(v))
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return '[' + ','.join(canon(x) for x in v) + ']'
    return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canon(v[k]) for k in sorted(v, key=lambda k: k.encode('utf-16-be'))) + '}'


def ed_ok(x, data, sig):
    try:
        Ed25519PublicKey.from_public_bytes(ub64(x)).verify(ub64(sig), data)
        return True
    except (InvalidSignature, ValueError):
        return False


def arb_pub():
    return {'alg': 'Ed25519', 'x': b64u(ARB_KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))}


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


# ---- event streams (SPEC 20): reference providers ----

def b32fp(address):
    return base64.b32encode(hashlib.sha256(address.encode()).digest()).decode().rstrip('=')


def sha256_json(v):
    return 'sha256:' + hashlib.sha256(canon(v).encode()).hexdigest()


def msg_key(shared, mid, to):
    return hkdf(shared, f'aevri.vledger/1|message|{mid}|{to}')


def uuid7():
    ms = int(time.time() * 1000)
    b = bytearray(os.urandom(16))
    b[0:6] = ms.to_bytes(6, 'big')
    b[6] = (b[6] & 0x0f) | 0x70
    b[8] = (b[8] & 0x3f) | 0x80
    h = b.hex()
    return f'{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}'


def seal_message(to, enc_jwk, body, sender=None):
    """SPEC 11: ECDH(ephemeral, recipient encKey) + HKDF + AES-GCM; `sender` = (address, Ed25519 key) signs."""
    mid = uuid7()
    eph = ec.generate_private_key(ec.SECP256R1())
    key = msg_key(eph.exchange(ec.ECDH(), ec_pub(enc_jwk)), mid, to)
    iv = os.urandom(12)
    info = f'aevri.vledger/1|message|{mid}|{to}'.encode()
    msg = {'type': 'aevri.vledger.message', 'version': 1, 'id': mid, 'to': to, 'sentAt': iso(now()), 'epk': pub_jwk(eph),
           'iv': b64u(iv), 'ct': b64u(AESGCM(key).encrypt(iv, canon(body).encode(), info))}
    if sender:
        msg['from'] = sender[0]
        msg['sig'] = b64u(sender[1].sign(canon(msg).encode()))
    return msg


def open_message(priv, address, msg):
    """Returns (body, from or None, verified). Raises on anything not for `address`."""
    if msg.get('to') != address:
        raise ValueError('not for us')
    key = msg_key(priv.exchange(ec.ECDH(), ec_pub(msg['epk'])), msg['id'], msg['to'])
    info = f"aevri.vledger/1|message|{msg['id']}|{msg['to']}".encode()
    body = json.loads(AESGCM(key).decrypt(ub64(msg['iv']), ub64(msg['ct']), info))
    frm, ok = msg.get('from'), False
    if frm and msg.get('sig'):
        rest = {k: v for k, v in msg.items() if k != 'sig'}
        ok = ed_ok(frm[4:], canon(rest).encode(), msg['sig'])
    return body, frm, ok


def relay_send(msg):
    with LOCK:
        inboxes.setdefault(msg['to'], []).append((time.time(), msg))


def relay_take(addr):
    with LOCK:
        return [m for ts, m in inboxes.pop(addr, []) if ts > time.time() - RELAY_DAYS * 86400]


ISS_KEY = Ed25519PrivateKey.generate()
ISS_ADDR = 'vw1:' + b64u(ISS_KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
ISS_CLAIMS = {'account-verified': 'A signed-in account with a confirmed e-mail address (reference issuer).',
              'member:test-unit': 'A member of the test unit (reference issuer).'}
iss_state = {'signed_in': True, 'challenges': {}}


def iss_info():
    doc = {'type': 'aevri.vledger.issuer', 'version': 1, 'issuer': ISS_ADDR, 'issuerName': 'Reference issuer', 'claims': ISS_CLAIMS,
           'lifetimeDays': 30, 'audience': 'required', 'revocation': 'none in the pilot'}
    return {'issuerInfo': doc, 'sig': b64u(ISS_KEY.sign(canon(doc).encode()))}


def att_ok(doc, requires, subject, provider, stream_id):
    """SPEC 20.13: issuer signature, issuer and claim as required, type, version, validity, audience, subject."""
    a = (doc or {}).get('attestation') or {}
    if a.get('type') != 'aevri.vledger.attestation' or a.get('version') != 1:
        return False
    if a.get('issuer') != requires['issuer'] or a.get('claim') != requires['claim'] or a.get('subject') != subject:
        return False
    if a.get('audience') != {'providerAddress': provider, 'streamId': stream_id}:
        return False
    if not (a.get('issuedAt', '9') <= iso(now() + timedelta(minutes=5)) and a.get('expiresAt', '') > iso(now())):
        return False
    return ed_ok(a['issuer'][4:], canon(a).encode(), doc.get('sig', ''))


class Stream:
    """One reference stream provider. Keeps events, subscriptions and feedback in memory."""

    def __init__(self, name, title, access, transport, identifies, audience, feedback, kind='device', requires=None):
        self.name, self.key, self.ec = name, Ed25519PrivateKey.generate(), ec.generate_private_key(ec.SECP256R1())
        self.address = 'vw1:' + b64u(self.key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
        self.stream_id = uuid7()
        self.rev = 1
        self.title, self.access, self.transport, self.identifies, self.audience, self.fb, self.kind = title, access, transport, identifies, audience, feedback, kind
        self.events = []         # [(seq, recipient or None, signed event)]
        self.seq = 0
        self.codes = {}          # code -> expiry (one-time)
        self.pairings = {}       # request hash -> {subscriber, status, subscriptionId, fp, via}
        self.subs = {}           # subscriptionId -> {address, encKey, active}
        self.items = {}          # (key, feedbackId) -> {item, status, statusRev, hash}
        self.extra = {}          # descriptor fields changed by tests
        self.requires = requires
        self.att_challenges = {}  # one-time subscribe challenges handed out for attested streams

    @property
    def base(self):
        return f'http://127.0.0.1:{PORT}/v1/streams/{self.name}'

    def descriptor(self):
        s = {'type': 'aevri.vledger.stream', 'version': 1, 'descriptorRev': self.rev, 'streamId': self.stream_id, 'title': self.title,
             'provider': {'name': 'Reference ' + self.name, 'kind': self.kind, 'address': self.address, 'encKey': pub_jwk(self.ec)},
             'access': self.access, 'transport': self.transport, 'identifies': self.identifies, 'audience': self.audience,
             'eventKinds': ['meeting', 'call', 'visit', 'publication', 'other'],
             'policy': {'keeps': f'events of the {self.name} test stream, in memory of the reference server', 'retentionDays': 1,
                        'deletesOnLeave': True, 'rawStays': True},
             'updatedAt': '2026-10-19T09:00:00Z'}
        if 'https' in self.transport:
            s['endpoint'] = self.base
        if 'relay' in self.transport:
            s['relay'] = f'http://127.0.0.1:{PORT}/v1/relay'
        if self.fb:
            s['feedback'] = self.fb
        if self.requires:
            s['requires'] = self.requires
        s.update(self.extra)
        return {'stream': s, 'sig': b64u(self.key.sign(canon(s).encode()))}

    def card(self):
        c = {'type': 'aevri.vledger.card', 'version': 1, 'address': self.address, 'kind': self.kind, 'name': 'Reference ' + self.name,
             'encKey': pub_jwk(self.ec), 'storage': {'stores': True, 'purpose': 'Event stream', 'retentionDays': 1, 'publishes': (self.fb or {}).get('publishes', 'no')},
             'updatedAt': '2026-10-19T09:00:00Z'}
        return {'card': c, 'sig': b64u(self.key.sign(canon(c).encode()))}

    def sign_event(self, e):
        e = {k: v for k, v in e.items() if k != 'sig'}
        e['sig'] = b64u(self.key.sign(canon(e).encode()))
        return e

    def me(self):
        return (self.address, self.key)

    # -- pairing (20.4) --
    def subscribe_attested(self, body, via):
        sub = body.get('subscriber') or {}
        addr, ch, atts = sub.get('address', ''), body.get('challenge', ''), body.get('attestations') or []
        if self.access != 'attested' or body.get('streamId') != self.stream_id or not re.fullmatch(r'vw1:[A-Za-z0-9_-]{43}', addr) or not atts:
            return None
        signed = {'purpose': 'aevri.vledger/1|subscribe-attested', 'providerAddress': self.address, 'streamId': self.stream_id,
                  'challenge': ch, 'subscriber': sub, 'attestationHashes': [sha256_json(a) for a in atts]}
        if not ed_ok(addr[4:], canon(signed).encode(), body.get('proof', '')):
            return None
        good = [a for a in atts if att_ok(a, self.requires, addr, self.address, self.stream_id)]
        if not good:
            return None
        with LOCK:
            if ch.startswith('t:'):   # wallet-made for relay-only streams: fresh and used once
                if not (iso(now() - timedelta(minutes=5)) <= ch[2:22] <= iso(now() + timedelta(minutes=1))) or ch in self.att_challenges:
                    return None
                self.att_challenges[ch] = time.time() + 600
            else:
                exp = challenges.pop(ch, None)
                if not exp or exp < time.time():
                    return None
            sid, s = self.sub_by_address(addr)
            expires = good[0]['attestation']['expiresAt']
            if sid:                            # renewal: the same key brings a fresh attestation
                s['expiresAt'] = max(s.get('expiresAt', ''), expires)
            else:
                sid = 'sub-' + secrets.token_hex(8)
                self.subs[sid] = {'address': addr, 'encKey': sub['encKey'], 'active': True, 'expiresAt': expires}
        return {'kind': 'subscribed', 'streamId': self.stream_id, 'subscriptionId': sid, 'descriptor': self.descriptor()}

    def subscribe(self, body, via):
        sub = body.get('subscriber') or {}
        addr, code = sub.get('address', ''), body.get('code', '')
        if not re.fullmatch(r'vw1:[A-Za-z0-9_-]{43}', addr) or not isinstance(code, str):
            return None
        signed = {'purpose': 'aevri.vledger/1|subscribe', 'providerAddress': self.address, 'code': code, 'subscriber': sub}
        if 'streamId' in body:
            if body['streamId'] != self.stream_id:
                return None
            signed['streamId'] = body['streamId']
        if not ed_ok(addr[4:], canon(signed).encode(), body.get('proof', '')):
            return None
        h = sha256_json(body)
        with LOCK:
            if h in self.pairings:                 # a repeated identical request returns the same answer
                return self.pairings[h]
            exp = self.codes.pop(code, None)       # one time, consumed atomically
            if not exp or exp < time.time():
                return None
            p = {'subscriber': sub, 'status': 'pending', 'fp': b32fp(addr)[:8], 'via': via, 'hash': h}
            self.pairings[h] = p
        return p

    def answer(self, p):
        if p['status'] != 'approved':
            return {'kind': 'pending'}
        return {'kind': 'subscribed', 'streamId': self.stream_id, 'subscriptionId': p['subscriptionId'], 'descriptor': self.descriptor()}

    def approve(self, fp8):
        with LOCK:
            for p in self.pairings.values():
                if p['status'] == 'pending' and p['fp'] == fp8:
                    p['status'] = 'approved'
                    p['subscriptionId'] = 'sub-' + secrets.token_hex(8)
                    self.subs[p['subscriptionId']] = {'address': p['subscriber']['address'], 'encKey': p['subscriber']['encKey'], 'active': True}
                    break
            else:
                return None
        if p['via'] == 'relay':
            relay_send(seal_message(p['subscriber']['address'], p['subscriber']['encKey'], self.answer(p), self.me()))
        return p

    def sub_by_address(self, addr):
        return next(((sid, s) for sid, s in self.subs.items() if s['address'] == addr and s['active']), (None, None))

    def expired(self, s):
        return bool(s and s.get('expiresAt') and s['expiresAt'] <= iso(now()))

    def unsubscribe(self, sid):
        s = self.subs.get(sid)
        if not s:
            return None
        with LOCK:
            s['active'] = False
            self.events = [x for x in self.events if x[1] != s['address']]   # deletesOnLeave
        r = {'kind': 'unsubscribed', 'streamId': self.stream_id, 'subscriptionId': sid, 'deleted': True, 'at': iso(now())}
        r['sig'] = b64u(self.key.sign(canon(r).encode()))
        return r

    # -- events (20.5) --
    def emit(self, specs, owner_ref='p-owner'):
        out = []
        for spec in specs:
            base = {'type': 'aevri.vledger.stream-event', 'version': 1, 'streamId': self.stream_id, 'rev': 1, 'occurredAt': iso(now()), 'kind': 'other'}
            base.update({k: v for k, v in spec.items() if k != 'raw'})
            targets = [None] if self.access == 'open' else [s['address'] for s in self.subs.values() if s['active'] and not self.expired(s)]
            for rcp in targets:
                e = json.loads(json.dumps(base))
                if rcp:
                    e['recipient'] = rcp
                    for p in e.get('participants', []):
                        if self.identifies == 'provider' and p.get('ref') == owner_ref:
                            p['you'] = True
                e = spec['raw'] if spec.get('raw') else self.sign_event(e)
                with LOCK:
                    self.seq += 1
                    self.events.append((self.seq, rcp, e))
                out.append(e)
                if rcp and 'relay' in self.transport:
                    sid, s = self.sub_by_address(rcp)
                    relay_send(seal_message(rcp, s['encKey'], {'kind': 'stream-events', 'events': [e]}, self.me()))
        return out

    def page(self, rcp, after):
        with LOCK:
            items = [(n, e) for n, r, e in self.events if n > after and r == rcp][:100]
        return items, str(items[-1][0] if items else after)

    # -- feedback (20.11) --
    def receipt(self, it):
        r = {'kind': 'feedback-receipt', 'providerAddress': self.address, 'streamId': self.stream_id, 'feedbackId': it['item']['feedbackId'],
             'itemHash': it['hash'], 'statusRev': it['statusRev'], 'status': it['status']}
        if it.get('reason'):
            r['reason'] = it['reason']
        r['sig'] = b64u(self.key.sign(canon(r).encode()))
        item = it['item']
        return seal_message(item['key'], item['replyEncKey'], r, self.me())

    def feedback(self, body):
        """Handles stream-feedback, feedback-status and feedback-withdraw. Returns the reply message or None."""
        kind = body.get('kind')
        if kind in ('feedback-status', 'feedback-withdraw'):
            with LOCK:
                it = next((v for (k, f), v in self.items.items() if f == body.get('feedbackId')), None)
            if not it:
                return None
            rest = {k: v for k, v in body.items() if k != 'sig'}
            if not ed_ok(it['item']['key'][4:], canon(rest).encode(), body.get('sig', '')) or body.get('providerAddress') != self.address:
                return None
            if kind == 'feedback-withdraw' and it['status'] != 'withdrawn':
                with LOCK:
                    it['status'], it['statusRev'] = 'withdrawn', it['statusRev'] + 1
                    it['item'] = {k: it['item'][k] for k in ('feedbackId', 'key', 'replyEncKey')}   # a small tombstone
            return self.receipt(it)
        if kind != 'stream-feedback' or not self.fb:
            return None
        item = body
        key = item.get('key', '')
        rest = {k: v for k, v in item.items() if k != 'sig'}
        if not re.fullmatch(r'vw1:[A-Za-z0-9_-]{43}', key) or not ed_ok(key[4:], canon(rest).encode(), item.get('sig', '')):
            return None
        if item.get('providerAddress') != self.address or item.get('streamId') != self.stream_id:
            return None
        dedup = (key, item.get('feedbackId'))
        with LOCK:
            if dedup in self.items:
                return self.receipt(self.items[dedup])
        reason = None
        fb = self.fb
        if item.get('type') not in fb['accepts'] or item.get('sender') not in fb['senders']:
            reason = 'not accepted by this stream'
        elif fb['publishes'] != 'sender-choice' and item.get('publish') != fb['publishes']:
            reason = 'the publish choice does not match the stream policy'
        elif (item.get('sender') == 'named') != ('card' in item):
            reason = 'a card goes with named items only'
        elif item.get('sender') == 'named' and (item['card'].get('card', {}).get('address') != key or not ed_ok(key[4:], canon(item['card']['card']).encode(), item['card'].get('sig', ''))):
            reason = 'the card does not match the key'
        elif item.get('sender') == 'subscriber' and not self.sub_by_address(key)[0]:
            reason = 'not a subscriber'
        elif fb.get('requires') and item.get('sender') != 'named' and not any(att_ok(a, fb['requires'], key, self.address, self.stream_id) for a in item.get('attestations') or []):
            reason = 'no valid attestation for this stream'
        elif item.get('type') in ('assessment', 'participation') and not any(e.get('eventId') == (item.get('about') or {}).get('eventId') for _, _, e in self.events):
            reason = 'no such event in this stream'
        status = 'rejected' if reason else ('pending' if fb['moderation'] == 'before' else 'published')
        it = {'item': item, 'status': status, 'statusRev': 1, 'hash': sha256_json(item), **({'reason': reason} if reason else {})}
        with LOCK:
            self.items[dedup] = it
        return self.receipt(it)

    def moderate(self, feedback_id, status):
        with LOCK:
            it = next((v for (k, f), v in self.items.items() if f == feedback_id), None)
            if not it or it['status'] == 'withdrawn':
                return None
            it['status'], it['statusRev'] = status, it['statusRev'] + 1
        if 'relay' in self.transport:
            relay_send(self.receipt(it))   # over https only, the sender asks for a later status
        return it

    # -- the provider's own relay inbox --
    def poll_relay(self):
        for m in relay_take(self.address):
            try:
                body, frm, ok = open_message(self.ec, self.address, m)
            except Exception:
                continue
            kind = body.get('kind')
            if kind == 'subscribe' and ok and frm == (body.get('subscriber') or {}).get('address') and 'attestations' in body:
                ans = self.subscribe_attested(body, 'relay')
                if ans:
                    relay_send(seal_message(frm, body['subscriber']['encKey'], ans, self.me()))
            elif kind == 'subscribe' and ok and frm == (body.get('subscriber') or {}).get('address'):
                p = self.subscribe(body, 'relay')
                if p and p['status'] == 'approved':
                    relay_send(seal_message(frm, p['subscriber']['encKey'], self.answer(p), self.me()))
            elif kind in ('unsubscribe', 'replay') and ok:
                sid, s = self.sub_by_address(frm)
                if not sid or (body.get('subscriptionId') not in (None, sid)) or body.get('streamId') != self.stream_id:
                    continue
                if kind == 'unsubscribe':
                    relay_send(seal_message(frm, s['encKey'], self.unsubscribe(sid), self.me()))
                else:
                    items, _ = self.page(frm, 0)
                    since = body.get('since') or ''
                    evs = [e for _, e in items if str(e.get('occurredAt', '')) >= since][:100]
                    if evs:
                        relay_send(seal_message(frm, s['encKey'], {'kind': 'stream-events', 'events': evs}, self.me()))
            elif kind in ('stream-feedback', 'feedback-status', 'feedback-withdraw'):
                r = self.feedback(body)
                if r:
                    relay_send(r)


FB_ALL = ['assessment', 'participation', 'event']
STREAMS = {
    'city': Stream('city', 'Kolossi road works (reference)', 'open', ['https'], 'holder', 'public',
                   {'accepts': FB_ALL, 'senders': ['anonymous', 'named'], 'moderation': 'before', 'publishes': 'sender-choice', 'retentionDays': 30}, kind='state'),
    'brain': Stream('brain', 'Meetings and calls (reference second brain)', 'code', ['https', 'relay'], 'provider', 'participants',
                    {'accepts': ['assessment', 'participation'], 'senders': ['anonymous', 'subscriber', 'named'], 'moderation': 'none', 'publishes': 'no', 'retentionDays': 30}),
    'home': Stream('home', 'Home device (reference, relay only)', 'code', ['relay'], 'provider', 'participants',
                   {'accepts': ['assessment', 'participation'], 'senders': ['anonymous', 'subscriber'], 'moderation': 'after', 'publishes': 'no', 'retentionDays': 30}),
}
STREAMS['dept'] = Stream('dept', 'Test unit news (reference, closed)', 'attested', ['https', 'relay'], 'holder', 'selected-readers',
                         {'accepts': FB_ALL, 'senders': ['anonymous', 'subscriber', 'named'], 'moderation': 'none', 'publishes': 'sender-choice',
                          'retentionDays': 30, 'requires': {'issuer': ISS_ADDR, 'claim': 'account-verified'}},
                         kind='organization', requires={'issuer': ISS_ADDR, 'claim': 'member:test-unit'})
cards[STREAMS['home'].address] = STREAMS['home'].card()


def relay_worker():
    while True:
        for st in STREAMS.values():
            try:
                st.poll_relay()
            except Exception:  # keep serving
                pass
        time.sleep(0.2)


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
            parts = [urllib.parse.unquote(x) for x in path[4:].strip('/').split('/')]
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
        if parts[0] == 'relay':
            return self.relay(method, parts[1:])
        if parts[0] == 'arbiter':
            return self.arbiter(method, parts[1:])
        if parts[0] == 'attest':
            return self.attest(method, parts[1:])
        if TEST and parts == ['debug', 'attest', 'signin'] and method == 'POST':
            iss_state['signed_in'] = bool(self.body().get('on'))
            return self.send(200, {'signedIn': iss_state['signed_in']})
        if TEST and parts[:3] == ['debug', 'streams', 'expire'] and len(parts) == 4 and parts[3] in STREAMS:
            with LOCK:
                for sub in STREAMS[parts[3]].subs.values():
                    sub['expiresAt'] = '2000-01-01T00:00:00Z'
            return self.send(200, {'expired': True})
        if parts[0] == 'streams' and len(parts) >= 2 and parts[1] in STREAMS:
            return self.stream(method, STREAMS[parts[1]], parts[2:], q)
        if TEST and parts[:2] == ['debug', 'streams'] and len(parts) >= 4 and parts[3] in STREAMS:
            return self.stream_debug(method, parts[2], STREAMS[parts[3]])
        if TEST and parts == ['registry', 'test'] and method == 'GET':
            return self.registry()
        if parts[:2] == ['recovery', 'requests']:
            return self.recovery(method, parts[2] if len(parts) > 2 else None)
        if TEST and parts[0] == 'debug':
            if parts[1:2] == ['dump'] and method == 'GET':
                with LOCK:
                    return self.send(200, {'wallets': wallets, 'recoveries': {k: {kk: vv for kk, vv in v.items()} for k, v in recoveries.items()}, 'inboxes': inboxes, 'cards': cards, 'stamps': stamps, 'cases': cases})
            if parts[1:2] == ['rule'] and method == 'POST':
                return self.rule(parts[2])
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

    # ---- relay (openapi/relay.yaml) ----
    def relay(self, method, parts):
        if parts == ['policy'] and method == 'GET':
            return self.send(200, {'maxHoldDays': RELAY_DAYS, 'logsContent': False, 'maxBytes': RELAY_MAX})
        if parts == ['challenge'] and method == 'GET':
            ch = secrets.token_urlsafe(24)
            with LOCK:
                challenges[ch] = time.time() + 300
            return self.send(200, {'challenge': ch})
        if parts == ['messages'] and method == 'POST':
            raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
            if len(raw) > RELAY_MAX:
                return self.problem(413, 'too-large')
            m = json.loads(raw)
            if m.get('type') != 'aevri.vledger.message' or not re.fullmatch(r'vw1:[A-Za-z0-9_-]{43}', m.get('to', '')):
                return self.problem(422, 'not-a-message')
            with LOCK:
                inboxes.setdefault(m['to'], []).append((time.time(), m))
            return self.send(202, {'accepted': True})
        if len(parts) == 2 and parts[0] == 'inbox' and method == 'GET':
            addr = parts[1]
            if not self.proven(addr):
                return self.problem(403, 'proof')
            with LOCK:
                items = [m for ts, m in inboxes.pop(addr, []) if ts > time.time() - RELAY_DAYS * 86400]
            return self.send(200, items)
        if len(parts) == 2 and parts[0] == 'cards':
            addr = parts[1]
            if method == 'GET':
                return self.send(200, cards[addr]) if addr in cards else self.problem(404, 'no-card')
            if method == 'PUT':
                doc = self.body()
                c = doc.get('card', {})
                if c.get('address') != addr or not ed_ok(addr[4:], canon(c).encode(), doc.get('sig', '')):
                    return self.problem(422, 'bad-card')
                with LOCK:
                    cards[addr] = doc
                return self.send(204)
            if method == 'DELETE':
                if not self.proven(addr):
                    return self.problem(403, 'proof')
                with LOCK:
                    cards.pop(addr, None)
                return self.send(204)
        return self.problem(404, 'not-found')

    # ---- event streams (SPEC 20) ----
    def stream_proof(self, st, method):
        addr = self.headers.get('X-Vledger-Address', '')
        ch = self.headers.get('X-Vledger-Challenge', '')
        with LOCK:
            exp = challenges.pop(ch, None)
        sid, sub = st.sub_by_address(addr)
        if not exp or exp < time.time() or not sid:
            return None, None
        if st.expired(sub):   # checked on every private fetch (20.13)
            return 'expired', None
        signed = {'purpose': 'aevri.vledger/1|stream-request', 'challenge': ch, 'method': method, 'pathAndQuery': self.path,
                  'streamId': st.stream_id, 'subscriptionId': sid}
        return (sid, sub) if ed_ok(addr[4:], canon(signed).encode(), self.headers.get('X-Vledger-Proof', '')) else (None, None)

    def stream(self, method, st, parts, q):
        if parts == ['descriptor'] and method == 'GET':
            return self.send(200, st.descriptor())
        if 'https' not in st.transport:
            return self.problem(404, 'not-found')
        if parts == ['challenge'] and method == 'GET':
            ch = secrets.token_urlsafe(24)
            with LOCK:
                challenges[ch] = time.time() + 300
            return self.send(200, {'challenge': ch})
        if parts == ['subscriptions'] and method == 'POST' and st.access == 'attested':
            ans = st.subscribe_attested(self.body(), 'https')
            return self.send(200, ans) if ans else self.problem(403, 'attestation')
        if parts == ['subscriptions'] and method == 'POST' and st.access == 'code':
            p = st.subscribe(self.body(), 'https')
            if not p:
                return self.problem(403, 'code')
            ans = st.answer(p)
            return self.send(200 if ans['kind'] == 'subscribed' else 202, ans)
        if len(parts) == 2 and parts[0] == 'subscriptions' and method == 'DELETE':
            sid, _ = self.stream_proof(st, 'DELETE')
            if not sid or sid != parts[1]:
                return self.problem(403, 'proof')
            return self.send(200, st.unsubscribe(sid))
        if parts == ['events'] and method == 'GET':
            after = int(q.get('after') or 0)
            if st.access == 'open':
                items, cur = st.page(None, after)
                return self.send(200, {'events': [e for _, e in items], 'cursor': cur})
            sid, sub = self.stream_proof(st, 'GET')
            if sid == 'expired':
                return self.problem(403, 'attestation-expired')
            if not sid:
                return self.problem(403, 'proof')
            items, cur = st.page(sub['address'], after)
            evs = [seal_message(sub['address'], sub['encKey'], {'kind': 'stream-events', 'events': [e for _, e in items]}, st.me())] if items else []
            return self.send(200, {'events': evs, 'cursor': cur})
        if parts == ['feedback'] and method == 'POST':
            try:
                body, _, _ = open_message(st.ec, st.address, self.body())
            except Exception:
                return self.problem(422, 'not-a-message')
            r = st.feedback(body)
            return self.send(200, r) if r else self.problem(422, 'refused')
        return self.problem(404, 'not-found')

    def attest(self, method, parts):
        """Reference issuer (SPEC 20.13), like the institute's: key public, the rest needs a signed-in account."""
        if parts == ['key'] and method == 'GET':
            return self.send(200, iss_info())
        if not iss_state['signed_in']:
            return self.problem(401, 'sign-in')
        if parts == ['challenge'] and method == 'GET':
            c = secrets.token_urlsafe(24)
            with LOCK:
                iss_state['challenges'][c] = time.time() + 300
            return self.send(200, {'challenge': c, 'expiresAt': iso(now() + timedelta(minutes=5))})
        if parts == [] and method == 'POST':
            b = self.body()
            subject, claim, aud, ch = b.get('subject', ''), b.get('claim', ''), b.get('audience') or {}, b.get('challenge', '')
            if claim not in ISS_CLAIMS:
                return self.problem(400, 'claim')
            if set(aud) != {'providerAddress', 'streamId'}:
                return self.problem(400, 'audience')
            with LOCK:
                exp = iss_state['challenges'].pop(ch, None)
            if not exp or exp < time.time():
                return self.problem(403, 'challenge')
            signed = {'purpose': 'aevri.vledger/1|attest', 'issuer': ISS_ADDR, 'subject': subject, 'claim': claim, 'audience': aud, 'challenge': ch}
            if not re.fullmatch(r'vw1:[A-Za-z0-9_-]{43}', subject) or not ed_ok(subject[4:], canon(signed).encode(), b.get('proof', '')):
                return self.problem(403, 'proof')
            a = {'type': 'aevri.vledger.attestation', 'version': 1, 'issuer': ISS_ADDR, 'issuerName': 'Reference issuer', 'subject': subject,
                 'claim': claim, 'audience': {'providerAddress': aud['providerAddress'], 'streamId': aud['streamId']},
                 'issuedAt': iso(now()), 'expiresAt': iso(now() + timedelta(days=30))}
            return self.send(201, {'attestation': a, 'sig': b64u(ISS_KEY.sign(canon(a).encode()))})
        return self.problem(404, 'not-found')

    def stream_debug(self, method, action, st):
        """Stands for the provider owner's own screen (test mode only)."""
        if action == 'code' and method == 'POST':
            code = secrets.token_urlsafe(16)          # 128 random bits
            with LOCK:
                st.codes[code] = time.time() + 600
            return self.send(200, {'code': code, 'descriptorUrl': st.base + '/descriptor', 'address': st.address, 'streamId': st.stream_id})
        if action == 'pairings' and method == 'GET':
            return self.send(200, [{'fingerprint8': p['fp'], 'status': p['status']} for p in st.pairings.values()])
        if action == 'approve' and method == 'POST':
            p = st.approve(self.body().get('fingerprint8', ''))
            return self.send(200, {'subscriptionId': p['subscriptionId']}) if p else self.problem(404, 'no-pairing')
        if action == 'emit' and method == 'POST':
            b = self.body()
            return self.send(200, {'events': st.emit(b.get('events', []), b.get('ownerRef', 'p-owner'))})
        if action == 'feedback' and method == 'GET':
            with LOCK:
                return self.send(200, [dict(v, key=k[0]) for k, v in st.items.items()])
        if action == 'moderate' and method == 'POST':
            b = self.body()
            it = st.moderate(b.get('feedbackId'), b.get('status', 'published'))
            return self.send(200, {'status': it['status']}) if it else self.problem(404, 'no-item')
        if action == 'descriptor' and method == 'POST':
            b = self.body()
            with LOCK:
                st.rev += 1
                st.extra.update(b)
            return self.send(200, st.descriptor())
        if action == 'subs' and method == 'GET':
            return self.send(200, st.subs)
        return self.problem(404, 'not-found')

    # ---- a signed registry of a test organisation (SPEC 12), test mode only ----
    def registry(self):
        url = f'http://127.0.0.1:{PORT}/v1/registry/test'
        n = ORG_EC.public_key().public_numbers()
        card = {'type': 'aevri.vledger.card', 'version': 1, 'address': 'vw1:' + b64u(ORG_KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)),
                'kind': 'organization', 'name': 'Test Institute', 'encKey': {'kty': 'EC', 'crv': 'P-256', 'x': b64u(n.x.to_bytes(32, 'big')), 'y': b64u(n.y.to_bytes(32, 'big'))},
                'inbox': f'http://127.0.0.1:{PORT}/v1/relay', 'registryUrl': url,
                'storage': {'stores': True, 'purpose': 'Testing', 'retentionDays': 1, 'publishes': 'sender-choice'}, 'updatedAt': '2026-10-17T00:00:00Z'}
        owner = {'card': card, 'sig': b64u(ORG_KEY.sign(canon(card).encode()))}
        reg = {'type': 'aevri.vledger.registry', 'version': 1, 'registryUrl': url, 'owner': owner, 'updatedAt': iso(now()),
               'systems': [{'systemId': 'research', 'title': 'Research and methods'}],
               'items': [{'itemId': 'how-to-assess-value', 'kind': 'object', 'title': 'How to Assess Value', 'system': 'research', 'category': 'information',
                          'actions': ['read', 'applied'], 'plan': {'promise': 'A method you can apply this week'}}],
               'references': [{'system': 'research', 'phrase': 'Readers of "How to Assess Value"', 'v': 0.02, 'words': 'Median of 5 readers who shared it'}]}
        return self.send(200, {'registry': reg, 'sig': b64u(ORG_KEY.sign(canon(reg).encode()))})

    # ---- arbiter (openapi/arbiter.yaml): key, stamps, lookup, cases ----
    def arbiter(self, method, parts):
        if parts == ['key'] and method == 'GET':
            return self.send(200, {'key': arb_pub(), 'rulesUrl': f'http://127.0.0.1:{PORT}/rules', 'modes': ['attest', 'opinion', 'binding']})
        if parts == ['challenge'] and method == 'GET':
            ch = secrets.token_urlsafe(24)
            with LOCK:
                challenges[ch] = time.time() + 300
            return self.send(200, {'challenge': ch})
        if parts == ['stamps'] and method == 'POST':
            b = self.body()
            d = bytes.fromhex(b['receiptDigest'][7:])
            keys = b['keys']
            if len(keys) < 2 or not all(ed_ok(keys[s_['party']]['x'], d, s_['sig']) for s_ in b['signatures']):
                return self.problem(422, 'bad-signature')
            stamp = {'type': 'aevri.vledger.stamp', 'receiptDigest': b['receiptDigest'],
                     'parties': ['sha256:' + hashlib.sha256(canon(k).encode()).hexdigest() for k in keys],
                     'receivedAt': iso(now()), 'arbiter': {'url': f'http://127.0.0.1:{PORT}/v1/arbiter', 'key': arb_pub()}}
            stamp['sig'] = b64u(ARB_KEY.sign(canon(stamp).encode()))
            with LOCK:
                stamps.setdefault(b['receiptDigest'], []).append(stamp)
            return self.send(201, stamp)
        if len(parts) == 2 and parts[0] == 'stamps' and method == 'GET':
            digest = parts[1]
            addr = self.headers.get('X-Vledger-Address', '')
            thumb = 'sha256:' + hashlib.sha256(canon({'alg': 'Ed25519', 'x': addr[4:]}).encode()).hexdigest()
            st = stamps.get(digest, [])
            if not st or thumb not in st[0]['parties'] or not self.proven(addr):
                return self.problem(403, 'not-a-party')
            return self.send(200, st)
        if parts == ['cases'] and method == 'POST':
            b = self.body()
            receipt, sigs, claimant = b.get('receipt') or {}, b.get('signatures') or [], b.get('claimant', -1)
            parties = receipt.get('parties') or []
            digest = 'sha256:' + hashlib.sha256(canon(receipt).encode()).hexdigest()
            d = bytes.fromhex(digest[7:])
            valid = {s_['party'] for s_ in sigs if 0 <= s_.get('party', -1) < len(parties) and ed_ok(parties[s_['party']]['key']['x'], d, s_['sig'])}
            addr = self.headers.get('X-Vledger-Address', '')
            if not (0 <= claimant < len(parties)) or claimant not in valid or addr != 'vw1:' + parties[claimant]['key']['x'] or not self.proven(addr):
                return self.problem(403, 'not-a-party')
            if b['caseId'] in cases:
                return self.problem(409, 'case-exists')
            mandate = receipt.get('mandate') or {}
            binding_ok = len(valid) == len(parties) and mandate.get('mode') == 'binding' and (mandate.get('arbiter') or {}).get('key', {}).get('x') == arb_pub()['x']
            if b.get('request') == 'decision' and not binding_ok:
                return self.problem(409, 'no-binding-mandate')
            with LOCK:
                cases[b['caseId']] = {**b, 'receiptDigest': digest, 'bindingAllowed': binding_ok, 'status': 'open'}
            return self.send(202, {'caseId': b['caseId'], 'status': 'open', 'bindingAllowed': binding_ok})
        if len(parts) == 2 and parts[0] == 'cases' and method == 'GET':
            c = cases.get(parts[1])
            addr = self.headers.get('X-Vledger-Address', '')
            if not c or addr not in ['vw1:' + p_['key']['x'] for p_ in c['receipt']['parties']] or not self.proven(addr):
                return self.problem(403, 'not-a-party')
            return self.send(200, {'caseId': c['caseId'], 'status': c['status'], **({'ruling': c['ruling']} if 'ruling' in c else {})})
        return self.problem(404, 'not-found')

    def rule(self, case_id):
        # Test mode only: stands for the arbiter's desk. Body {mode, decision, status?, forceBinding?}.
        b = self.body()
        c = cases.get(case_id)
        if not c or c['status'] != 'open':
            return self.problem(409, 'not-open')
        if b['mode'] == 'binding' and not c['bindingAllowed'] and not b.get('forceBinding'):
            return self.problem(409, 'no-binding-mandate')
        r = {'type': 'aevri.vledger.ruling', 'caseId': case_id, 'receiptDigest': c['receiptDigest'], 'mode': b['mode'], 'binding': b['mode'] == 'binding',
             'decision': b['decision'], 'issuedAt': iso(now()), 'arbiter': {'url': f'http://127.0.0.1:{PORT}/v1/arbiter', 'key': arb_pub()}}
        if b['mode'] == 'binding':
            r['status'] = b.get('status', 'matched')
        r['sig'] = b64u(ARB_KEY.sign(canon(r).encode()))
        with LOCK:
            c['ruling'], c['status'] = r, 'decided'
        return self.send(200, r)

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
    threading.Thread(target=relay_worker, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
