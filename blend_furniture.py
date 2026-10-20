"""Append native furniture into an isolated render scene, preserving shaders.

Only asset geometry/hierarchy is appended; the CAD camera, world and lights
continue to belong to CADtour. The masters on disk are never modified.
"""
from pathlib import Path
import bpy
from mathutils import Matrix, Vector
from native_assets import NATIVE_ASSETS, source_path


def linear_channel(value):
    return value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4


def tint_material(material, colour, mode):
    """Keep the original texture graph; tint only its base-colour inputs."""
    if mode == 'multiply' and colour.lower() == '#ffffff':
        return material
    material = material.copy()
    rgb = tuple(linear_channel(int(colour[i:i + 2], 16) / 255) for i in (1, 3, 5)) + (1,)
    material['CADtour_tint'] = colour
    if not material.use_nodes:
        material.diffuse_color = rgb if mode == 'set' else tuple(a * b for a, b in zip(material.diffuse_color, rgb))
        return material
    nodes, links = material.node_tree.nodes, material.node_tree.links
    for shader in [n for n in nodes if n.type == 'BSDF_PRINCIPLED']:
        base = shader.inputs['Base Color']
        if mode == 'set':
            for link in list(base.links):
                links.remove(link)
            base.default_value = rgb
        elif base.is_linked:
            original = base.links[0].from_socket
            mix = nodes.new('ShaderNodeMixRGB')
            mix.name = 'CADtour instance colour'
            mix.blend_type = 'MULTIPLY'
            mix.inputs[0].default_value = 1
            mix.inputs[2].default_value = rgb
            links.new(original, mix.inputs[1])
            links.new(mix.outputs[0], base)
        else:
            base.default_value = tuple(a * b for a, b in zip(base.default_value, rgb))
    return material


def append_furniture(scene, instances, basis):
    report = dict(instances=[], warnings=[], removed_web_meshes=0)
    templates = {}
    missing_images = set()

    def load_template(asset_type):
        path = source_path(asset_type)
        if not path.is_file():
            raise RuntimeError('Native Blender asset is missing: ' + str(path))
        # Registered masters have one upload scene. Do not guess if a later
        # master contains multiple scenes; it needs an explicit asset export.
        with bpy.data.libraries.load(str(path), link=False) as (available, loaded):
            if len(available.scenes) != 1:
                raise RuntimeError('Native asset must contain one scene: ' + str(path))
            loaded.scenes = available.scenes
        source_scene = loaded.scenes[0]
        source_scene.view_layers[0].update()
        objects = [o for o in source_scene.objects if o.type in ('MESH', 'EMPTY')]
        if not any(o.type == 'MESH' for o in objects):
            raise RuntimeError('Native asset contains no mesh: ' + str(path))
        # The originals are kept off the render scene, as a reusable template.
        # Capture names before instance copies receive Blender suffixes.
        materials = {slot.material for o in objects if o.type == 'MESH' for slot in o.material_slots if slot.material}
        for material in materials:
            material['CADtour_native_material'] = True
            material['CADtour_source_material'] = material.name
        trees = set()
        def check_tree(tree):
            if tree is None or tree in trees:
                return
            trees.add(tree)
            for node in tree.nodes:
                if node.type == 'GROUP':
                    check_tree(node.node_tree)
                if node.type != 'TEX_IMAGE' or not node.image:
                    continue
                image = node.image
                if image.packed_file or image.has_data:
                    continue
                resolved = Path(bpy.path.abspath(image.filepath, start=str(path.parent)))
                if resolved.is_file():
                    image.filepath = str(resolved)
                    image.reload()
                    continue
                # Preserve the shader branch and alpha rather than rendering
                # a magenta missing texture. A missing bitmap cannot be restored.
                name = image.name
                missing_images.add(image)
                fallback = bpy.data.images.get('CADtour missing ' + name)
                if fallback is None:
                    fallback = bpy.data.images.new('CADtour missing ' + name, width=1, height=1)
                    fallback.generated_color = (.015, .025, .045, 1) if 'BM900' in name else (.8, .8, .8, 1)
                    fallback.pack()
                    report['warnings'].append(dict(type=asset_type, image=name,
                        message='原始 blend 缺少贴图 ' + name + '，该贴图暂用纯色代替。'))
                node.image = fallback
        for material in materials:
            if material.use_nodes:
                check_tree(material.node_tree)
        points = [o.matrix_world @ Vector(v) for o in objects if o.type == 'MESH' for v in o.bound_box]
        low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
        high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
        size = high - low
        if min(size) <= .000001:
            raise RuntimeError('Native asset has invalid dimensions: ' + str(path))
        return source_scene, objects, low, high

    for instance in instances:
        asset_type, fid = instance['type'], instance['id']
        if asset_type not in templates:
            templates[asset_type] = load_template(asset_type)
        source_scene, originals, low, high = templates[asset_type]
        size = high - low
        target = instance['size']  # Three.js X/Y/Z dimensions in metres.
        matrix = instance['matrix']
        world = Matrix([[matrix[col * 4 + row] for col in range(4)] for row in range(4)])
        offset = Matrix.Translation(Vector((-(low.x + high.x) / 2, -(low.y + high.y) / 2, -low.z)))
        scale = Matrix.Diagonal(Vector((target[0] / size.x, target[2] / size.y, target[1] / size.z, 1)))
        parent = bpy.data.objects.new('Native_' + fid, None)
        scene.collection.objects.link(parent)
        parent.matrix_world = basis @ world @ basis.inverted() @ scale @ offset
        parent['CADtour_native_asset'] = asset_type
        parent['furnitureId'] = fid
        parent['CADtour_target_size'] = target
        copies = {o: o.copy() for o in originals}
        instance_materials = {}
        config = NATIVE_ASSETS[asset_type]
        for original, obj in copies.items():
            scene.collection.objects.link(obj)
            obj['CADtour_native_asset'] = asset_type
            obj['furnitureId'] = fid
            obj['furnitureType'] = asset_type
            obj['renderRole'] = 'native-furniture'
            # Remap parents while keeping their local transforms and modifiers.
            if original.parent in copies:
                obj.parent = copies[original.parent]
                obj.matrix_parent_inverse = original.matrix_parent_inverse.copy()
                obj.matrix_basis = original.matrix_basis.copy()
            else:
                obj.parent = parent
                obj.matrix_parent_inverse = Matrix.Identity(4)
                obj.matrix_basis = original.matrix_world.copy()
            # Remap object dependencies in modifiers and constraints as well.
            for owner in [*obj.modifiers, *obj.constraints]:
                for prop in owner.bl_rna.properties:
                    if prop.type == 'POINTER' and not prop.is_readonly:
                        value = getattr(owner, prop.identifier, None)
                        if isinstance(value, bpy.types.Object) and value in copies:
                            setattr(owner, prop.identifier, copies[value])
            if obj.type != 'MESH':
                continue
            for slot in obj.material_slots:
                material = slot.material
                if not material:
                    continue
                # Object-linked slots allow geometry sharing across differently
                # coloured instances without modifying their neighbours.
                slot.link = 'OBJECT'
                if material not in instance_materials:
                    original_name = material['CADtour_source_material']
                    selected = original_name in config['colours'] or '*' in config['colours']
                    instance_materials[material] = tint_material(material, instance['colour'], config['mode']) if selected and not instance.get('preserveMaterials', False) else material
                slot.material = instance_materials[material]
        scene.view_layers[0].update()
        mesh_copies = [o for o in copies.values() if o.type == 'MESH']
        report['instances'].append(dict(id=fid, type=asset_type, source=str(source_path(asset_type).relative_to(Path(__file__).resolve().parent)),
            meshes=len(mesh_copies), polygons=sum(len(o.data.polygons) for o in mesh_copies),
            matrix=matrix, target_size=target, colour=instance['colour']))
    # Remove the web stand-ins only after every native instance loaded correctly.
    requested = {i['id'] for i in instances}
    for obj in list(scene.objects):
        if obj.type == 'MESH' and obj.get('furnitureId') in requested and not obj.get('CADtour_native_asset'):
            bpy.data.objects.remove(obj, do_unlink=True)
            report['removed_web_meshes'] += 1
    # Unlink source scenes and their template objects; only instance copies
    # remain in the saved render scene. Shared mesh/material data stays alive.
    for source_scene, originals, _, _ in templates.values():
        bpy.data.scenes.remove(source_scene)
        for obj in originals:
            bpy.data.objects.remove(obj, do_unlink=True)
    for image in missing_images:
        image.use_fake_user = False
        if image.users == 0:
            bpy.data.images.remove(image)
    return report
