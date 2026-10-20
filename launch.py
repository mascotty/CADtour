"""Start the local application without machine-specific installation paths."""
import argparse
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description='CADtour local launcher')
    parser.add_argument('--port', type=int, default=4180)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--check', action='store_true', help='Check dependencies without starting')
    args = parser.parse_args()
    if sys.version_info < (3, 10):
        raise RuntimeError('Python 3.10 or newer is required.')
    if not 1024 <= args.port <= 65535:
        raise RuntimeError('Choose a port between 1024 and 65535.')
    from render_server import find_blender
    blender = find_blender()
    print('Python:', sys.version.split()[0])
    print('Project:', ROOT)
    print('Blender:', blender if Path(blender).is_file() else 'Not found. Editing works; install Blender for import/render.')
    print('Solid lettering:', 'Available on Windows' if os.name == 'nt' else 'Requires Windows local fonts')
    required = ['index.html', 'vendor/three/build/three.module.js', 'assets/models/catalog.json']
    for filename in required:
        if not (ROOT / filename).is_file():
            raise RuntimeError('Missing release file: ' + filename + '. Extract the complete ZIP first.')
    if args.check:
        return
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', args.port))
        except OSError as error:
            raise RuntimeError(f'Port {args.port} is in use. Close the previous server, or use --port 4181.') from error
    url = f'http://127.0.0.1:{args.port}'
    process = subprocess.Popen([sys.executable, '-u', str(ROOT / 'render_server.py'), '--port', str(args.port)], cwd=ROOT)
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError('Server exited; see the error above.')
            try:
                with urllib.request.urlopen(url + '/api/assets/catalog', timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Server did not become ready.')
        print('\nOpen: ' + url + '\nKeep this window open. Press Ctrl+C to stop.\n', flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        process.wait()
    except KeyboardInterrupt:
        print('\nStopping CADtour...')
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError) as error:
        print('ERROR:', error, file=sys.stderr)
        sys.exit(1)
