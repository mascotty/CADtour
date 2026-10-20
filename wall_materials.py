"""Known wall finishes: retain exported metric UVs and use original 2K maps."""
import math
from pathlib import Path
import re
import bpy

ROOT = Path(__file__).resolve().parent / 'assets' / 'materials'
FINISHES = {'wallpaper001b': ROOT / 'wallpaper-001b' / 'source' / 'Wallpaper001B_2K-JPG'}
UV_NAME = 'CADtour_Wall_Finish'


def prepare_wall_uvs(obj):
    if obj.get('CADtour_native_asset'):
        return
    if not any(m and m.get('wallFinish') in FINISHES for m in obj.data.materials):
        return
    source = obj.data.uv_layers.active
    active_index = obj.data.uv_layers.active_index
    if source is None:
        raise ValueError('Missing wall texture coordinates: ' + obj.name)
    target = obj.data.uv_layers.get(UV_NAME) or obj.data.uv_layers.new(name=UV_NAME)
    obj.data.uv_layers.active_index = active_index
    # Three TextureLoader flips pixels when uploading; GLTFExporter writes those
    # flipped pixels. Blender then converts glTF V to 1-V. Original source maps
    # are unflipped, so recover the original metric UVs in a separate layer.
    # NormalMap must use this layer too, to preserve its tangent orientation.
    for original, corrected in zip(source.data, target.data):
        corrected.uv = (original.uv.x, 1 - original.uv.y)


def bounded(value, default, minimum, maximum):
    return max(minimum, min(maximum, value)) if isinstance(value, (int, float)) and math.isfinite(value) else default


def apply_wall_finish(material, principled):
    finish = material.get('wallFinish', 'plain')
    if finish == 'plain':
        return False
    if finish not in FINISHES:
        raise ValueError('Unknown wall finish: ' + str(finish))
    nodes, links = material.node_tree.nodes, material.node_tree.links
    # Replace imported 1K textures rather than accidentally using them in Cycles.
    for node in list(nodes):
        if node.type in ('TEX_IMAGE', 'NORMAL_MAP'):
            nodes.remove(node)
    uv = nodes.new('ShaderNodeUVMap')
    uv.uv_map = UV_NAME
    images = {}
    for channel, colour_space in [('Color', 'sRGB'), ('Roughness', 'Non-Color'), ('NormalGL', 'Non-Color')]:
        path = Path(str(FINISHES[finish]) + '_' + channel + '.jpg')
        if not path.is_file():
            raise FileNotFoundError('Missing wall texture: ' + str(path))
        image = bpy.data.images.load(str(path), check_existing=True)
        image.colorspace_settings.name = colour_space
        node = nodes.new('ShaderNodeTexImage')
        node.label = 'CADtour 2K ' + channel
        node.image = image
        node.extension = 'REPEAT'
        links.new(uv.outputs['UV'], node.inputs['Vector'])
        images[channel] = node
    tint = material.get('wallTint', '#ffffff')
    if not isinstance(tint, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', tint):
        raise ValueError('Invalid wall tint')
    def linear(c):
        c = int(c, 16) / 255
        return c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4
    multiply = nodes.new('ShaderNodeMixRGB')
    multiply.blend_type = 'MULTIPLY'
    multiply.inputs[0].default_value = 1
    multiply.inputs[2].default_value = tuple(linear(tint[i:i+2]) for i in (1, 3, 5)) + (1,)
    links.new(images['Color'].outputs['Color'], multiply.inputs[1])
    links.new(multiply.outputs[0], principled.inputs['Base Color'])
    links.new(images['Roughness'].outputs['Color'], principled.inputs['Roughness'])
    normal = nodes.new('ShaderNodeNormalMap')
    normal.uv_map = UV_NAME
    normal.inputs['Strength'].default_value = bounded(material.get('wallNormalStrength'), .3, 0, 1)
    links.new(images['NormalGL'].outputs['Color'], normal.inputs['Color'])
    links.new(normal.outputs['Normal'], principled.inputs['Normal'])
    material['CADtour_wall_finish'] = finish
    material['CADtour_wall_texture_size'] = bounded(material.get('wallTextureSize'), 1, .1, 10)
    return True
