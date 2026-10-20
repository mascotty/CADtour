"""Local-only CADtour web server and isolated Blender Cycles worker."""
import argparse
import base64
import json
import math
import os
from pathlib import Path
import re
import signal
import shutil
import struct
import subprocess
import sys
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from native_assets import NATIVE_ASSETS, source_path, refresh_assets

ROOT = Path(__file__).resolve().parent
RENDERS = ROOT / '.renders'
def find_blender():
    configured = os.environ.get('CADTOUR_BLENDER')
    if configured:
        return configured
    executable = shutil.which('blender')
    if executable:
        return executable
    if os.name == 'nt':
        base = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Blender Foundation'
        candidates = sorted(base.glob('Blender */blender.exe'), reverse=True)
        if candidates:
            return str(candidates[0])
    return '/Applications/Blender.app/Contents/MacOS/Blender' if sys.platform == 'darwin' else '/usr/bin/blender'


BLENDER = find_blender()
JOBS = {}
LOCK = threading.Lock()
ACTIVE = None
MAX_MODEL = 128 * 1024 * 1024
# Base64 model + optional reference PNG and scene metadata.
MAX_BODY = 192 * 1024 * 1024
JOB_ROUTE = re.compile(r'^/api/cycles/jobs/([0-9a-f]{32})(?:/(result\.png|scene\.blend))?$')


def finite(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('Invalid numeric render setting')
    return value


def validate(payload):
    refresh_assets()
    meta = payload['metadata']
    for key in ('width', 'height'):
        if int(finite(meta[key], 64, 3840)) != meta[key]:
            raise ValueError('Resolution must use integer pixels')
    if meta['quality'] not in ('standard', 'fine'):
        raise ValueError('Invalid quality')
    finite(meta['exposure'], .5, 1.5)
    finite(meta['hour'], 0, 24)
    finite(meta['ceiling'], .5, 20)
    if not isinstance(meta['night'], bool):
        raise ValueError('Invalid lighting mode')
    cam = meta['camera']
    finite(cam['fov'], 10, 120)
    finite(cam['aspect'], .1, 10)
    if abs(meta['width'] / meta['height'] - cam['aspect']) > .03:
        raise ValueError('Camera aspect does not match output')
    if len(cam['matrix']) != 16:
        raise ValueError('Invalid camera matrix')
    for n in cam['matrix']:
        finite(n, -1e5, 1e5)
    if 'nativeFurniture' in meta:
        instances = meta['nativeFurniture']
        if not isinstance(instances, list) or len(instances) > 1000:
            raise ValueError('Invalid native furniture list')
        ids = set()
        for item in instances:
            fid = item['id']
            if not isinstance(fid, str) or not 1 <= len(fid) <= 100 or fid in ids:
                raise ValueError('Invalid or duplicate native furniture ID')
            ids.add(fid)
            if item['type'] not in NATIVE_ASSETS:
                raise ValueError('Unregistered native furniture type')
            if not source_path(item['type']).is_file():
                raise ValueError('缺少渲染模型：' + str(source_path(item['type'])))
            if not isinstance(item['colour'], str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', item['colour']):
                raise ValueError('Invalid native furniture colour')
            if 'preserveMaterials' in item and not isinstance(item['preserveMaterials'], bool):
                raise ValueError('Invalid native furniture material option')
            if len(item['size']) != 3 or len(item['matrix']) != 16:
                raise ValueError('Invalid native furniture transform')
            for n in item['size']:
                finite(n, .001, 100)
            m = item['matrix']
            for n in m:
                finite(n, -1e5, 1e5)
            determinant = m[0]*(m[5]*m[10]-m[9]*m[6])-m[4]*(m[1]*m[10]-m[9]*m[2])+m[8]*(m[1]*m[6]-m[5]*m[2])
            if [m[i] for i in (3, 7, 11, 15)] != [0, 0, 0, 1] or abs(determinant) < 1e-9:
                raise ValueError('Invalid native furniture matrix')
    if len(meta['rooms']) > 1000:
        raise ValueError('Too many room lights')
    for room in meta['rooms']:
        if len(room['center']) != 3:
            raise ValueError('Invalid light position')
        for n in room['center']:
            finite(n, -1e5, 1e5)
        finite(room['area'], 0, 1e6)
    if 'lights' in meta:
        if not isinstance(meta['lights'], list) or len(meta['lights']) > 1000:
            raise ValueError('Too many ceiling lights')
        for lamp in meta['lights']:
            if len(lamp['center']) != 3:
                raise ValueError('Invalid ceiling light position')
            for n in lamp['center']:
                finite(n, -1e5, 1e5)
            finite(lamp['area'], 0, 1e6)
            finite(lamp['size'], .05, 5)
    glb = base64.b64decode(payload['glb'], validate=True)
    if not 20 <= len(glb) <= MAX_MODEL:
        raise ValueError('Invalid model size (maximum 128 MB)')
    magic, version, length = struct.unpack_from('<4sII', glb)
    if magic != b'glTF' or version != 2 or length != len(glb):
        raise ValueError('Invalid GLB model')
    return meta, glb


def stop(job):
    job['cancel'] = True
    proc = job.get('process')
    if proc and proc.poll() is None:
        try:
            if os.name == 'nt':
                proc.terminate()
            else:
                os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        def force_stop():
            if proc.poll() is None:
                try:
                    if os.name == 'nt':
                        subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                                       capture_output=True, check=False)
                    else:
                        os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        killer = threading.Timer(5, force_stop)
        killer.daemon = True
        killer.start()


def run_job(job):
    global ACTIVE
    directory = RENDERS / job['id']
    timer = threading.Timer(1200, lambda: stop(job))
    try:
        job.update(state='running', stage='Blender: importing model')
        command = [BLENDER, '--background', '--factory-startup', '--disable-autoexec', '--threads', '4',
                   '--python-exit-code', '1', '--python', str(ROOT / 'cycles_render.py'), '--', '--job', str(directory)]
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, errors='replace', start_new_session=True)
        job['process'] = proc
        if job['cancel']:
            stop(job)
        timer.start()
        with (directory / 'blender.log').open('w') as log:
            for line in proc.stdout:
                log.write(line)
                log.flush()
                if 'CADTOUR_STAGE:' in line:
                    job['stage'] = line.split('CADTOUR_STAGE:', 1)[1].strip()[:150]
                elif 'Sample ' in line:
                    sample = re.search(r'Sample\s+(\d+)\s*/\s*(\d+)', line)
                    if sample:
                        job['stage'] = 'Cycles: sample ' + sample[1] + ' / ' + sample[2]
            code = proc.wait()
        if job['cancel']:
            job.update(state='cancelled', stage='Cancelled')
        elif code != 0 or not (directory / 'result.png').is_file():
            tail = (directory / 'blender.log').read_text(errors='replace')[-1600:]
            job.update(state='failed', error='Blender failed: ' + tail)
        else:
            summary = json.loads((directory / 'summary.json').read_text())
            job.update(state='done', stage='Complete', summary=summary)
    except Exception as error:
        job.update(state='failed', error=str(error))
    finally:
        timer.cancel()
        proc = job.get('process')
        if proc and proc.poll() is None:
            stop(job)
            proc.wait(timeout=10)
        job['finished'] = time.monotonic()
        with LOCK:
            ACTIVE = None


def public_job(job):
    result = {key: job[key] for key in ('id', 'state', 'stage', 'width', 'height')}
    result['elapsed'] = (job.get('finished') or time.monotonic()) - job['started']
    if job.get('error'):
        result['error'] = job['error']
    if job['state'] == 'done':
        result.update(image='/api/cycles/jobs/' + job['id'] + '/result.png',
                      blend='/api/cycles/jobs/' + job['id'] + '/scene.blend', summary=job.get('summary'))
    return result


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def local_request(self, write=False):
        allowed = {'127.0.0.1:' + str(self.server.server_port), 'localhost:' + str(self.server.server_port)}
        if self.headers.get('Host') not in allowed:
            self.reply(403, {'error': 'Localhost requests only'})
            return False
        origin = self.headers.get('Origin')
        if origin and origin not in {'http://' + host for host in allowed}:
            self.reply(403, {'error': 'Cross-origin requests are not allowed'})
            return False
        if write and self.headers.get('X-CADtour') != '1':
            self.reply(403, {'error': 'Missing local request header'})
            return False
        return True

    def reply(self, code, value):
        body = json.dumps(value, ensure_ascii=True).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def safe_static(self, path):
        resolved = Path(self.translate_path(path)).resolve()
        return (resolved.is_relative_to(ROOT)
                and not any(p.startswith('.') for p in resolved.relative_to(ROOT).parts)
                and (not resolved.is_dir() or resolved == ROOT))

    def do_HEAD(self):
        if not self.local_request():
            return
        path = urlsplit(self.path).path
        if path.startswith('/api/') or not self.safe_static(path):
            self.send_error(403)
            return
        super().do_HEAD()

    def do_GET(self):
        if not self.local_request():
            return
        path = urlsplit(self.path).path
        if path.startswith('/api/assets/'):
            from asset_import import handle_request
            return handle_request(self, 'GET', BLENDER)
        if path == '/api/cycles/health':
            self.reply(200 if Path(BLENDER).is_file() else 503, {'engine': 'Cycles', 'error': None if Path(BLENDER).is_file() else 'Blender executable not found'})
            return
        match = JOB_ROUTE.fullmatch(path)
        if match:
            job = JOBS.get(match[1])
            if not job:
                self.reply(404, {'error': 'Render job not found'})
            elif not match[2]:
                self.reply(200, public_job(job))
            elif job['state'] != 'done':
                self.reply(409, {'error': 'Render is not finished'})
            else:
                file = RENDERS / match[1] / match[2]
                self.send_response(200)
                self.send_header('Content-Type', 'image/png' if match[2].endswith('.png') else 'application/octet-stream')
                self.send_header('Content-Length', str(file.stat().st_size))
                if match[2].endswith('.blend'):
                    self.send_header('Content-Disposition', 'attachment; filename="CADtour-scene.blend"')
                self.end_headers()
                with file.open('rb') as stream:
                    import shutil
                    shutil.copyfileobj(stream, self.wfile)
            return
        if path.startswith('/api/'):
            self.reply(404, {'error': 'Unknown endpoint'})
            return
        if not self.safe_static(path):
            self.send_error(403)
            return
        super().do_GET()

    def do_POST(self):
        global ACTIVE
        if not self.local_request(write=True):
            return
        if urlsplit(self.path).path.startswith('/api/assets/'):
            from asset_import import handle_request
            return handle_request(self, 'POST', BLENDER)
        if self.path == '/api/wall-text/outlines':
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 8192:
                    raise ValueError('立体文字请求过大或为空。')
                self.connection.settimeout(20)
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError('立体文字请求格式无效。')
                from wall_text_outlines import text_outlines
                outlines = text_outlines(payload.get('font'), payload.get('text'))
            except (ValueError, TypeError, OSError) as error:
                self.reply(400, {'error': str(error)})
            except RuntimeError as error:
                self.reply(503, {'error': str(error)})
            else:
                self.reply(200, outlines)
            return
        if self.path != '/api/cycles/jobs':
            self.reply(404, {'error': 'Unknown endpoint'})
            return
        with LOCK:
            if ACTIVE:
                self.reply(409, {'error': 'Another render is active. Wait or cancel it first.'})
                return
            if not Path(BLENDER).is_file():
                self.reply(503, {'error': 'Blender executable not found'})
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= MAX_BODY:
                    raise ValueError(f'Upload is empty or exceeds {MAX_BODY // (1024 * 1024)} MB')
                self.connection.settimeout(60)
                payload = json.loads(self.rfile.read(size))
                meta, glb = validate(payload)
                identifier = uuid.uuid4().hex
                directory = RENDERS / identifier
                directory.mkdir(parents=True)
                (directory / 'scene.glb').write_bytes(glb)
                (directory / 'metadata.json').write_text(json.dumps(meta))
                reference = payload.get('reference')
                if isinstance(reference, str) and reference.startswith('data:image/png;base64,') and len(reference) < 12 * 1024 * 1024:
                    (directory / 'reference.png').write_bytes(base64.b64decode(reference.split(',', 1)[1], validate=True))
                job = dict(id=identifier, state='queued', stage='Queued', started=time.monotonic(),
                           width=meta['width'], height=meta['height'], cancel=False)
                JOBS[identifier] = job
                ACTIVE = identifier
            except (ValueError, KeyError, TypeError, OSError) as error:
                self.reply(400, {'error': str(error)})
                return
        threading.Thread(target=run_job, args=(job,), daemon=True).start()
        self.reply(202, public_job(job))

    def do_DELETE(self):
        if not self.local_request(write=True):
            return
        if urlsplit(self.path).path.startswith('/api/assets/'):
            from asset_import import handle_request
            return handle_request(self, 'DELETE', BLENDER)
        match = JOB_ROUTE.fullmatch(self.path)
        job = JOBS.get(match[1]) if match and not match[2] else None
        if not job:
            self.reply(404, {'error': 'Render job not found'})
        else:
            if job['state'] in ('queued', 'running'):
                stop(job)
            self.reply(200, public_job(job))


    def do_PUT(self):
        if not self.local_request(write=True):
            return
        from asset_import import handle_request
        return handle_request(self, 'PUT', BLENDER)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4180)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print('CADtour + Cycles: http://127.0.0.1:' + str(args.port), flush=True)
    try:
        server.serve_forever()
    finally:
        for job in JOBS.values():
            if job['state'] in ('queued', 'running'):
                stop(job)
        server.server_close()
