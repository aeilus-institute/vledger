"""Writes the d2 schemas (payload, receipt, message, card, registry) into the given schema folder."""
import json
import pathlib
import sys

OUT = pathlib.Path(sys.argv[1])
B = 'https://aeilus.institute/schema/vledger/1/'
S = 'https://json-schema.org/draft/2020-12/schema'
c = lambda name: {'$ref': 'common.schema.json#/$defs/' + name}
ID = c('uuid')
LINE, TEXT = c('line'), c('text')
CATS = ['thing', 'service', 'information', 'time', 'money', 'right', 'decision', 'relation', 'action', 'other']
contrib = {'type': 'object', 'required': ['goalId'], 'properties': {'goalId': ID, 'c': {'type': 'number'}, 'k': {'type': 'number'}},
           'anyOf': [{'required': ['c']}, {'required': ['k']}]}
obj = {'type': 'object', 'required': ['label'], 'properties': {
    'label': LINE, 'typeId': ID, 'quantity': {'type': 'number'}, 'unit': {'type': 'string', 'maxLength': 40}, 'note': TEXT}}

defs = {
    'contact': {'type': 'object', 'required': ['type', 'name'], 'properties': {
        'type': {'enum': ['self', 'person', 'organization', 'state', 'group', 'device', 'unknown']},
        'name': LINE, 'address': c('address'), 'card': {'$ref': 'card.schema.json'}, 'note': TEXT,
        'members': {'type': 'array', 'items': ID}}},
    'valueSystem': {'type': 'object', 'required': ['title', 'W', 'status'], 'properties': {
        'title': LINE, 'W': {'type': 'number', 'exclusiveMinimum': 0}, 'status': {'enum': ['active', 'dropped']},
        'registryUrl': {'type': 'string', 'pattern': '^https://'}, 'registrySystemId': {'type': 'string', 'maxLength': 60}, 'group': {'type': 'string', 'maxLength': 100}, 'note': TEXT}},
    'goal': {'type': 'object', 'required': ['title', 'S', 'status'], 'properties': {
        'title': LINE, 'systemId': ID, 'S': {'type': 'number', 'exclusiveMinimum': 0}, 'N': {'type': 'number', 'exclusiveMinimum': 0},
        'unit': {'type': 'string', 'maxLength': 40}, 'status': {'enum': ['active', 'reached', 'dropped']},
        'why': TEXT, 'signs': TEXT, 'horizon': {'type': 'string', 'maxLength': 100}, 'factIds': {'type': 'array', 'items': ID}}},
    'event': {'type': 'object', 'required': ['actor', 'action', 'objects', 'affected', 'role', 'occurredAt', 'status'], 'properties': {
        'actor': ID, 'action': LINE, 'actionType': {'type': 'string', 'maxLength': 60},
        'objects': {'type': 'array', 'items': obj}, 'affected': {'type': 'array', 'items': ID},
        'role': {'enum': ['actor', 'affected', 'user', 'witness']},
        'occurredAt': {'oneOf': [c('time'), c('date')]}, 'approx': {'type': 'boolean'}, 'systemId': ID,
        'registryRef': c('registryRef'), 'status': {'enum': ['confirmed', 'suggested', 'rejected']}, 'suggestedBy': ID,
        'receipt': {'$ref': 'receipt.schema.json'},
        'receiptState': {'enum': ['offered', 'matched', 'disputed']},
        'receiptOpening': {'type': 'object'},
        'stamps': {'type': 'array', 'items': {'$ref': 'arbiter.schema.json#/$defs/stamp'}},
        'rulings': {'type': 'array', 'items': {'$ref': 'arbiter.schema.json#/$defs/ruling'}},
        'vssRef': {'type': 'object', 'required': ['vssSchemaId', 'flowId'], 'properties': {'vssSchemaId': {'type': 'string', 'maxLength': 100},
            'flowId': {'type': 'string', 'maxLength': 100}, 'flowLabel': LINE, 'elementTypeId': {'type': 'string', 'maxLength': 100},
            'item': {'type': 'object', 'properties': {'boardId': {'type': 'string'}, 'itemId': {'type': 'string'}, 'title': LINE}}}},
        'cases': {'type': 'array', 'items': {'type': 'object', 'required': ['caseId', 'arbiterUrl', 'request', 'openedAt', 'status'], 'properties': {
            'caseId': c('uuid'), 'arbiterUrl': {'type': 'string', 'format': 'uri'}, 'request': {'enum': ['attest', 'opinion', 'decision']},
            'openedAt': c('time'), 'status': {'enum': ['open', 'decided', 'declined']}, 'problem': {'type': 'string'}, 'reason': {'type': 'string', 'maxLength': 2000}}}}},
        'if': {'properties': {'status': {'const': 'suggested'}}}, 'then': {'required': ['suggestedBy']}},
    'elementType': {'type': 'object', 'required': ['name', 'category'], 'properties': {'name': LINE, 'category': {'enum': CATS}}},
    'plan': {'type': 'object', 'required': ['eventId', 'author', 'promise'], 'properties': {
        'eventId': ID, 'objectIndex': {'type': 'integer', 'minimum': 0}, 'author': ID, 'promise': TEXT,
        'plannedV': {'type': 'number', 'minimum': -1, 'maximum': 1}, 'plannedSpentV': {'type': 'number', 'minimum': 0, 'maximum': 1},
        'registryRef': c('registryRef')}},
    'assessment': {'type': 'object', 'required': ['eventId', 'phase', 'confidence', 'reference'], 'properties': {
        'eventId': ID, 'objectIndex': {'type': 'integer', 'minimum': 0}, 'phase': {'enum': ['realized', 'retro']},
        'gained': {'type': 'array', 'items': LINE}, 'lost': {'type': 'array', 'items': LINE},
        'ownScore': {'type': 'object', 'required': ['value'], 'properties': {'value': {'type': 'number'}, 'unit': {'type': 'string', 'maxLength': 40}}},
        'contributions': {'type': 'array', 'items': contrib}, 'spent': {'type': 'array', 'items': contrib},
        'v': {'type': 'number'}, 'spentV': {'type': 'number', 'minimum': 0}, 'planCount': {'type': 'number', 'minimum': 0, 'maximum': 1},
        'reference': {'type': 'boolean'}, 'confidence': {'enum': ['low', 'medium', 'high']}, 'reasons': TEXT,
        'checkAfter': c('date'), 'reaction': {'enum': [-100, -20, 0, 20, 100, 500]},
        'vet': {'type': 'object', 'required': ['snapshotHash'], 'properties': {'boardId': {'type': 'string'}, 'resultId': {'type': 'string'}, 'snapshotHash': c('sha256'),
            'revision': {'type': 'number'}, 'totals': {'type': 'object'}, 'axes': {'type': 'object'}, 'receivedAt': c('time'), 'boardSnapshot': {'type': 'object'}}}}},
    'fact': {'type': 'object', 'required': ['text', 'certainty'], 'properties': {
        'topic': {'type': 'string', 'maxLength': 100}, 'text': TEXT, 'certainty': {'enum': ['low', 'medium', 'high']},
        'exploring': {'type': 'boolean'}, 'goalIds': {'type': 'array', 'items': ID}}},
    'settings': {'type': 'object', 'properties': {
        'planCountDefault': {'type': 'number', 'minimum': 0, 'maximum': 1, 'default': 0},
        'planCountBy': {'type': 'array', 'items': {'type': 'object', 'required': ['factor'], 'properties': {'contactId': ID, 'systemId': ID, 'factor': {'type': 'number', 'minimum': 0, 'maximum': 1}}}},
        'requests': {'type': 'object', 'properties': {'blockAll': {'type': 'boolean'}, 'blockSystems': {'type': 'array', 'items': ID}, 'blockContacts': {'type': 'array', 'items': ID}}},
        'relays': {'type': 'array', 'items': {'type': 'string', 'pattern': '^https://'}},
        'bridges': {'type': 'object', 'properties': {'vss': {'type': 'object', 'properties': {'share': {'enum': ['fact', 'value'], 'default': 'fact'}}}}},
        'arbiters': {'type': 'array', 'items': c('arbiterRef')},
        'providers': {'type': 'array', 'items': {'type': 'object', 'required': ['kind'], 'properties': {
            'kind': {'enum': ['device', 'file', 'aevri', 'github', 'webdav', 's3', 'custom']}, 'id': {'type': 'string', 'maxLength': 60},
            'label': {'type': 'string'}, 'url': {'type': 'string'},
            'config': {'type': 'object', 'properties': {'owner': {'type': 'string'}, 'repo': {'type': 'string'}, 'branch': {'type': 'string'},
                                                        'token': {'type': 'string'}, 'apiBase': {'type': 'string'}}},
            'recovery': {'type': 'object', 'properties': {'slotId': {'type': 'string'}, 'keyId': {'type': 'string'}}},
            'lastSync': c('time'), 'ageConfirmed': {'type': 'boolean'}}}},
        'storage': c('storagePolicy')}},
    'messageIn': {'type': 'object', 'required': ['envelopeDigest', 'verified', 'receivedAt', 'body', 'state'], 'properties': {
        'envelopeDigest': c('sha256'), 'from': c('address'), 'verified': {'type': 'boolean'}, 'receivedAt': c('time'),
        'body': {'$ref': 'message.schema.json#/$defs/body'}, 'state': {'enum': ['new', 'accepted', 'ignored']}}},
    'messageOut': {'type': 'object', 'required': ['to', 'kind', 'sentAt', 'envelopeDigest'], 'properties': {
        'to': c('address'), 'kind': {'enum': ['share', 'request', 'event-offer', 'card', 'suggestion']}, 'sentAt': c('time'),
        'envelopeDigest': c('sha256'), 'about': ID}},
    'grant': {'type': 'object', 'required': ['recordIds', 'recipient', 'fields', 'purpose'], 'properties': {
        'recordIds': {'type': 'array', 'minItems': 1, 'items': ID}, 'recipient': {'oneOf': [ID, {'enum': ['public-anon', 'public-named']}]},
        'fields': {'type': 'array', 'items': {'type': 'string'}}, 'strip': {'type': 'array', 'items': {'enum': ['name', 'age', 'place', 'free-text', 'goals', 'own-scale']}},
        'until': c('date'), 'purpose': {'enum': ['share', 'bilateral', 'research-contribution', 'personal']}}},
    'revocation': {'type': 'object', 'required': ['grantId'], 'properties': {'grantId': ID, 'reason': LINE}},
    'disclosure': {'type': 'object', 'required': ['grantId', 'deliveredAt', 'recipient', 'contentHash'], 'properties': {
        'grantId': ID, 'deliveredAt': c('time'), 'recipient': {'type': 'string'}, 'contentHash': c('sha256')}},
    'import': {'type': 'object', 'required': ['origin', 'originId', 'payload', 'payloadHash'], 'properties': {
        'origin': {'enum': ['aevri.site', 'aevri.vvp', 'vet', 'vss', 'file', 'url', 'device', 'agent']}, 'originId': {'type': 'string'}, 'payload': {}, 'payloadHash': c('sha256')}},
    'note': {'type': 'object', 'required': ['text'], 'properties': {'text': TEXT}},
}
KIND_DEF = {'contact': 'contact', 'value-system': 'valueSystem', 'goal': 'goal', 'event': 'event', 'element-type': 'elementType',
            'plan': 'plan', 'assessment': 'assessment', 'fact': 'fact', 'settings': 'settings', 'message-in': 'messageIn',
            'message-out': 'messageOut', 'grant': 'grant', 'revocation': 'revocation', 'disclosure': 'disclosure', 'import': 'import', 'note': 'note'}
payload = {
    '$schema': S, '$id': B + 'payload.schema.json', 'title': 'aevri.vledger 1.0-d2 record payload (decrypted)',
    'type': 'object', 'required': ['kind', 'createdAt', 'source', 'body'],
    'properties': {
        'kind': {'enum': list(KIND_DEF)}, 'createdAt': c('time'),
        'supersedes': {'oneOf': [ID, {'type': 'null'}]},
        'source': {'enum': ['manual', 'import-file', 'contact', 'registry', 'message', 'device', 'agent', 'vet', 'vss', 'aevri.site', 'aevri.vvp']},
        'retainUntil': {'oneOf': [c('date'), {'type': 'null'}]}, 'body': {'type': 'object'}},
    'if': {'properties': {'body': {'required': ['withdrawn']}}},
    'then': {'required': ['supersedes'], 'properties': {'body': {'properties': {'withdrawn': {'const': True}}}}},
    'else': {'allOf': [{'if': {'properties': {'kind': {'const': k}}}, 'then': {'properties': {'body': {'$ref': '#/$defs/' + d}}}} for k, d in KIND_DEF.items()]},
    '$defs': defs,
}

party = {'type': 'object', 'required': ['role', 'key'], 'properties': {'role': {'enum': ['actor', 'affected', 'user', 'witness', 'party']}, 'key': c('publicKey'), 'label': LINE}}
receipt = {
    '$schema': S, '$id': B + 'receipt.schema.json', 'title': 'aevri.vledger 1.0-d2 signed event receipt',
    'type': 'object', 'required': ['receipt', 'signatures'],
    'properties': {'receipt': {'$ref': '#/$defs/receipt'},
                   'signatures': {'type': 'array', 'items': {'allOf': [c('signature')], 'required': ['party']}}},
    '$defs': {'receipt': {'type': 'object', 'required': ['type', 'version', 'receiptId', 'occurredAt', 'parties', 'action', 'objects', 'mandate'], 'properties': {
        'type': {'const': 'aevri.vledger.receipt'}, 'version': {'const': 2}, 'receiptId': ID, 'occurredAt': c('time'),
        'parties': {'type': 'array', 'minItems': 2, 'items': party},
        'action': {'type': 'object', 'required': ['digest'], 'properties': {'digest': c('sha256'), 'type': {'type': 'string', 'maxLength': 60}}},
        'objects': {'type': 'array', 'items': {'type': 'object', 'required': ['digest'], 'properties': {'digest': c('sha256'), 'type': {'type': 'string', 'maxLength': 40}}}},
        'plan': {'type': 'array', 'items': {'type': 'object', 'required': ['object', 'digest'], 'properties': {'object': {'type': 'integer', 'minimum': 0}, 'digest': c('sha256')}}},
        'arbiters': {'type': 'array', 'items': {'allOf': [c('arbiterRef')], 'required': ['party'], 'properties': {'party': {'type': 'integer', 'minimum': 0}}}},
        'mandate': {'type': 'object', 'required': ['mode'], 'properties': {
            'mode': {'enum': ['attest', 'opinion', 'binding']}, 'arbiter': c('arbiterRef'), 'scope': TEXT, 'rulesUrl': {'type': 'string', 'pattern': '^https://'}},
            'if': {'properties': {'mode': {'const': 'binding'}}}, 'then': {'required': ['arbiter']}}}}},
}

card = {
    '$schema': S, '$id': B + 'card.schema.json', 'title': 'aevri.vledger 1.0-d2 signed wallet card',
    'type': 'object', 'required': ['card', 'sig'],
    'properties': {'card': {'type': 'object', 'required': ['type', 'version', 'address', 'kind', 'encKey', 'storage', 'updatedAt'], 'properties': {
        'type': {'const': 'aevri.vledger.card'}, 'version': {'const': 1}, 'address': c('address'),
        'kind': {'enum': ['person', 'organization', 'state', 'group', 'device']}, 'name': LINE, 'encKey': c('ecJwk'),
        'inbox': {'type': 'string', 'pattern': '^https://'}, 'registryUrl': {'type': 'string', 'pattern': '^https://'},
        'storage': c('storagePolicy'), 'updatedAt': c('time')}},
        'sig': c('b64u')},
}

event_words = {'type': 'object', 'required': ['actor', 'action'], 'properties': {
    'actor': LINE, 'action': LINE, 'objects': {'type': 'array', 'items': LINE}, 'affected': {'type': 'array', 'items': LINE},
    'occurredAt': {'oneOf': [c('time'), c('date')]}, 'registryRef': c('registryRef')}}
body = {'oneOf': [
    {'type': 'object', 'required': ['kind', 'event', 'phase', 'publish'], 'properties': {
        'kind': {'const': 'share'}, 'event': event_words, 'phase': {'enum': ['realized', 'retro']},
        'gained': {'type': 'array', 'items': LINE}, 'lost': {'type': 'array', 'items': LINE},
        'v': {'type': 'number'}, 'spentV': {'type': 'number', 'minimum': 0},
        'planGap': {'enum': ['above-plan', 'as-planned', 'below-plan', 'harm', 'unknown']},
        'publish': {'enum': ['no', 'anonymous', 'named']}, 'system': LINE}},
    {'type': 'object', 'required': ['kind', 'event'], 'properties': {
        'kind': {'const': 'request'}, 'event': event_words, 'system': LINE, 'systemRegistryUrl': {'type': 'string', 'pattern': '^https://'},
        'plan': {'type': 'object', 'properties': {'promise': TEXT, 'plannedV': {'type': 'number', 'minimum': -1, 'maximum': 1}}}}},
    {'type': 'object', 'required': ['kind', 'receipt'], 'properties': {'kind': {'const': 'event-offer'}, 'receipt': {'$ref': 'receipt.schema.json'},
        'opening': {'type': 'object', 'description': 'What the digests hide, for the other party only',
                    'properties': {'action': {'type': 'object', 'required': ['salt', 'text'], 'properties': {'salt': c('b64u'), 'text': LINE}},
                                   'objects': {'type': 'array', 'items': {'type': 'object', 'required': ['salt', 'label'], 'properties': {
                                       'salt': c('b64u'), 'label': LINE, 'quantity': {'type': ['number', 'null']}, 'unit': {'type': ['string', 'null']}, 'note': {'type': ['string', 'null']}}}},
                                   'roles': {'type': 'array', 'items': {'enum': ['actor', 'affected', 'user', 'witness', 'party']}},
                                   'occurredAt': {'oneOf': [c('time'), c('date')]}}}}},
    {'type': 'object', 'required': ['kind', 'card'], 'properties': {'kind': {'const': 'card'}, 'card': {'$ref': 'card.schema.json'}}},
    {'type': 'object', 'required': ['kind', 'events'], 'properties': {'kind': {'const': 'suggestion'}, 'source': LINE,
        'events': {'type': 'array', 'minItems': 1, 'items': event_words}}},
]}
message = {
    '$schema': S, '$id': B + 'message.schema.json', 'title': 'aevri.vledger 1.0-d2 encrypted message between wallets',
    'type': 'object', 'required': ['type', 'version', 'id', 'to', 'sentAt', 'epk', 'iv', 'ct'],
    'properties': {'type': {'const': 'aevri.vledger.message'}, 'version': {'const': 1}, 'id': ID, 'to': c('address'),
                   'from': c('address'), 'sentAt': c('time'), 'epk': c('ecJwk'),
                   'iv': {'$ref': 'common.schema.json#/$defs/b64u', 'minLength': 16, 'maxLength': 16}, 'ct': c('b64u'), 'sig': c('b64u')},
    'dependentRequired': {'from': ['sig'], 'sig': ['from']},
    '$defs': {'body': body},
}

item = {'type': 'object', 'required': ['itemId', 'kind', 'title', 'system'], 'properties': {
    'itemId': {'type': 'string', 'pattern': '^[A-Za-z0-9._-]{1,100}$'}, 'kind': {'enum': ['object', 'event']},
    'title': LINE, 'system': {'type': 'string', 'maxLength': 60}, 'category': {'enum': CATS}, 'url': {'type': 'string', 'pattern': '^https://'},
    'actions': {'type': 'array', 'items': LINE}, 'affects': TEXT, 'occurredAt': {'oneOf': [c('time'), c('date')]},
    'plan': {'type': 'object', 'required': ['promise'], 'properties': {'promise': TEXT, 'plannedV': {'type': 'number', 'minimum': -1, 'maximum': 1}}}}}
ref = {'type': 'object', 'required': ['system', 'phrase', 'v'], 'properties': {
    'system': {'type': 'string', 'maxLength': 60}, 'phrase': LINE, 'v': {'type': 'number'}, 'words': TEXT}}
system = {'type': 'object', 'required': ['systemId', 'title'], 'properties': {'systemId': {'type': 'string', 'maxLength': 60}, 'title': LINE, 'note': TEXT}}
reg_body = {'type': 'object', 'required': ['type', 'version', 'registryUrl', 'owner', 'updatedAt', 'systems', 'items'], 'properties': {
    'type': {'const': 'aevri.vledger.registry'}, 'version': {'const': 1}, 'registryUrl': {'type': 'string', 'pattern': '^https://'},
    'owner': {'$ref': 'card.schema.json'}, 'updatedAt': c('time'),
    'systems': {'type': 'array', 'items': system}, 'items': {'type': 'array', 'items': item},
    'references': {'type': 'array', 'items': ref}}}
registry = {
    '$schema': S, '$id': B + 'registry.schema.json', 'title': 'aevri.vledger 1.0-d2 signed registry of objects and events',
    'type': 'object', 'required': ['registry', 'sig'], 'properties': {'registry': reg_body, 'sig': c('b64u')},
}

flowRef = {'type': 'object', 'required': ['vssSchemaId', 'flowId'], 'properties': {'vssSchemaId': {'type': 'string'}, 'flowId': {'type': 'string'},
    'flowLabel': {'type': 'string'}, 'sourceNode': {'type': 'object'}, 'targetNode': {'type': 'object'}}}
ledgerRef = {'type': 'object', 'required': ['ledgerId', 'entryId'], 'properties': {'ledgerId': ID, 'entryId': ID, 'assessorId': c('address')}}
summary = {'type': 'object', 'required': ['occurredAt', 'assessed'], 'properties': {'occurredAt': {'type': 'string'}, 'role': {'type': 'string'},
    'assessed': {'type': 'boolean'}, 'v': {'type': 'number'}, 'spentV': {'type': 'number'}, 'phase': {'enum': ['realized', 'retro']}}}
envelope = lambda proto: {'type': 'object', 'required': ['protocol', 'version', 'type', 'requestId', 'payload'], 'properties': {
    'protocol': {'const': proto}, 'version': {'const': 1}, 'type': {'type': 'string'}, 'requestId': {'type': 'string'}, 'payload': {'type': 'object'}}}
bridge = {
    '$schema': S, '$id': B + 'bridge.schema.json', 'title': 'aevri.vledger 1.0-d5 bridges to VET and VSS (SPEC 16)',
    '$defs': {
        'vetEnvelope': envelope('aevri.vet'), 'ledgerEnvelope': envelope('aevri.vledger'), 'flowRef': flowRef, 'ledgerRef': ledgerRef, 'summary': summary,
        'ledgerOpen': {'type': 'object', 'required': ['mode', 'ledgerRef', 'items', 'axes'], 'properties': {
            'mode': {'const': 'receiver'}, 'ledgerRef': ledgerRef, 'title': {'type': 'string'}, 'lang': {'type': 'string'},
            'items': {'type': 'array', 'items': {'type': 'object', 'required': ['title', 'ledgerRef'], 'properties': {'title': {'type': 'string'}, 'typeName': {'type': 'string'},
                'ledgerRef': {'type': 'object', 'required': ['ledgerId', 'entryId'], 'properties': {'ledgerId': ID, 'entryId': ID, 'objectIndex': {'type': 'integer', 'minimum': 0}}}}}},
            'axes': {'type': 'object', 'required': ['out', 'in'], 'properties': {'out': {'type': 'object', 'required': ['label']}, 'in': {'type': 'object', 'required': ['label']}}},
            'extensions': {'type': 'object', 'properties': {'aevriLedger': {'type': 'object', 'properties': {'schemaVersion': {'type': 'string'}, 'boardSnapshot': {'type': ['object', 'null']}, 'boardId': {'type': ['string', 'null']}}}}}}},
        'vetResult': {'type': 'object', 'required': ['boardId', 'ledgerRef', 'items', 'totals'], 'properties': {
            'boardId': {'type': 'string'}, 'ledgerRef': ledgerRef, 'items': {'type': 'array'}, 'totals': {'type': 'object'}, 'axes': {'type': 'object'},
            'extensions': {'type': 'object', 'properties': {'aevriLedger': {'type': 'object', 'required': ['resultId', 'boardSnapshot'], 'properties': {
                'schemaVersion': {'type': 'string'}, 'resultId': {'type': 'string'}, 'resultRevision': {'type': 'number'}, 'boardSnapshot': {'type': 'object'}}}}}}},
        'transferContext': {'type': 'object', 'required': ['flowRef'], 'properties': {'flowRef': flowRef,
            'elementType': {'type': 'object', 'properties': {'id': {'type': 'string'}, 'name': {'type': 'string'}, 'kind': {'enum': ['value', 'anti_value']}}},
            'item': {'type': 'object', 'properties': {'boardId': {'type': 'string'}, 'itemId': {'type': 'string'}, 'title': {'type': 'string'}}}}},
        'transferSaved': {'type': 'object', 'required': ['ledgerRef', 'summary'], 'properties': {'ledgerRef': ledgerRef, 'summary': summary}},
        'transfers': {'type': 'object', 'required': ['flowRef', 'transfers'], 'properties': {'flowRef': flowRef,
            'transfers': {'type': 'array', 'items': {'type': 'object', 'required': ['ledgerRef', 'summary'], 'properties': {'ledgerRef': ledgerRef, 'summary': summary}}}}},
    },
}

for name, doc in [('payload', payload), ('receipt', receipt), ('card', card), ('message', message), ('registry', registry), ('bridge', bridge)]:
    (OUT / (name + '.schema.json')).write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('wrote', name)
