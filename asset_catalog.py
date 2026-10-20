"""Local, immutable model IDs shared by the web library and Cycles."""
import json
import math
from pathlib import Path
import re
import threading

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / 'assets' / 'models'
CATALOG = MODELS / 'catalog.json'
CATALOG_LOCK = threading.Lock()
TYPE_RE = re.compile(r'^user_([a-f0-9]{32})$')


def valid_item(item):
    if not isinstance(item, dict) or not TYPE_RE.fullmatch(str(item.get('type', ''))):
        return False
    identifier = TYPE_RE.fullmatch(item['type'])[1]
    return (item.get('folder') == 'user-' + identifier
            and isinstance(item.get('name'), str) and 1 <= len(item['name']) <= 80
            and isinstance(item.get('category'), str) and 1 <= len(item['category']) <= 40
            and all(isinstance(item.get(k), (int, float)) and not isinstance(item[k], bool)
                    and math.isfinite(item[k]) and .001 <= item[k] <= 100 for k in ('width', 'height', 'depth')))


def _read_catalog(path):
    if not path.is_file():
        return []
    items = json.loads(path.read_text(encoding='utf-8')).get('items')
    if not isinstance(items, list) or not all(valid_item(item) for item in items) or len({item['type'] for item in items}) != len(items):
        raise ValueError('本地素材清单损坏，请从备份恢复 catalog.json。')
    return items


def catalog_items():
    items = _read_catalog(CATALOG) + _read_catalog(CATALOG.with_name('catalog.local.json'))
    if len({item['type'] for item in items}) != len(items):
        raise ValueError('素材清单存在重复 ID，请检查 catalog.json 和 catalog.local.json。')
    return items


def publish_item(item):
    if not valid_item(item):
        raise ValueError('素材尺寸或信息无效。')
    with CATALOG_LOCK:
        items = catalog_items()
        if any(old['type'] == item['type'] for old in items):
            return next(old for old in items if old['type'] == item['type'])
        local = CATALOG.with_name('catalog.local.json')
        local.parent.mkdir(parents=True, exist_ok=True)
        temporary = local.with_suffix('.json.tmp')
        temporary.write_text(json.dumps({'version': 1, 'items': _read_catalog(local) + [item]}, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(local)
    return item
