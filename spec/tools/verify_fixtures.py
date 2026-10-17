"""Independent checker of the aevri.vledger 1.0-d2 fixtures (SPEC section 15).

Written from SPEC.md without the reference JavaScript, so that two implementations agree.
Needs: jsonschema, cryptography.   python tools/verify_fixtures.py
"""
import base64
import hashlib
import json
import math
import pathlib
import re
import sys
from urllib.parse import parse_qs

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIX = ROOT / 'fixtures'
SCHEMA_BASE = 'https://aeilus.institute/schema/vledger/1/'
fails = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        fails.append(msg)


# ---- encoding ----

def ub64(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def num(x):
    """ECMAScript Number.prototype.toString for finite numbers (RFC 8785)."""
    if isinstance(x, bool):
        raise TypeError
    if isinstance(x, int):
        return str(x)
    if not math.isfinite(x):
        raise ValueError('non-finite')
    if x == 0:
        return '0'
    if x.is_integer() and abs(x) < 1e21:
        return str(int(x))
    r = repr(x)
    if 'e' in r:
        mant, exp = r.split('e')
        e = int(exp)
        if -7 < e < 21:
            return format(x, 'f').rstrip('0').rstrip('.') if e >= 0 else ('%.20f' % x).rstrip('0')
        return mant + 'e' + ('+' if e > 0 else '-') + str(abs(e))
    return r


def canon(v):
    if v is None:
        return 'null'
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if isinstance(v, (int, float)):
        return num(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return '[' + ','.join(canon(x) for x in v) + ']'
    keys = sorted(v.keys(), key=lambda k: k.encode('utf-16-be'))
    return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canon(v[k]) for k in keys) + '}'


def hjson(v):
    return 'sha256:' + hashlib.sha256(canon(v).encode('utf-8')).hexdigest()


def hbytes(b):
    return 'sha256:' + hashlib.sha256(b).hexdigest()


def aad(purpose, wallet_id, ident):
    return f'aevri.vledger/1|{purpose}|{wallet_id}|{ident}'.encode()


def gcm_open(key, wrap, purpose, wallet_id, ident):
    return AESGCM(key).decrypt(ub64(wrap['iv']), ub64(wrap['ct']), aad(purpose, wallet_id, ident))


def ed_verify(pub, data, sig):
    try:
        Ed25519PublicKey.from_public_bytes(ub64(pub['x'])).verify(ub64(sig), data)
        return True
    except InvalidSignature:
        return False


def key_of_address(addr):
    return {'alg': 'Ed25519', 'x': addr[4:]}


def signed_ok(obj, pub):
    rest = {k: v for k, v in obj.items() if k != 'sig'}
    return ed_verify(pub, canon(rest).encode('utf-8'), obj['sig'])


def jwk_int(s):
    return int.from_bytes(ub64(s), 'big')


def ec_pub(jwk):
    return ec.EllipticCurvePublicNumbers(jwk_int(jwk['x']), jwk_int(jwk['y']), ec.SECP256R1()).public_key()


def hkdf(shared, info):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=bytes(32), info=info.encode()).derive(shared)


# ---- schemas ----

REG = Registry()
for f in (ROOT / 'schema').glob('*.json'):
    s = json.loads(f.read_text(encoding='utf-8'))
    REG = REG.with_resource(s['$id'], Resource.from_contents(s))


def schema_errors(doc, ref):
    target = SCHEMA_BASE + ref
    schema = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$ref': target}
    return [e.message for e in Draft202012Validator(schema, registry=REG).iter_errors(doc)]


# ---- wallet ----

def chain_problems(doc):
    problems = []
    prev = hjson({'walletId': doc['walletId'], 'createdAt': doc['createdAt']})
    for i, r in enumerate(doc['records']):
        if r['seq'] != i + 1:
            problems.append('seq')
        if r['prevHash'] != prev:
            problems.append('prevHash')
        if 'erased' not in r and hbytes(ub64(r['ct'])) != r['ctHash']:
            problems.append('ctHash')
        prev = hjson({'id': r['id'], 'seq': r['seq'], 'prevHash': r['prevHash'], 'ctHash': r['ctHash']})
    return problems


def dek_from_passphrase(doc, passphrase):
    for slot in doc['keyring']['slots']:
        if slot['kind'] != 'passphrase':
            continue
        k = slot['kdf']
        kek = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=ub64(k['salt']), iterations=k['iterations']).derive(passphrase.encode())
        try:
            return gcm_open(kek, slot['wrap'], 'slot', doc['walletId'], slot['id'])
        except InvalidTag:
            pass
    return None


def exchange_private(doc, dek):
    jwk = json.loads(gcm_open(dek, doc['keyring']['exchange']['wrap'], 'exchange', doc['walletId'], 'exchange'))
    return ec.derive_private_key(jwk_int(jwk['d']), ec.SECP256R1())


def read_record(doc, dek, env):
    rk = gcm_open(dek, env['rk'], 'record', doc['walletId'], env['id'])
    return json.loads(gcm_open(rk, {'iv': env['iv'], 'ct': env['ct']}, 'payload', doc['walletId'], env['id']))


def open_message(priv, msg):
    shared = priv.exchange(ec.ECDH(), ec_pub(msg['epk']))
    info = f"aevri.vledger/1|message|{msg['id']}|{msg['to']}"
    body = json.loads(AESGCM(hkdf(shared, info)).decrypt(ub64(msg['iv']), ub64(msg['ct']), info.encode()))
    verified = bool(msg.get('from') and msg.get('sig')) and signed_ok(msg, key_of_address(msg['from']))
    return body, verified


# ---- value model (SPEC 7) ----

OTHER = '__other'


def weights(goals, systems):
    active = [s for s in systems if s['status'] == 'active']
    known = {s['id'] for s in systems}
    need_other = any(g['status'] == 'active' and g.get('systemId') not in known for g in goals)
    mean_w = sum(s['W'] for s in active) / len(active) if active else 1
    allsys = active + ([{'id': OTHER, 'W': mean_w}] if need_other else [])
    tot = sum(s['W'] for s in allsys)
    om = {s['id']: s['W'] / tot for s in allsys} if tot else {}
    sys_of = lambda g: g['systemId'] if g.get('systemId') in om else (None if g.get('systemId') in known else OTHER)
    act = [g for g in goals if g['status'] == 'active']
    sums = {}
    for g in act:
        sums[sys_of(g)] = sums.get(sys_of(g), 0) + g['S']
    return {g['id']: 0 if sys_of(g) is None else om.get(sys_of(g), 0) * (g['S'] / sums[sys_of(g)]) for g in act}


def value(goals, systems, contributions):
    w = weights(goals, systems)
    by = {g['id']: g for g in goals}
    v = 0.0
    for c in contributions:
        g = by.get(c['goalId'])
        if g is None or g['id'] not in w:
            continue
        k = c['k'] if 'k' in c else c['c'] / g.get('N', g['S'])
        v += w[g['id']] * k
    return v


def assess(goals, systems, contributions, spent):
    v, s = value(goals, systems, contributions), value(goals, systems, spent)
    return {'v': v, 'spentV': s, 'efficiency': v / s if s > 0 else None, 'net': v - s}


def nearest(refs, v):
    ok = [r for r in refs if isinstance(r.get('v'), (int, float)) and r['v'] != 0]
    if not ok or not v:
        return None
    best = min(ok, key=lambda r: abs(math.log(abs(r['v'])) - math.log(abs(v))))
    return {**best, 'ratio': v / best['v']}


def retro_allowed(assessments, event_id, obj=None):
    return any(a['eventId'] == event_id and a.get('objectIndex') == obj and a['phase'] == 'realized' for a in assessments)


def plan_factor(settings, q):
    rules = settings.get('planCountBy', [])
    cid, sid = q.get('contactId'), q.get('systemId')
    for pred in (lambda r: cid and sid and r.get('contactId') == cid and r.get('systemId') == sid,
                 lambda r: cid and r.get('contactId') == cid and 'systemId' not in r,
                 lambda r: sid and r.get('systemId') == sid and 'contactId' not in r):
        for r in rules:
            if pred(r):
                return r['factor']
    return settings.get('planCountDefault', 0)


def request_blocked(settings, body, sender, contacts, systems):
    r = settings.get('requests', {})
    if r.get('blockAll'):
        return True
    for cid in r.get('blockContacts', []):
        c = next((x for x in contacts if x['rootId'] == cid), None)
        if c and sender and c['body'].get('address') == sender:
            return True
    for sid in r.get('blockSystems', []):
        s = next((x for x in systems if x['rootId'] == sid), None)
        if not s:
            continue
        if body.get('systemRegistryUrl') and s['body'].get('registryUrl') == body['systemRegistryUrl']:
            return True
        if body.get('system') and s['body']['title'].lower() == str(body['system']).lower():
            return True
    return False


def parse_address(text):
    m = re.search(r'vw1:[A-Za-z0-9_-]{43}', text or '')
    if not m:
        return None
    out = {'address': m.group(0)}
    rest = text[m.end():]
    if rest.startswith('?'):
        q = parse_qs(rest[1:])
        if 'n' in q:
            out['name'] = q['n'][0]
        if 'k' in q:
            out['kind'] = q['k'][0]
    return out


def analytics(events, assessments, self_id):
    latest = {}
    for a in sorted(assessments, key=lambda x: x['createdAt']):
        cur = latest.get(a['eventId'])
        if cur is None or a['phase'] == 'retro' or cur['phase'] != 'retro':
            latest[a['eventId']] = a
    out = {'bySystem': {}, 'byContact': {}, 'byAction': {}, 'byRole': {}, 'total': {}}

    def add(group, key, e):
        g = group.setdefault(key, {'events': 0, 'assessed': 0, 'v': 0, 'spentV': 0, 'efficiency': None})
        g['events'] += 1
        a = latest.get(e['id'])
        if a:
            g['assessed'] += 1
            g['v'] += a.get('v') or 0
            g['spentV'] += a.get('spentV') or 0
        g['efficiency'] = g['v'] / g['spentV'] if g['spentV'] > 0 else None
    for e in events:
        if e['status'] != 'confirmed':
            continue
        other = ((e.get('affected') or [None])[0] or self_id) if e['actor'] == self_id else e['actor']
        add(out['bySystem'], e.get('systemId') or 'none', e)
        add(out['byContact'], other, e)
        add(out['byAction'], (e.get('actionType') or e.get('action') or '').strip().lower(), e)
        add(out['byRole'], e['role'], e)
        add(out['total'], 'all', e)
    return out


def same_numbers(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same_numbers(a[k], b[k]) for k in a)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return abs(a - b) < 1e-12
    return a == b


# ---- run ----

def load(name):
    return json.loads((FIX / name).read_text(encoding='utf-8'))


def receipt_state(bundle):
    d = bytes.fromhex(hjson(bundle['receipt'])[7:])
    valid = [s['party'] for s in bundle['signatures'] if ed_verify(bundle['receipt']['parties'][s['party']]['key'], d, s['sig'])]
    return all(i in valid for i in range(len(bundle['receipt']['parties']))), valid


def main():
    manifest = load('manifest.json')
    wallets = {}
    for w in ('a', 'b'):
        doc, plain = load(f'wallet-{w}.vledger.json'), load(f'wallet-{w}.plain.json')
        dek = dek_from_passphrase(doc, plain['passphrase'])
        wallets['wallet-' + w] = {'doc': doc, 'plain': plain, 'dek': dek, 'xpriv': exchange_private(doc, dek) if dek else None}
    arbiter_key = load('arbiter-stamp.json')['arbiter']['key']

    for fx in manifest['fixtures']:
        name, ref, exp = fx['file'], fx['schema'], fx['expect']
        print(name)
        doc = load(name)
        if ref:
            errs = schema_errors(doc, ref)
            check((not errs) == exp.get('schemaValid', True), f'schema {ref}: ' + ('valid' if not errs else '; '.join(errs[:2])[:200]))
        if name.endswith('.vledger.json'):
            check(len(chain_problems(doc)) == exp['chainProblems'], f'chain problems {len(chain_problems(doc))} (expected {exp["chainProblems"]})')
            if 'opensWith' in exp:
                w = wallets[name.split('.')[0]]
                plain = w['plain']
                raw = (FIX / name).read_text(encoding='utf-8')
                leaks = [x for x in ('Daughter', 'Toothpaste', 'hugged', 'river', 'Family', 'moves out') if x in raw]
                check(not leaks, 'no plain text in the wallet file' + (f' {leaks}' if leaks else ''))
                check(w['dek'] is not None and dek_from_passphrase(doc, plain['passphrase'] + 'x') is None, 'passphrase opens, a wrong one does not')
                check('vw1:' + doc['keyring']['identity']['publicKey']['x'] == plain['address'], 'address = vw1: + identity key')
                if 'records' in plain:
                    by = {r['id']: r for r in doc['records']}
                    ok = True
                    for p in plain['records']:
                        env = by[p['id']]
                        if p['payload'] is None:
                            ok &= 'erased' in env and 'ct' not in env
                            continue
                        payload = read_record(doc, w['dek'], env)
                        ok &= canon(payload) == canon(p['payload']) and not schema_errors(payload, 'payload.schema.json')
                    check(ok, f'{len(plain["records"])} records decrypt, match and validate; erased ones are tombstones')
                    pays = [p['payload'] for p in plain['records'] if p['payload']]
                    asses = [dict(p['body'], createdAt=p['createdAt']) for p in pays if p['kind'] == 'assessment']
                    retro_ok = all(retro_allowed([b for b in asses if b['createdAt'] < a['createdAt']], a['eventId'], a.get('objectIndex'))
                                   for a in asses if a['phase'] == 'retro')
                    check(retro_ok, 'every retro assessment follows a realized one')
                    for val in plain['values']:
                        r = assess(plain['goals'], plain['systems'], val['contributions'], val['spent'])
                        check(abs(r['v'] - val['v']) < 1e-12 and abs(r['spentV'] - val['spentV']) < 1e-12 and (val.get('efficiency') is None or abs(r['efficiency'] - val['efficiency']) < 1e-9),
                              f'{val["event"]}: v {r["v"]:.4f}, spent {r["spentV"]:.4f}' + (f', efficiency {r["efficiency"]:.2f}' if r['efficiency'] else ''))
                    events = [dict(id=p['id'], **p['payload']['body']) for p in plain['records'] if p['payload'] and p['payload']['kind'] == 'event']
                    check(same_numbers(analytics(events, asses, plain['selfId']), plain['analytics']), 'analytics recomputed the same (suggested event excluded, unassessed counted)')
                    check(analytics(events, asses, plain['selfId'])['total']['all']['events'] == 4, 'four confirmed events on the timeline, the suggested one is not')
        if name.startswith('card') or name == 'invalid-card-tampered.json':
            check(ed_verify(key_of_address(doc['card']['address']), canon(doc['card']).encode(), doc['sig']) == exp['signatureValid'], f'card signature valid = {exp["signatureValid"]}')
        if name.startswith('registry'):
            owner = doc['registry']['owner']
            check(ed_verify(key_of_address(owner['card']['address']), canon(doc['registry']).encode(), doc['sig']), 'registry signed by its owner card key')
        if name.startswith('message') or name.startswith('invalid-message'):
            rcpt = exp['recipient']
            if rcpt in wallets:
                w = wallets[rcpt]
                check(doc['to'] == w['plain']['address'], 'addressed to the recipient wallet')
                body, verified = open_message(w['xpriv'], doc)
                check(canon(body) == canon(exp['body']), 'recipient decrypts the expected body')
                check(verified == exp['verified'], f'sender signature verified = {exp["verified"]}')
                check(not schema_errors(body, 'message.schema.json#/$defs/body'), 'inner body valid')
                other = wallets['wallet-a' if rcpt == 'wallet-b' else 'wallet-b']
                try:
                    open_message(other['xpriv'], doc)
                    third = True
                except Exception:
                    third = False
                check(not third, 'another wallet cannot decrypt it')
                if 'blocked' in exp:
                    pa = wallets['wallet-a']['plain']
                    pays = [dict(rootId=p['id'], **p['payload']) for p in pa['records'] if p['payload']]
                    settings = next(p['body'] for p in pays if p['kind'] == 'settings')
                    contacts = [p for p in pays if p['kind'] == 'contact']
                    systems = [p for p in pays if p['kind'] == 'value-system']
                    check(request_blocked(settings, body, doc.get('from'), contacts, systems) == exp['blocked'], f'request blocked = {exp["blocked"]} by wallet A settings')
            else:
                check('from' not in doc and 'sig' not in doc, 'anonymous message carries no sender')
        if name.startswith('receipt') or name.startswith('invalid-receipt'):
            matched, valid = receipt_state(doc)
            check(matched == exp['matched'], f'matched = {matched}')
            if 'validSignatures' in exp:
                check(valid == exp['validSignatures'], f'valid signatures {valid}')
            if 'receiptDigest' in exp:
                check(hjson(doc['receipt']) == exp['receiptDigest'], 'receipt digest equals the reference')
            if 'binding' in exp:
                check((matched and doc['receipt']['mandate']['mode'] == 'binding') == exp['binding'], f'binding = {exp["binding"]}')
            if 'actionOpening' in exp:
                o = exp['actionOpening']
                check(hjson({'salt': o['salt'], 'text': o['text']}) == doc['receipt']['action']['digest'], 'action digest opens with salt and text')
        if name == 'arbiter-stamp-request.json':
            d = bytes.fromhex(doc['receiptDigest'][7:])
            check(all(ed_verify(doc['keys'][s['party']], d, s['sig']) for s in doc['signatures']), 'all signatures in the request verify')
        if exp.get('signedBy') == 'arbiter':
            check(signed_ok(doc, arbiter_key) == exp['valid'], 'arbiter signature verifies')
            if exp.get('mandateMatches'):
                r = load(exp['mandateMatches'])['receipt']
                check(r['mandate']['mode'] == 'binding' and r['mandate']['arbiter']['key'] == doc['arbiter']['key'] and hjson(r) == doc['receiptDigest'],
                      'binding ruling comes from the arbiter named in the binding mandate')
        if name == 'value-cases.json':
            for c in doc['cases']:
                r = assess(c['goals'], c['systems'], c['contributions'], c['spent'])
                e = c['expect']
                check(abs(r['v'] - e['v']) < 1e-12 and abs(r['spentV'] - e['spentV']) < 1e-12 and ((r['efficiency'] is None) == (e['efficiency'] is None)) and (r['efficiency'] is None or abs(r['efficiency'] - e['efficiency']) < 1e-9),
                      f'{c["name"]}: v {r["v"]:.4f}, spent {r["spentV"]:.4f}, e {r["efficiency"]}')
            at4 = doc['cases'][0]['expect']
            check(abs(at4['v'] - 0.225) < 1e-12 and abs(at4['spentV'] - 0.05) < 1e-12 and abs(at4['efficiency'] - 4.5) < 1e-9, 'TZ v0.3 AT-4 numbers: v 22.5%, spent 5%, efficiency 4.5')
            for q in doc['references']['queries']:
                got = nearest(doc['references']['refs'], q['v'])
                check(got['phrase'] == q['expect']['phrase'] and abs(got['ratio'] - q['expect']['ratio']) < 1e-9, f'nearest reference for {q["v"]}: {got["phrase"]} x{got["ratio"]:.2f}')
            for q in doc['retro']:
                check(retro_allowed(q['assessments'], q['eventId']) == q['expect'], f'retro allowed = {q["expect"]}')
            for q in doc['planFactor']:
                check(plan_factor(q['settings'], q['query']) == q['expect'], f'plan factor {q["expect"]}')
            for q in doc['requestBlocking']:
                got = request_blocked(q['settings'], q['body'], q['from'], q.get('contacts', []), q.get('systems', []))
                check(got == q['expect'] == q['got'], f'request blocking {q["expect"]} (reference said {q["got"]})')
            for q in doc['addresses']:
                check(parse_address(q['text']) == q['expect'], f'address parse {str(q["text"])[:40]}')
    print('JCS numbers')
    for x, s in [(1e21, '1e+21'), (1e-7, '1e-7'), (0.000001, '0.000001'), (123.456, '123.456'), (-0.0, '0'), (5e-324, '5e-324')]:
        check(num(x) == s, f'{x!r} -> {num(x)}')
    print()
    print('RESULT:', 'all checks passed' if not fails else f'{len(fails)} failed')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
