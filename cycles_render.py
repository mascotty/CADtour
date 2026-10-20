"""Import the captured Three.js scene and render its exact camera in Cycles."""
import argparse
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Matrix, Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
from blend_furniture import append_furniture
from wall_materials import apply_wall_finish, prepare_wall_uvs


def stage(message):
    print('CADTOUR_STAGE:' + message, flush=True)


def enum_set(owner, field, value):
    try:
        setattr(owner, field, value)
    except TypeError as error:
        raise RuntimeError(str(error)) from error


parser = argparse.ArgumentParser()
parser.add_argument('--job', type=Path, required=True)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
directory = args.job.resolve()
meta = json.loads((directory / 'metadata.json').read_text())
scene = bpy.context.scene
scene.name = 'CADtour_Render'
stage('Importing CAD geometry and materials')
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(directory / 'scene.glb'))

# glTF imports Y-up into Z-up. Apply the same basis to the captured camera.
basis = Matrix.Rotation(math.pi / 2, 4, 'X')
stage('Loading native Blender furniture')
native_furniture = append_furniture(scene, meta.get('nativeFurniture', []), basis)
matrix = meta['camera']['matrix']
camera = next((o for o in scene.objects if o.type == 'CAMERA'), None)
if camera is None:
    camera = bpy.data.objects.new('CADtour_Camera', bpy.data.cameras.new('CADtour_Camera'))
    scene.collection.objects.link(camera)
camera.matrix_world = basis @ Matrix([[matrix[col * 4 + row] for col in range(4)] for row in range(4)])
enum_set(camera.data, 'sensor_fit', 'VERTICAL')
camera.data.sensor_height = 24
camera.data.lens = 12 / math.tan(math.radians(meta['camera']['fov']) / 2)
camera.data.clip_start = .05
camera.data.clip_end = 500
scene.camera = camera
scene.render.resolution_x = meta['width']
scene.render.resolution_y = meta['height']
scene.render.resolution_percentage = 100
scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1

stage('Preparing physical materials')
geometry_details = 0
glass_seen = set()
duplicate_glass = 0
for obj in list(scene.objects):
    if obj.type != 'MESH':
        continue
    prepare_wall_uvs(obj)
    role = obj.get('renderRole') or obj.name.split('_', 1)[0]
    if role == 'glass':
        key = tuple(sorted(tuple(round(v, 5) for v in obj.matrix_world @ vertex.co) for vertex in obj.data.vertices))
        if key in glass_seen:
            bpy.data.objects.remove(obj, do_unlink=True)
            duplicate_glass += 1
            continue
        glass_seen.add(key)
    if role not in ('wall', 'frame', 'sill', 'seal', 'skirting', 'door', 'door-hardware') or (role == 'wall' and len(obj.data.vertices) > 100):
        continue
    # glTF splits vertices at normal/UV seams. Weld those seams before beveling.
    weld = obj.modifiers.new('CADtour welded corners', 'WELD')
    weld.merge_threshold = .000001
    bevel = obj.modifiers.new('CADtour small edge highlights', 'BEVEL')
    bevel.width = .002 if role == 'wall' else .0008 if role == 'frame' else .0005
    bevel.segments = 3
    bevel.limit_method = 'ANGLE'
    bevel.use_clamp_overlap = True
    bevel.harden_normals = True
    normal = obj.modifiers.new('CADtour flat surfaces', 'WEIGHTED_NORMAL')
    normal.keep_sharp = True
    geometry_details += 1

wall_finishes = 0
for material in bpy.data.materials:
    if material.get('CADtour_native_material'):
        continue
    if not material.use_nodes:
        continue
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if principled is None:
        continue
    role = material.get('renderRole') or material.name.split('_', 1)[0]
    if role == 'wall' and apply_wall_finish(material, principled):
        wall_finishes += 1
    if role == 'glass':
        principled.inputs['Alpha'].default_value = 1
        principled.inputs['Transmission Weight'].default_value = 1
        principled.inputs['IOR'].default_value = 1.5
        principled.inputs['Roughness'].default_value = .008
        # A transparent pane needs only a weak surface tint; the selected colour
        # also colours absorption through its actual thickness, especially edges.
        tint = tuple(principled.inputs['Base Color'].default_value)
        principled.inputs['Base Color'].default_value = tuple(1 - .12 * (1 - c) for c in tint[:3]) + (1,)
        absorption = nodes.new('ShaderNodeVolumeAbsorption')
        absorption.inputs['Color'].default_value = tint
        absorption.inputs['Density'].default_value = 2
        output = next(n for n in nodes if n.type == 'OUTPUT_MATERIAL')
        links.new(absorption.outputs['Volume'], output.inputs['Volume'])
    elif role in ('wall', 'ceiling', 'sill'):
        principled.inputs['Roughness'].default_value = .8 if role == 'wall' else .85 if role == 'ceiling' else .38
    elif role == 'frame':
        principled.inputs['Metallic'].default_value = .65
        principled.inputs['Roughness'].default_value = .3
    elif role == 'seal':
        principled.inputs['Metallic'].default_value = 0
        principled.inputs['Roughness'].default_value = .8
    elif role == 'ceiling-light':
        principled.inputs['Emission Strength'].default_value = 3
    if role in ('floor', 'wall', 'ceiling', 'sill') and not principled.inputs['Normal'].is_linked:
        coordinates = nodes.new('ShaderNodeNewGeometry')
        texture = nodes.new('ShaderNodeTexNoise')
        # World positions keep the finish consistent across differently sized walls.
        links.new(coordinates.outputs['Position'], texture.inputs['Vector'])
        texture.inputs['Scale'].default_value = 160 if role == 'floor' else 120
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = .12
        bump.inputs['Distance'].default_value = .0007 if role == 'floor' else .00018 if role == 'wall' else .00008
        links.new(texture.outputs['Fac'], bump.inputs['Height'])
        links.new(bump.outputs['Normal'], principled.inputs['Normal'])
        if role == 'wall':
            finish = nodes.new('ShaderNodeMapRange')
            finish.inputs['To Min'].default_value = .74
            finish.inputs['To Max'].default_value = .86
            links.new(texture.outputs['Fac'], finish.inputs['Value'])
            links.new(finish.outputs[0], principled.inputs['Roughness'])
    # Preserve the web renderer's one-sided surfaces, including ceilings and leaves.
    if material.use_backface_culling:
        output = next(n for n in nodes if n.type == 'OUTPUT_MATERIAL')
        original = output.inputs['Surface'].links[0].from_socket if output.inputs['Surface'].is_linked else principled.outputs['BSDF']
        geometry = nodes.new('ShaderNodeNewGeometry')
        transparent = nodes.new('ShaderNodeBsdfTransparent')
        mix = nodes.new('ShaderNodeMixShader')
        links.new(geometry.outputs['Backfacing'], mix.inputs[0])
        links.new(original, mix.inputs[1])
        links.new(transparent.outputs[0], mix.inputs[2])
        links.new(mix.outputs[0], output.inputs['Surface'])

stage('Setting daylight and room lighting')
t = (meta['hour'] - 6) / 12
azimuth = math.pi * (.15 + t * .7)
elevation = math.sin(math.pi * t) * 1.05 + .15
sun_position = basis @ Vector((math.cos(azimuth) * 18, math.sin(elevation) * 20 + 3, -math.sin(azimuth) * 10 + 8))
world = bpy.data.worlds.new('CADtour_World')
world.use_nodes = True
scene.world = world
background = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
if not meta['night']:
    sky = world.node_tree.nodes.new('ShaderNodeTexSky')
    sky_types = {e.identifier for e in sky.bl_rna.properties['sky_type'].enum_items}
    # Blender 5.2 renames Nishita to Multiple Scattering.
    sky.sky_type = 'MULTIPLE_SCATTERING' if 'MULTIPLE_SCATTERING' in sky_types else 'NISHITA'
    direction = sun_position.normalized()
    sky.sun_elevation = max(.02, math.asin(direction.z))
    sky.sun_rotation = math.atan2(direction.y, direction.x)
    sky.sun_disc = False  # The matching SUN light supplies direct sunlight once.
    sky.aerosol_density = .7
    world.node_tree.links.new(sky.outputs['Color'], background.inputs['Color'])
    background.inputs['Strength'].default_value = .2
else:
    background.inputs['Color'].default_value = (.035, .05, .09, 1)
    background.inputs['Strength'].default_value = .12


def light(name, kind, position, energy, size=1):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    data.color = (1, .92, .80)
    if kind == 'AREA':
        data.size = size
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = position
    return obj


room_lights = meta.get('lights', meta['rooms'])
for index, room in enumerate(room_lights):
    center = basis @ Vector(room['center'])
    area = max(2, min(room['area'], 100))
    lamp = light('Room_light_' + str(index), 'AREA', center,
                 area * (9 if meta['night'] else 6), room.get('size', min(1.8, max(.35, math.sqrt(area) * .22))))
    # Blender area lights point along local -Z, i.e. down into the room.
    lamp.rotation_euler = (0, 0, 0)

sun = light('CADtour_Sun', 'SUN', sun_position, 0 if meta['night'] else 2)
sun.rotation_euler = (-sun_position).to_track_quat('-Z', 'Y').to_euler()
sun.data.angle = math.radians(.8)

enum_set(scene.render, 'engine', 'CYCLES')
scene.cycles.samples = 128 if meta['quality'] == 'fine' else 64
scene.cycles.use_adaptive_sampling = True
scene.cycles.adaptive_threshold = .02 if meta['quality'] == 'fine' else .04
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 10
scene.cycles.transmission_bounces = 8
scene.cycles.transparent_max_bounces = 12
scene.cycles.sample_clamp_indirect = 10
device = 'CPU'
preferences = bpy.context.preferences.addons['cycles'].preferences
backends = ('METAL',) if sys.platform == 'darwin' else ('OPTIX', 'CUDA', 'HIP', 'ONEAPI')
for backend in backends:
    try:
        preferences.compute_device_type = backend
        preferences.get_devices()
        if not any(d.type == backend for d in preferences.devices):
            continue
        # Legacy NVIDIA cards use CUDA; prefer OptiX for RTX hardware.
        if backend == 'OPTIX' and not any(d.type == backend and 'RTX' in d.name.upper()
                                          for d in preferences.devices):
            continue
        for d in preferences.devices:
            d.use = d.type == backend
        enum_set(scene.cycles, 'device', 'GPU')
        device = ('Metal' if backend == 'METAL' else backend) + ' GPU'
        break
    except (TypeError, RuntimeError) as error:
        print(backend + ' unavailable:', error, flush=True)
if device == 'CPU':
    enum_set(scene.cycles, 'device', 'CPU')
enum_set(scene.view_settings, 'view_transform', 'AgX')
enum_set(scene.view_settings, 'look', 'AgX - Medium High Contrast')
scene.view_settings.exposure = math.log2(meta['exposure'])
enum_set(scene.render.image_settings, 'file_format', 'PNG')
enum_set(scene.render.image_settings, 'color_mode', 'RGB')
scene.render.filepath = str(directory / 'result.png')
scene.render.film_transparent = False
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1
scene['CADtour_camera_matrix'] = matrix
scene['CADtour_source'] = str(meta.get('sourceName', 'CADtour'))
mesh_count = sum(o.type == 'MESH' for o in scene.objects)
summary = dict(engine=scene.render.engine, device=device, meshes=mesh_count,
               width=meta['width'], height=meta['height'], samples=scene.cycles.samples,
               camera_matrix=list(camera.matrix_world), source=meta.get('sourceName'),
               architectural_bevels=geometry_details, duplicate_glass_removed=duplicate_glass,
               room_lights=len(room_lights), environment='night' if meta['night'] else 'physical_sky')
summary['camera_matrix'] = [list(row) for row in camera.matrix_world]
summary['native_furniture'] = native_furniture
summary['pbr_wall_materials'] = wall_finishes
(directory / 'summary.json').write_text(json.dumps(summary))
stage('Packing textures and saving Blender scene')
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(directory / 'scene.blend'))
stage('Cycles path tracing on ' + device)
try:
    bpy.ops.render.render(write_still=True)
except RuntimeError:
    if device == 'CPU':
        raise
    enum_set(scene.cycles, 'device', 'CPU')
    summary['device'] = 'CPU fallback'
    (directory / 'summary.json').write_text(json.dumps(summary))
    stage('Cycles path tracing on CPU fallback')
    bpy.ops.render.render(write_still=True)
stage('Complete')
