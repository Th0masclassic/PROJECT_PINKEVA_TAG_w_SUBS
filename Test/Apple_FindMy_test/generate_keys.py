#!/usr/bin/env python3
import base64,hashlib,os
from cryptography.hazmat.primitives.asymmetric import ec
import argparse

def sha256(data):
    digest = hashlib.new("sha256")
    digest.update(data)
    return digest.digest()


parser = argparse.ArgumentParser()
parser.add_argument('-n','--nkeys', help='number of keys to generate', type=int, default=1)
parser.add_argument('-p','--prefix', help='prefix of the keyfiles')
parser.add_argument('-y','--yaml', help='yaml file where to write the list of generated keys')
parser.add_argument('-v','--verbose', help='print keys as they are generated', action="store_true")
args = parser.parse_args()

if args.yaml:
    yaml=open(args.yaml + '.yaml','w')
    yaml.write('  keys:\n')

nkeys = 0
while nkeys < args.nkeys:
    # cryptography delegates P-224 scalar generation to OpenSSL's CSPRNG.
    # Python's random module must never generate finder private keys.
    private_key = ec.generate_private_key(ec.SECP224R1())
    priv = private_key.private_numbers().private_value
    adv = private_key.public_key().public_numbers().x

    priv_bytes = int.to_bytes(priv, 28, 'big')
    adv_bytes = int.to_bytes(adv, 28, 'big')

    priv_b64 = base64.b64encode(priv_bytes).decode("ascii")
    adv_b64 = base64.b64encode(adv_bytes).decode("ascii")
    s256_b64 = base64.b64encode(sha256(adv_bytes)).decode("ascii")

    if args.verbose:
        print('%d)' % (nkeys+1))
        print('Private key: %s' % priv_b64)
        print('Advertisement key: %s' % adv_b64)
        print('Hashed adv key: %s' % s256_b64)

    if args.prefix and not s256_b64.startswith(args.prefix):
        continue
    elif '/' in s256_b64[:7]:
        print('no key file written, there was a / in the b64 of the hashed pubkey :(')
    else:
        fname = '%s.keys' % s256_b64[:7]
        if args.prefix:
            print(f'writing {fname}')

        # Private-key files must not overwrite an existing allocation and must
        # not be group/world readable even under an unsafe default umask.
        descriptor = os.open(fname, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as f:
            f.write('Private key: %s\n' % priv_b64)
            f.write('Advertisement key: %s\n' % adv_b64)
            f.write('Hashed adv key: %s\n' % s256_b64)

        if args.yaml:
            yaml.write('    - "%s"\n' % adv_b64)

        nkeys += 1
