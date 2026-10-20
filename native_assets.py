"""Server-owned mapping: web furniture IDs to native Blender assets.

Paths never come from a browser request. Add a registered pair here when adding
a new GLB preview / source.blend master to the furniture library.
"""
from pathlib import Path
from asset_catalog import catalog_items

ROOT = Path(__file__).resolve().parent
NATIVE_ASSETS = {
    'dentalchair': dict(folder='dental-chair', colours=['BlueLeather.001'], mode='set'),
    'indoorplant': dict(folder='indoor-plant', colours=['Material'], mode='multiply'),
    'hertfordchair': dict(folder='hertford-chair', colours=['Material.002', 'Material.003'], mode='multiply'),
    'meetingtableu': dict(folder='meeting-table-u', colours=['LAS_big_mat1'], mode='multiply'),
    'grandfir': dict(folder='grand-fir', colours=['fir_needles', 'fir_needles2'], mode='multiply'),
    'receptiontable': dict(folder='reception-table', colours=['Simple wood.001'], mode='multiply'),
    'imaccomputer': dict(folder='imac-computer', colours=['Aluminium', 'aluminium.001'], mode='multiply'),
    'testmodel222': dict(folder='test-model-222', colours=['*'], mode='multiply'),
}


def refresh_assets():
    items = catalog_items()
    for key in list(NATIVE_ASSETS):
        if key.startswith('user_'):
            del NATIVE_ASSETS[key]
    for item in items:
        NATIVE_ASSETS[item['type']] = dict(folder=item['folder'], colours=['*'], mode='multiply')


refresh_assets()


def source_path(asset_type):
    return ROOT / 'assets' / 'models' / NATIVE_ASSETS[asset_type]['folder'] / 'source.blend'
