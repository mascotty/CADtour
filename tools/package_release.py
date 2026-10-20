"""Publish only reviewed files. Never sweep private runtime/model directories."""
from pathlib import Path
import argparse
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'RELEASE_FILES.json').read_text(encoding='utf8'))
    files = manifest['files'] + ['RELEASE_FILES.json']
    if len(files) != len(set(files)):
        raise ValueError('Duplicate release path')
    for filename in files:
        path = (ROOT / filename).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file() or (ROOT / filename).is_symlink():
            raise ValueError('Invalid release file: ' + filename)
        if any(part in {'.renders', '.asset-imports', '__pycache__', '.git', 'node_modules'} for part in path.relative_to(ROOT).parts):
            raise ValueError('Private runtime path in allowlist: ' + filename)
        if filename.endswith('catalog.local.json'):
            raise ValueError('Private model catalog in allowlist')
        if path.stat().st_size > 100 * 1024 * 1024:
            raise ValueError('File exceeds GitHub regular Git limit: ' + filename)
    print('Reviewed public files:', len(files))
    if args.check:
        return
    archive = ROOT.parent / (ROOT.name + '.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for filename in sorted(files):
            z.write(ROOT / filename, ROOT.name + '/' + filename)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(digest + '  ' + archive.name + '\n', encoding='ascii')
    print('Archive:', archive)
    print('SHA256:', digest)


if __name__ == '__main__':
    main()
