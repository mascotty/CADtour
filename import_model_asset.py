"""Blender worker: normalize one static model, pack textures, prepare web preview."""
import argparse
import json
import math
from pathlib import Path
import runpy
import sys

import bpy
from mathutils import Matrix, Vector

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--id', required=True)
parser.add_argument('--name', required=True)
parser.add_argument('--yaw', type=int, default=0)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])


def run():
    source, target = args.source.resolve(), args.output.resolve()
    target.mkdir(parents=True, exist_ok=True)
    suffix = source.suffix.lower()
    warnings = []
    if suffix == '.blend':
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
        factor = bpy.context.scene.unit_settings.scale_length if bpy.context.scene.unit_settings.system != 'NONE' else 1
    else:
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        if suffix == '.fbx':
            bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=True, use_anim=False)
            warnings.append('FBX 中的 V-Ray／Corona 等复杂材质可能无法完整转换，请核对预览。')
        elif suffix == '.glb':
            bpy.ops.import_scene.gltf(filepath=str(source))
        else:
            raise ValueError('只支持 BLEND、FBX 或 GLB 模型。')
        factor = 1
    original = bpy.context.scene
    meshes = [o for o in original.objects if o.type == 'MESH']
    if not meshes:
        raise ValueError('文件中没有网格模型，请先在 Blender 中把曲线等对象转换为网格。')
    images = {}
    for file in source.parent.parent.rglob('*'):
        if file.is_file() and file.suffix.lower() in {'.png','.jpg','.jpeg','.tga','.tif','.tiff','.bmp','.webp','.exr','.hdr'}:
            images.setdefault(file.name.casefold(), []).append(file)
    for image in list(bpy.data.images):
        if image.source not in ('FILE','TILED') or image.packed_file:
            continue
        if image.source == 'TILED':
            raise ValueError('暂不支持 UDIM 多块贴图，请先烘焙成普通贴图。')
        resolved = Path(bpy.path.abspath(image.filepath))
        if not resolved.is_file():
            filename = image.filepath.replace('\\','/').split('/')[-1].casefold()
            candidates = images.get(filename, [])
            if len(candidates) == 1:
                resolved = candidates[0]
            else:
                warnings.append('缺少或无法唯一匹配贴图：' + image.name + '，已用中性底色代替。')
                image.source = 'GENERATED'
                image.generated_width = image.generated_height = 1
                image.generated_color = (.8,.8,.8,1)
                image.pack()
                continue
        image.filepath = str(resolved)
        image.reload()
        image.pack()
    # Bake the evaluated static appearance, including current modifier/rig pose.
    # No original camera, lights, rig or hidden scenes enter the furniture master.
    clean = bpy.data.scenes.new('CADtour asset')
    for obj in meshes:
        for modifier in obj.modifiers:
            modifier.show_viewport = modifier.show_render
            if modifier.type == 'SUBSURF':
                modifier.levels = modifier.render_levels
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    transform = Matrix.Rotation(math.radians(args.yaw), 4, 'Z') @ Matrix.Scale(factor, 4)
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        data = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
        instance = bpy.data.objects.new(obj.name, data)
        clean.collection.objects.link(instance)
        instance.matrix_world = transform @ evaluated.matrix_world
        for index, slot in enumerate(obj.material_slots):
            if index < len(data.materials):
                data.materials[index] = slot.material
    bpy.context.window.scene = clean
    if not any(len(obj.data.polygons) for obj in clean.objects):
        raise ValueError('没有可转换的有效网格，请先在 Blender 中实化实例或转换为网格。')
    for scene in list(bpy.data.scenes):
        if scene != clean:
            bpy.data.scenes.remove(scene)
    bpy.context.view_layer.update()
    bpy.ops.file.pack_all()
    normalized = target.parent / 'normalized.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(normalized))
    sys.argv = ['prepare_model_asset.py','--','--source',str(normalized),'--output',str(target),
                '--id',args.id,'--name',args.name,'--max-texture','1024','--max-web-polygons','50000',
                '--merge-web-meshes','--source-label','网页导入']
    runpy.run_path(str(Path(__file__).with_name('prepare_model_asset.py')), run_name='__main__')
    manifest_path = target / 'asset.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    warnings.extend(note for note in manifest['adaptations'] if 'complex shader' in note)
    if manifest['webPolygons'] > 100000:
        warnings.append('网页预览仍超过 10 万面，大量摆放可能影响流畅度。')
    if max(manifest[k] for k in ('width','height','depth')) > 10:
        warnings.append('模型尺寸超过 10 米，请核对单位，并在入库前校正宽度。')
    manifest.update(warnings=warnings, sourceFile=source.name, staticSnapshot=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    # A thumbnail is a separate, small render of the simplified preview.
    scene = bpy.context.scene
    points = [o.matrix_world @ Vector(v) for o in scene.objects if o.type == 'MESH' for v in o.bound_box]
    low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    center, radius = (low+high)/2, max((high-low).length/2, .01)
    camera = bpy.data.objects.new('Thumbnail camera', bpy.data.cameras.new('Thumbnail camera'))
    scene.collection.objects.link(camera)
    camera.location = center + Vector((1,-1,.7)).normalized()*radius*3.4
    camera.rotation_euler = (center-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = radius*2.5
    camera.data.clip_end = radius*20+100
    scene.camera = camera
    for at, energy in [((2,-3,4),900),((-3,-1,2),500)]:
        data = bpy.data.lights.new('Thumbnail area','AREA')
        lamp = bpy.data.objects.new('Thumbnail area',data)
        scene.collection.objects.link(lamp)
        lamp.location = center+Vector(at)*radius
        lamp.rotation_euler = (center-lamp.location).to_track_quat('-Z','Y').to_euler()
        data.energy, data.shape, data.size = energy*radius*radius, 'DISK', radius*3
    scene.world = bpy.data.worlds.new('Thumbnail world')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.5,.5,.5,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = .5
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 8
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 256
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = str(target/'preview.png')
    bpy.ops.render.render(write_still=True)


try:
    run()
except Exception as error:
    print('CADTOUR_IMPORT_ERROR:' + str(error), flush=True)
    raise
