"""Bounded uploads, isolated conversion, preview and atomic library publication."""
import json
import math
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlsplit
import uuid
import zipfile

from asset_catalog import ROOT, MODELS, catalog_items, publish_item

STAGING = ROOT / '.asset-imports'
JOBS = {}
LOCK = threading.RLock()
MAX_UPLOAD = 256 * 1024 * 1024
MAX_EXPANDED = 1024 * 1024 * 1024
MODELS_EXT = {'.blend', '.fbx', '.glb'}
ALLOWED = MODELS_EXT | {'.zip', '.png', '.jpg', '.jpeg', '.tga', '.tif', '.tiff', '.bmp', '.webp', '.exr', '.hdr'}
ROUTE = re.compile(r'^/api/assets/imports/([a-f0-9]{32})(?:/(files|prepare|publish|model.glb|preview.png))?$')


def save_job(job):
    with LOCK:
        public = {k: v for k, v in job.items() if k != 'process'}
        path = STAGING / job['id'] / 'job.json'
        temporary = path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(public, ensure_ascii=False), encoding='utf-8')
        temporary.replace(path)


def load_job(identifier):
    if identifier in JOBS:
        return JOBS[identifier]
    file = STAGING / identifier / 'job.json'
    if not file.is_file():
        raise ValueError('找不到导入任务，请重新上传。')
    job = json.loads(file.read_text(encoding='utf-8'))
    if job['state'] == 'converting':
        job.update(state='failed', error='服务重启中断了转换，请重新导入。')
    JOBS[identifier] = job
    return job


def public_job(job):
    value = {k: v for k, v in job.items() if k not in ('process', 'files')}
    if job['state'] in ('ready', 'published'):
        value.update(model=f"/api/assets/imports/{job['id']}/model.glb", thumbnail=f"/api/assets/imports/{job['id']}/preview.png")
    return value


def options(data):
    if not isinstance(data, dict):
        raise ValueError('素材信息格式无效。')
    name, category = data.get('name'), data.get('category', '其他')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
        raise ValueError('请填写 1–80 个字符的模型名称。')
    if not isinstance(category, str) or not 1 <= len(category.strip()) <= 40:
        raise ValueError('分类名称应为 1–40 个字符。')
    yaw = data.get('yaw', 0)
    if isinstance(yaw, bool) or yaw not in (0, 90, 180, 270):
        raise ValueError('模型朝向无效。')
    return dict(name=name.strip(), category=category.strip(), yaw=yaw)


def json_body(handler):
    length = int(handler.headers.get('Content-Length', '0'))
    if not 0 < length <= 16384:
        raise ValueError('素材请求过大或为空。')
    return json.loads(handler.rfile.read(length))


def unpack(job):
    base = STAGING / job['id']
    destination = base / 'input'
    destination.mkdir(exist_ok=True)
    expanded = 0
    for filename in job['files']:
        upload = base / 'uploads' / filename
        if upload.suffix.lower() != '.zip':
            target = destination / filename
            if target.exists():
                raise ValueError('重复文件名：' + filename)
            shutil.copy2(upload, target)
            expanded += upload.stat().st_size
            continue
        with zipfile.ZipFile(upload) as archive:
            if len(archive.infolist()) > 2000:
                raise ValueError('压缩包超过 2000 个文件，请先整理。')
            for info in archive.infolist():
                name = info.filename.replace('\\', '/')
                relative = PurePosixPath(name)
                target = (destination / name).resolve()
                if relative.is_absolute() or '..' in relative.parts or ':' in name or not target.is_relative_to(destination.resolve()) or ((info.external_attr >> 16) & 0o170000) == 0o120000:
                    raise ValueError('压缩包包含无效路径。')
                if info.is_dir():
                    continue
                if target.suffix.lower() not in ALLOWED - {'.zip'}:
                    continue
                expanded += info.file_size
                if expanded > MAX_EXPANDED or info.flag_bits & 1:
                    raise ValueError('压缩包解压超过 1 GB 或包含加密文件。')
                if target.exists():
                    raise ValueError('压缩包中存在重复文件：' + name)
                target.parent.mkdir(parents=True, exist_ok=True)
                count = 0
                with archive.open(info) as source, target.open('xb') as output:
                    while chunk := source.read(1024 * 1024):
                        count += len(chunk)
                        if count > info.file_size or count > MAX_EXPANDED:
                            raise ValueError('压缩包文件长度无效。')
                        output.write(chunk)
        if expanded > MAX_EXPANDED:
            raise ValueError('素材解压超过 1 GB。')
    models = [p for p in destination.rglob('*') if p.suffix.lower() in MODELS_EXT and p.is_file()]
    if len(models) != 1:
        raise ValueError('每次请上传一个模型及其贴图；检测到 ' + str(len(models)) + ' 个模型文件。')
    return models[0]


def convert(job, blender):
    directory = STAGING / job['id']
    try:
        model = unpack(job)
        if job['state'] == 'cancelled':
            return
        command = [blender, '-b', '--factory-startup', '--disable-autoexec', '--threads', '2', '--python-exit-code', '1',
                   '--python', str(ROOT / 'import_model_asset.py'), '--', '--source', str(model), '--output', str(directory / 'output'),
                   '--id', 'user-' + job['id'], '--name', job['name'], '--yaw', str(job['yaw'])]
        with (directory / 'convert.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
            job['process'] = process
            if job['state'] == 'cancelled':
                process.terminate()
            try:
                code = process.wait(timeout=600)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise ValueError('模型转换超过 10 分钟，请先简化或清理模型。')
        if job['state'] == 'cancelled':
            return
        output = directory / 'output'
        if code or not (output / 'asset.json').is_file():
            lines = (directory / 'convert.log').read_text(encoding='utf-8', errors='replace').splitlines()
            detail = next((line.partition('CADTOUR_IMPORT_ERROR:')[2].strip() for line in reversed(lines) if 'CADTOUR_IMPORT_ERROR:' in line), '')
            raise ValueError(detail or 'Blender 转换失败，请检查模型文件与材质，日志保存在导入任务目录。')
        manifest = json.loads((output / 'asset.json').read_text(encoding='utf-8'))
        if not all((output / name).is_file() for name in ('source.blend', 'model.glb', 'preview.png')):
            raise ValueError('转换结果缺少预览或渲染文件。')
        if (output / 'model.glb').stat().st_size > 64 * 1024 * 1024:
            raise ValueError('网页模型仍超过 64 MB，请先简化模型或贴图。')
        with LOCK:
            if job['state'] != 'cancelled':
                job.update(state='ready', stage='预览已就绪，请核对材质和尺寸', manifest=manifest)
    except Exception as error:
        with LOCK:
            if job['state'] != 'cancelled':
                job.update(state='failed', error=str(error))
    finally:
        job.pop('process', None)
        save_job(job)


def publish(job, data):
    if job['state'] == 'published':
        return job['item']
    recovered = next((item for item in catalog_items() if item['type'] == 'user_' + job['id']), None)
    if recovered:
        job.update(state='published', item=recovered, stage='已加入素材库')
        save_job(job)
        return recovered
    if job['state'] != 'ready':
        raise ValueError('请等待模型转换和预览完成。')
    opts = options(data)
    width = data.get('widthMm')
    if isinstance(width, bool) or not isinstance(width, (int, float)) or not math.isfinite(width) or not 1 <= width <= 100000:
        raise ValueError('校正后的模型宽度应为 1–100000 mm。')
    manifest = job['manifest']
    ratio = width / 1000 / manifest['width']
    sizes = {key: manifest[key] * ratio for key in ('width', 'height', 'depth')}
    if not all(.001 <= v <= 100 for v in sizes.values()):
        raise ValueError('校正后的宽、深、高均应为 1–100000 mm。')
    item = dict(type='user_' + job['id'], folder='user-' + job['id'], name=opts['name'], category=opts['category'],
                **sizes, sourcePolygons=manifest['sourcePolygons'], webPolygons=manifest['webPolygons'],
                warnings=manifest.get('warnings', []), created=time.time())
    output = STAGING / job['id'] / 'output'
    target = MODELS / item['folder']
    # Finish a private copy before making the UUID folder and catalog visible.
    if target.exists():
        previous = json.loads((target / 'library.json').read_text(encoding='utf-8'))
        if previous['type'] != item['type']:
            raise ValueError('此素材目录已存在，请重新导入。')
    else:
        temporary = MODELS / ('.incoming-' + uuid.uuid4().hex)
        shutil.copytree(output, temporary)
        shutil.copytree(STAGING / job['id'] / 'uploads', temporary / 'originals')
        (temporary / 'library.json').write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding='utf-8')
        if temporary.resolve().parent != MODELS.resolve() or target.resolve().parent != MODELS.resolve():
            raise ValueError('素材保存路径无效。')
        temporary.rename(target)
    (target / 'library.json').write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding='utf-8')
    publish_item(item)
    job.update(state='published', item=item, stage='已加入素材库')
    save_job(job)
    return item


def handle_request(handler, method, blender):
    path = urlsplit(handler.path).path
    try:
        if method == 'GET' and path == '/api/assets/catalog':
            return handler.reply(200, {'items': catalog_items()})
        if method == 'POST' and path == '/api/assets/imports':
            if not Path(blender).is_file():
                raise ValueError('未找到 Blender，请先安装或配置 CADTOUR_BLENDER。')
            opts = options(json_body(handler))
            identifier = uuid.uuid4().hex
            (STAGING / identifier / 'uploads').mkdir(parents=True)
            job = dict(id=identifier, state='uploading', stage='等待文件上传', files=[], bytes=0, **opts)
            JOBS[identifier] = job
            save_job(job)
            return handler.reply(201, public_job(job))
        match = ROUTE.fullmatch(path)
        if not match:
            return handler.reply(404, {'error': 'Unknown asset endpoint'})
        with LOCK:
            job = load_job(match[1])
            action = match[2]
            if method == 'GET' and not action:
                return handler.reply(200, public_job(job))
            if method == 'GET' and action in ('model.glb', 'preview.png'):
                if job['state'] not in ('ready', 'published'):
                    raise ValueError('预览尚未生成。')
                file = STAGING / job['id'] / 'output' / action
                handler.send_response(200)
                handler.send_header('Content-Type', 'model/gltf-binary' if action.endswith('.glb') else 'image/png')
                handler.send_header('Content-Length', str(file.stat().st_size))
                handler.end_headers()
                with file.open('rb') as stream:
                    shutil.copyfileobj(stream, handler.wfile)
                return
            if method == 'PUT' and action == 'files':
                if job['state'] != 'uploading' or len(job['files']) >= 16:
                    raise ValueError('此任务不能继续上传，或已超过 16 个文件。')
                filename = parse_qs(urlsplit(handler.path).query).get('name', [''])[0]
                if not filename or len(filename) > 180 or any(c in filename for c in '/\\:\x00') or filename.startswith('.') or Path(filename).suffix.lower() not in ALLOWED or filename in job['files']:
                    raise ValueError('文件名、格式或重复文件无效。')
                length = int(handler.headers.get('Content-Length', '0'))
                if not 0 < length <= MAX_UPLOAD or job['bytes'] + length > MAX_UPLOAD:
                    raise ValueError('每次导入文件总大小不能超过 256 MB。')
                handler.connection.settimeout(120)
                target = STAGING / job['id'] / 'uploads' / filename
                with target.open('xb') as output:
                    remaining = length
                    while remaining:
                        chunk = handler.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError('文件上传中断，请重新创建导入任务。')
                        output.write(chunk)
                        remaining -= len(chunk)
                job['files'].append(filename)
                job['bytes'] += length
                save_job(job)
                return handler.reply(200, public_job(job))
            if method == 'POST' and action == 'prepare':
                if job['state'] != 'uploading' or not job['files']:
                    raise ValueError('请先上传模型文件。')
                if any(other['state'] == 'converting' for other in JOBS.values()):
                    return handler.reply(409, {'error': '已有素材正在转换，请稍后再试。'})
                job.update(state='converting', stage='Blender 正在检查贴图、生成网页模型和缩略图')
                save_job(job)
                threading.Thread(target=convert, args=(job, blender), daemon=True).start()
                return handler.reply(202, public_job(job))
            if method == 'POST' and action == 'publish':
                return handler.reply(200, {'item': publish(job, json_body(handler))})
            if method == 'DELETE' and not action:
                if job['state'] == 'published':
                    raise ValueError('素材已入库，关闭窗口不会删除已入库文件。')
                job.update(state='cancelled', stage='导入已取消')
                process = job.get('process')
                if process and process.poll() is None:
                    process.terminate()
                save_job(job)
                return handler.reply(200, public_job(job))
            return handler.reply(404, {'error': 'Unknown asset action'})
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile) as error:
        return handler.reply(400, {'error': str(error)})
