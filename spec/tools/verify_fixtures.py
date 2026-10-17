"""Independent checker of the aevri.vledger 1.0 fixtures (SPEC section 12).

Written from SPEC.md without the reference JavaScript, so that two implementations agree.
Needs: jsonschema, cryptography.   python tools/verify_fixtures.py
"""
import base64
import hashlib
import json
import math
import pathlib
import sys
from datetime import datetime, timezone

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
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
    """ECMAScript Number.prototype.toString for finite numbers (what RFC 8785 requires)."""
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
    if 'e' in r or 'E' in r:
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
    assert pub['alg'] == 'Ed25519'
    try:
        Ed25519PublicKey.from_public_bytes(ub64(pub['x'])).verify(ub64(sig), data)
        return True
    except InvalidSignature:
        return False


def signed_ok(obj, pub):
    rest = {k: v for k, v in obj.items() if k != 'sig'}
    return ed_verify(pub, canon(rest).encode('utf-8'), obj['sig'])


# ---- schemas ----

def registry():
    reg = Registry()
    for f in (ROOT / 'schema').glob('*.json'):
        s = json.loads(f.read_text(encoding='utf-8'))
        reg = reg.with_resource(s['$id'], Resource.from_contents(s))
    return reg


REG = registry()


def schema_errors(doc, ref):
    if '#' in ref:
        name, frag = ref.split('#', 1)
        schema = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$ref': SCHEMA_BASE + name + '#' + frag}
    else:
        schema = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$ref': SCHEMA_BASE + ref}
    return [e.message for e in Draft202012Validator(schema, registry=REG).iter_errors(doc)]


# ---- wallet ----

def chain_problems(doc):
    problems = []
    prev = hjson({'walletId': doc['walletId'], 'createdAt': doc['createdAt']})
    for i, r in enumerate(doc['records']):
        if r['seq'] != i + 1:
            problems.append(f"{r['id']}: seq")
        if r['prevHash'] != prev:
            problems.append(f"{r['id']}: prevHash")
        if 'erased' not in r and hbytes(ub64(r['ct'])) != r['ctHash']:
            problems.append(f"{r['id']}: ctHash")
        prev = hjson({'id': r['id'], 'seq': r['seq'], 'prevHash': r['prevHash'], 'ctHash': r['ctHash']})
    return problems


def dek_from_passphrase(doc, passphrase):
    for slot in doc['keyring']['slots']:
        if slot['kind'] != 'passphrase':
            continue
        k = slot['kdf']
        kek = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=ub64(k['salt']), iterations=k['iterations']).derive(passphrase.encode('utf-8'))
        try:
            return gcm_open(kek, slot['wrap'], 'slot', doc['walletId'], slot['id'])
        except InvalidTag:
            pass
    return None


def jwk_int(s):
    return int.from_bytes(ub64(s), 'big')


def dek_from_provider(doc, slot_id, priv_jwk):
    slot = next(s for s in doc['keyring']['slots'] if s['id'] == slot_id)
    priv = ec.derive_private_key(jwk_int(priv_jwk['d']), ec.SECP256R1())
    epk = ec.EllipticCurvePublicNumbers(jwk_int(slot['epk']['x']), jwk_int(slot['epk']['y']), ec.SECP256R1()).public_key()
    shared = priv.exchange(ec.ECDH(), epk)
    wk = HKDF(algorithm=hashes.SHA256(), length=32, salt=bytes(32), info=f"aevri.vledger/1|recovery|{doc['walletId']}|{slot['keyId']}".encode()).derive(shared)
    return gcm_open(wk, slot['wrap'], 'slot', doc['walletId'], slot['id'])


def read_record(doc, dek, env):
    rk = gcm_open(dek, env['rk'], 'record', doc['walletId'], env['id'])
    return json.loads(gcm_open(rk, {'iv': env['iv'], 'ct': env['ct']}, 'payload', doc['walletId'], env['id']))


# ---- value model (SPEC 7) ----

def comparable_value(goals, contributions):
    active = [g for g in goals if g['status'] == 'active']
    total = sum(g['S'] for g in active)
    w = {g['id']: g['S'] / total for g in active}
    by = {g['id']: g for g in goals}
    v = 0.0
    for c in contributions:
        g = by.get(c['goalId'])
        if not g or g['id'] not in w:
            continue
        k = c['k'] if 'k' in c else c['c'] / g.get('N', g['S'])
        v += w[g['id']] * k
    return v


def plan_factor(settings, q):
    rules = settings.get('planCountBy', [])
    cp, tp = q.get('counterpartyId'), q.get('typeId')
    for pred in (lambda r: cp and tp and r.get('counterpartyId') == cp and r.get('typeId') == tp,
                 lambda r: r.get('counterpartyId') == cp and 'typeId' not in r and cp,
                 lambda r: r.get('typeId') == tp and 'counterpartyId' not in r and tp):
        for r in rules:
            if pred(r):
                return r['factor']
    return settings.get('planCountDefault', 0)


def spearman(a, b):
    def ranks(xs):
        order = sorted(range(len(xs)), key=lambda i: xs[i])
        r = [0.0] * len(xs)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
                j += 1
            for t in range(i, j + 1):
                r[order[t]] = (i + j) / 2 + 1
            i = j + 1
        return r
    n = len(a)
    if n < 3:
        return None
    ra, rb = ranks(a), ranks(b)
    ma, mb = sum(ra) / n, sum(rb) / n
    num_ = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    da = sum((x - ma) ** 2 for x in ra)
    db = sum((y - mb) ** 2 for y in rb)
    return num_ / math.sqrt(da * db) if da and db else None


def feeling_checks(goals, assessments, now):
    out = []
    by = {g['id']: g for g in goals}
    share = {}
    for a in assessments:
        for c in a.get('contributions', []):
            g = by.get(c['goalId'])
            if g:
                share[g['id']] = share.get(g['id'], 0) + (c['k'] if 'k' in c else c['c'] / g.get('N', g['S']))
    for g in goals:
        if g['status'] == 'active' and share.get(g['id'], 0) > 1:
            out.append('goal-overfilled')
    scored = [a for a in assessments if 'ownScore' in a and isinstance(a.get('v'), (int, float))][-20:]
    rho = spearman([a['ownScore']['value'] for a in scored], [a['v'] for a in scored])
    if rho is not None and len(scored) >= 5 and rho < 0.3:
        out.append('scale-disagrees')
    active = [g for g in goals if g['status'] == 'active']
    if len(active) > 1:
        top = max(active, key=lambda g: g['S'])
        since = now.timestamp() - 90 * 86400
        recent = [a for a in assessments if datetime.fromisoformat(a['at'].replace('Z', '+00:00')).timestamp() >= since]
        touches = lambda gid: sum(1 for a in recent if any(c['goalId'] == gid for c in a.get('contributions', [])))
        others = sum(touches(g['id']) for g in active if g['id'] != top['id'])
        if touches(top['id']) == 0 and others >= 3:
            out.append('top-goal-untouched')
    return out


# ---- run ----

def load(name):
    return json.loads((FIX / name).read_text(encoding='utf-8'))


def receipt_state(bundle):
    d = bytes.fromhex(hjson(bundle['receipt'])[7:])
    valid = [s['party'] for s in bundle['signatures'] if ed_verify(bundle['receipt']['parties'][s['party']]['key'], d, s['sig'])]
    matched = all(i in valid for i in range(len(bundle['receipt']['parties'])))
    return matched, valid


def main():
    manifest = load('manifest.json')
    plain = load('wallet-a.plain.json')
    arbiter_key = load('arbiter-stamp.json')['arbiter']['key']
    for fx in manifest['fixtures']:
        name, ref, exp = fx['file'], fx['schema'], fx['expect']
        print(name)
        doc = load(name)
        if ref:
            errs = schema_errors(doc, ref)
            check((not errs) == exp.get('schemaValid', True), f'schema {ref}: ' + ('valid' if not errs else '; '.join(errs[:2])))
        if name.endswith('.vledger.json'):
            probs = chain_problems(doc)
            check(len(probs) == exp['chainProblems'], f'chain problems {len(probs)} (expected {exp["chainProblems"]})')
            if 'opensWith' in exp:
                raw = (FIX / name).read_text(encoding='utf-8')
                leaks = [w for w in ('Ballpoint', 'father', 'Anna', 'Greek', 'municipality', 'points') if w in raw]
                check(not leaks, 'no plain text of records in the wallet file' + (f' (found {leaks})' if leaks else ''))
                dek = dek_from_passphrase(doc, plain['passphrase'])
                check(dek is not None, 'passphrase opens the wallet')
                check(dek_from_passphrase(doc, plain['passphrase'] + 'x') is None, 'wrong passphrase does not')
                dek2 = dek_from_provider(doc, plain['providerRecovery']['slotId'], plain['providerRecovery']['privateJwk'])
                check(dek2 == dek, 'provider recovery key yields the same DEK')
                pk = gcm_open(dek, doc['keyring']['identity']['wrap'], 'identity', doc['walletId'], 'identity')
                check(len(pk) > 32, 'identity private key opens')
                by = {r['id']: r for r in doc['records']}
                same = True
                for p in plain['records']:
                    env = by[p['id']]
                    if p['payload'] is None:
                        same &= 'erased' in env and 'ct' not in env
                        continue
                    payload = read_record(doc, dek, env)
                    same &= canon(payload) == canon(p['payload'])
                    same &= not schema_errors(payload, 'payload.schema.json')
                check(same, f'{len(plain["records"])} records decrypt, match the plain copy and validate; erased ones are tombstones')
                for val in plain['values']:
                    check(abs(comparable_value(plain['goals'], val['contributions']) - val['v']) < 1e-12, f'v recomputed for exchange ...{val["assessmentOf"][-6:]}: {val["v"]:.6f}')
        if name.startswith('receipt') or name.startswith('invalid-receipt'):
            matched, valid = receipt_state(doc)
            check(matched == exp['matched'], f'matched = {matched}')
            if 'validSignatures' in exp:
                check(valid == exp['validSignatures'], f'valid signatures {valid}')
            if 'receiptDigest' in exp:
                check(hjson(doc['receipt']) == exp['receiptDigest'], 'receipt digest equals the reference')
            if 'binding' in exp:
                check((matched and doc['receipt']['mandate']['mode'] == 'binding') == exp['binding'], f'binding = {exp["binding"]}')
            if 'elementOpening' in exp:
                o = exp['elementOpening']
                d = hjson({'salt': o['salt'], 'label': o['label'], 'quantity': o['quantity'], 'unit': o['unit'], 'note': o['note']})
                check(d == doc['receipt']['elements'][0]['digest'], 'element digest opens with the salt and label')
        if name == 'arbiter-stamp-request.json':
            d = bytes.fromhex(doc['receiptDigest'][7:])
            check(all(ed_verify(doc['keys'][s['party']], d, s['sig']) for s in doc['signatures']), 'all signatures in the request verify')
        if exp.get('signedBy') == 'arbiter':
            check(signed_ok(doc, arbiter_key) == exp['valid'], 'arbiter signature verifies')
            if exp.get('mandateMatches'):
                r = load(exp['mandateMatches'])['receipt']
                check(r['mandate']['mode'] == 'binding' and r['mandate']['arbiter']['key'] == doc['arbiter']['key'] and hjson(r) == doc['receiptDigest'],
                      'binding ruling comes from the arbiter named in the binding mandate of that receipt')
        if exp.get('signedBy') == 'profile.key':
            check(ed_verify(doc['profile']['key'], canon(doc['profile']).encode('utf-8'), doc['sig']), 'profile signature verifies')
        if exp.get('signedBy') == 'from':
            check(signed_ok(doc, doc['from']), 'named feedback signature verifies')
        if name == 'value-cases.json':
            for c in doc['cases']:
                check(abs(comparable_value(c['goals'], c['contributions']) - c['expect']['v']) < 1e-12, f'case "{c["name"]}": v = {c["expect"]["v"]:.6f}')
            fc = doc['feelingChecks']
            got = feeling_checks(fc['goals'], fc['assessments'], datetime.fromisoformat(fc['now'].replace('Z', '+00:00')))
            check(got == fc['expect'], f'feeling checks {got}')
            for p in doc['planFactor']:
                check(plan_factor(p['settings'], p['query']) == p['expect'], f'plan factor {p["expect"]}')
    # JCS self-test on tricky numbers (RFC 8785 appendix examples)
    print('JCS numbers')
    for x, s in [(1e21, '1e+21'), (1e-7, '1e-7'), (0.000001, '0.000001'), (123.456, '123.456'), (-0.0, '0'), (5e-324, '5e-324')]:
        check(num(x) == s, f'{x!r} -> {num(x)}')
    print()
    print('RESULT:', 'all checks passed' if not fails else f'{len(fails)} failed')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
