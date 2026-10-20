"""Prepare a downloaded Blendkit model for the existing Three.js/Cycles pipeline.

Run with Blender --background --factory-startup --disable-autoexec --python
prepare_model_asset.py -- --source path.blend --id indoor-plant --name "Plant indoor"
The source is copied intact; shader adaptations and tree LOD affect only the GLB.
"""
import argparse
from array import array
import json
from pathlib import Path
import shutil
import struct
import sys
import warnings
import re

import bmesh
import bpy
from mathutils import Matrix, Vector

warnings.filterwarnings('ignore', category=DeprecationWarning)
parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--id', required=True)
parser.add_argument('--output', type=Path)
parser.add_argument('--name', required=True)
parser.add_argument('--max-texture', type=int, default=1024)
parser.add_argument('--max-web-polygons', type=int, default=0)
parser.add_argument('--merge-web-meshes', action='store_true')
parser.add_argument('--source-label', default='Blendkit')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
if args.id not in ('indoor-plant','hertford-chair','meeting-table-u','grand-fir','reception-table','imac-computer','test-model-222') and not re.fullmatch(r'user-[a-f0-9]{32}', args.id):
    raise ValueError('Invalid model asset ID')
target = args.output or Path(__file__).resolve().parent / 'assets' / 'models' / args.id
target.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(args.source.resolve()), load_ui=False, use_scripts=False)
scene = bpy.context.scene
meshes = [o for o in scene.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError('No model meshes in the source')
shutil.copy2(args.source, target / 'source.blend')
root = next((o for o in scene.objects if o.get('asset_data')), None)
asset = root['asset_data'].to_dict() if root else {}
native = next((o['blenderkit'].to_dict() for o in scene.objects if 'blenderkit' in o), {})
points = [o.matrix_world @ Vector(v) for o in meshes for v in o.bound_box]
low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
source_faces = sum(len(o.data.polygons) for o in meshes)
notes = []


def available(image):
    return bool(image and (image.packed_file or image.has_data or
                           Path(bpy.path.abspath(image.filepath)).is_file()))


def upstream_image(socket):
    """Follow an existing shader branch to its image, preserving UV mapping."""
    pending = [link.from_node for link in socket.links]
    seen = set()
    while pending:
        node = pending.pop(0)
        if node in seen:
            continue
        seen.add(node)
        if node.type == 'TEX_IMAGE' and available(node.image):
            return node
        pending.extend(link.from_node for inp in node.inputs for link in inp.links)


used = {slot.material for o in meshes for slot in o.material_slots if slot.material}
missing = [i.name for i in bpy.data.images if not available(i) and (not args.id.startswith('user-') or i.source in ('FILE','TILED'))]
for material in used:
    if not material.use_nodes:
        continue
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shaders = [n for n in nodes if n.type == 'BSDF_PRINCIPLED']
    if not shaders:
        glass = next((n for n in nodes if n.type == 'BSDF_GLASS'), None)
        if not glass:
            if not args.id.startswith('user-'):
                raise RuntimeError(f'Unsupported shader: {material.name}')
            shader = nodes.new('ShaderNodeBsdfPrincipled')
            shader.inputs['Base Color'].default_value = material.diffuse_color
            notes.append(f'{material.name}: complex shader approximated for web preview; native shader preserved')
        else:
            shader = nodes.new('ShaderNodeBsdfPrincipled')
            shader.inputs['Base Color'].default_value = glass.inputs['Color'].default_value
            shader.inputs['Roughness'].default_value = glass.inputs['Roughness'].default_value
            shader.inputs['IOR'].default_value = glass.inputs['IOR'].default_value
            shader.inputs['Transmission Weight'].default_value = 1
            notes.append(f'{material.name}: Blender glass adapted to glTF transmission')
    else:
        shader = shaders[0]
    output = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
    foliage = 'leave' in material.name.lower() or 'needles' in material.name.lower()
    # glTF represents PBR + cutout alpha, rather than Blender's mixed leaf shaders.
    if foliage:
        image = upstream_image(shader.inputs['Base Color'])
        opacity = upstream_image(shader.inputs['Alpha'])
        if opacity:
            links.new(opacity.outputs['Alpha' if opacity == image else 'Color'], shader.inputs['Alpha'])
        elif image:
            links.new(image.outputs['Alpha'], shader.inputs['Alpha'])
        for link in list(shader.inputs['Roughness'].links):
            links.remove(link)
        shader.inputs['Roughness'].default_value = .72
        material.surface_render_method = 'DITHERED'
        material.use_backface_culling = False
        material['webFoliage'] = True
    # Unsupported colour corrections/mixed bark layers use their underlying image.
    base = shader.inputs['Base Color']
    if base.is_linked and base.links[0].from_node.type not in ('TEX_IMAGE', 'RGB'):
        image = upstream_image(base)
        if image:
            links.new(image.outputs['Color'], base)
            notes.append(f'{material.name}: base colour correction simplified for glTF')
    if output:
        emission = output.inputs['Surface'].links[0].from_node if output.inputs['Surface'].is_linked else None
        if emission and emission.type == 'EMISSION':
            colour = emission.inputs['Color']
            if colour.is_linked:
                links.new(colour.links[0].from_socket, shader.inputs['Emission Color'])
            else:
                shader.inputs['Emission Color'].default_value = colour.default_value
            shader.inputs['Emission Strength'].default_value = emission.inputs['Strength'].default_value
            notes.append(f'{material.name}: emissive screen preserved for glTF')
        links.new(shader.outputs['BSDF'], output.inputs['Surface'])
        for link in list(output.inputs['Displacement'].links):
            links.remove(link)
    for node in list(nodes):
        if node.type == 'TEX_IMAGE' and not available(node.image):
            nodes.remove(node)


def thin_leaf_islands(obj, density=.32):
    """Keep complete disconnected leaf cards, so their UV/cutout shapes survive."""
    data = obj.data
    parents = array('i', range(len(data.vertices)))

    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for edge in data.edges:
        a, b = map(find, edge.vertices)
        if a != b:
            parents[max(a, b)] = min(a, b)
    remove = bytearray(len(parents))
    for i in range(len(parents)):
        root = find(i)
        # Deterministic spatially scattered islands, never partial leaf cards.
        remove[i] = ((root * 2654435761) & 0xffffffff) / 2**32 >= density
    # Slightly enlarge surviving cards around their own centres to compensate
    # for reduced density at web-preview distances, without changing their UVs.
    centres = {}
    for vertex in data.vertices:
        if not remove[vertex.index]:
            root = find(vertex.index)
            total, count = centres.get(root, (Vector(), 0))
            centres[root] = (total + vertex.co, count + 1)
    centres = {root:total / count for root,(total,count) in centres.items()}
    for vertex in data.vertices:
        if not remove[vertex.index]:
            centre = centres[find(vertex.index)]
            vertex.co = centre + (vertex.co - centre) * 1.35
    bm = bmesh.new()
    bm.from_mesh(data)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if remove[v.index]], context='VERTS')
    bm.to_mesh(data)
    bm.free()
    data.update()


if args.id == 'grand-fir':
    # Separate foliage from solid wood/ground before reducing geometry.
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.separate(type='MATERIAL')
    bpy.ops.object.mode_set(mode='OBJECT')
    meshes = [o for o in scene.objects if o.type == 'MESH']
    for obj in meshes:
        materials = [s.material for s in obj.material_slots if s.material]
        if any('needles' in m.name.lower() for m in materials):
            thin_leaf_islands(obj)
        elif len(obj.data.polygons) > 20000:
            modifier = obj.modifiers.new('Web solid LOD', 'DECIMATE')
            modifier.ratio = .10
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    notes.append('Tree web LOD: keep 32% of complete needle islands at 1.35x card size; solid parts reduced to 10%. Native source unchanged.')

if args.max_web_polygons > 0 and source_faces > args.max_web_polygons:
    ratio = args.max_web_polygons / source_faces
    for obj in meshes:
        modifier = obj.modifiers.new('Web preview reduction', 'DECIMATE')
        modifier.ratio = ratio
        modifier.delimit = {'MATERIAL', 'UV', 'SEAM'}
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    notes.append(f'Web preview reduced to about {args.max_web_polygons} polygons; native source unchanged.')

if args.merge_web_meshes:
    # Flatten this static preview only. Keep world placement, UVs and materials
    # while reducing per-object overhead; the native hierarchy remains intact.
    bpy.context.view_layer.update()
    for obj in meshes:
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world
        obj.animation_data_clear()
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.convert(target='MESH')
    meshes = [o for o in bpy.context.selected_objects if o.type == 'MESH']
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    meshes = [bpy.context.view_layer.objects.active]
    meshes[0].data.validate(verbose=False, clean_customdata=False)
    meshes[0].data.update()
    meshes[0].name = args.name
    # Empties from the FBX hierarchy are irrelevant to a single static preview.
    for obj in list(scene.objects):
        if obj.type == 'EMPTY':
            bpy.data.objects.remove(obj, do_unlink=True)
    notes.append('Static web meshes joined by material; native source hierarchy unchanged.')

offset = Vector((-(low.x + high.x) / 2, -(low.y + high.y) / 2, -low.z))
for obj in scene.objects:
    if obj.parent is None:
        obj.matrix_world = Matrix.Translation(offset) @ obj.matrix_world
bpy.context.view_layer.update()
for image in bpy.data.images:
    if available(image):
        width, height = image.size
        if max(width, height) > args.max_texture:
            factor = args.max_texture / max(width, height)
            image.scale(max(1, round(width * factor)), max(1, round(height * factor)))
            image.pack()
bpy.ops.object.select_all(action='DESELECT')
for obj in scene.objects:
    obj.select_set(obj.type in ('MESH', 'EMPTY'))
bpy.ops.export_scene.gltf(filepath=str(target / 'model.glb'), export_format='GLB',
                          use_selection=True, export_apply=True, export_animations=False,
                          export_extras=False, export_cameras=False, export_lights=False,
                          export_image_format='AUTO')
# Leaf cards are opaque where the alpha mask passes; avoid transparent-surface
# sorting artifacts in Three.js, and preserve the same cutout in Blender.
glb_path = target / 'model.glb'
glb = glb_path.read_bytes()
json_size = struct.unpack_from('<I', glb, 12)[0]
document = json.loads(glb[20:20 + json_size])
for material in document.get('materials', []):
    if material.get('alphaMode') == 'BLEND' and any(k in material.get('name', '').lower() for k in ('leave', 'needles')):
        material.update(alphaMode='MASK', alphaCutoff=.1 if args.id == 'grand-fir' else .5, doubleSided=True)
encoded = json.dumps(document, separators=(',', ':')).encode('utf-8')
encoded += b' ' * (-len(encoded) % 4)
tail = glb[20 + json_size:]
glb_path.write_bytes(struct.pack('<III', 0x46546c67, 2, 20 + len(encoded) + len(tail)) +
                     struct.pack('<II', len(encoded), 0x4e4f534a) + encoded + tail)
if any('webFoliage' in m for m in used):
    notes.append('Foliage uses double-sided alpha cutouts; translucent/mixed Blender shaders simplified to PBR.')
size = high - low
manifest = dict(id=args.id, name=asset.get('name', args.name),
                author=asset.get('author', {}).get('fullName') or native.get('author'),
                license=asset.get('license') or native.get('license'),
                assetBaseId=asset.get('assetBaseId') or native.get('asset_base_id'),
                source=args.source_label, sourceFile=args.source.name,
                width=size.x, depth=size.y, height=size.z, meshes=len(meshes),
                sourcePolygons=source_faces, webPolygons=sum(len(o.data.polygons) for o in meshes),
                glbBytes=(target / 'model.glb').stat().st_size,
                missingSourceImages=missing, adaptations=notes,
                note='Native source kept intact for Cycles. GLB is a web preview with adapted PBR shaders and optional reduced geometry. Local project asset.')
(target / 'asset.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print('CADTOUR_ASSET:' + json.dumps(manifest))
