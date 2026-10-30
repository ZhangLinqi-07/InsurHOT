"""Verify and reassemble an InsurHOT data snapshot with Python 3."""
import argparse
import hashlib
import json
from pathlib import Path
import sys


def process(snapshot, output=None):
    manifest = json.loads((snapshot / 'manifest.json').read_text(encoding='utf-8'))
    if output is not None:
        output.mkdir(parents=True, exist_ok=False)
    source = manifest.get('sourcePatch')
    if source:
        if Path(source['file']).name != source['file']:
            raise ValueError('Invalid source patch name')
        content = (snapshot / source['file']).read_bytes()
        if len(content) != source['bytes'] or hashlib.sha256(content).hexdigest() != source['sha256']:
            raise ValueError('Source patch checksum mismatch')
        if output is not None:
            (output / source['file']).write_bytes(content)
        print(source['file'] + ' verified')
    for key in ('database', 'runtimeData'):
        archive = manifest[key]
        name = archive['name']
        if Path(name).name != name:
            raise ValueError('Invalid archive name')
        digest = hashlib.sha256()
        size = 0
        target = (output / name).open('xb') if output is not None else None
        try:
            for part in archive['parts']:
                if Path(part['file']).name != part['file']:
                    raise ValueError('Invalid part name')
                content = (snapshot / part['file']).read_bytes()
                if len(content) != part['bytes'] or hashlib.sha256(content).hexdigest() != part['sha256']:
                    raise ValueError('Part checksum mismatch for ' + part['file'])
                size += len(content)
                digest.update(content)
                if target:
                    target.write(content)
            if size != archive['bytes'] or digest.hexdigest() != archive['sha256']:
                raise ValueError('Archive checksum mismatch for ' + name)
        finally:
            if target:
                target.close()
        print(name + ' verified (' + str(size) + ' bytes)')
    print('Snapshot ' + manifest['snapshot'] + ' verified')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot', type=Path, help='Directory containing manifest.json and archive parts')
    parser.add_argument('--output', type=Path, help='New directory in which to reassemble the archives')
    args = parser.parse_args()
    try:
        process(args.snapshot.resolve(), args.output.resolve() if args.output else None)
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
