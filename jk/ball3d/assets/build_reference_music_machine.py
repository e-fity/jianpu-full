"""Export the approved Blender reference models for the realtime music video.

Run: blender -b --python-exit-code 1 -P ball3d/assets/build_reference_music_machine.py
Reads the two reference .blend files without changing them. Produces a self-contained
reference_music_machine.glb plus an editable assembled .blend beside this script.
"""
from pathlib import Path
import json
import math

import bpy
import numpy as np
from mathutils import Vector
from mathutils.geometry import interpolate_bezier

HERE = Path(__file__).resolve().parent
PLANK_SOURCE = HERE / 'reference_planks' / 'reference_planks.blend'
SLIDE_SOURCE = HERE / 'reference_slide' / 'reference_slide.blend'
OUTPUT = HERE / 'reference_music_machine'
BOARD_SIZE = (.30, .50, .06)  # Blender X/Y/Z -> glTF X/Z/Y
FITTING_FRACTIONS = [.075, .19, .305, .42, .535, .65, .755]


def activate(objects):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def append_objects(path, names):
    with bpy.data.libraries.load(str(path), link=False) as (source, target):
        missing = set(names) - set(source.objects)
        if missing:
            raise RuntimeError('%s is missing %s' % (path, sorted(missing)))
        target.objects = names
    for obj in target.objects:
        bpy.context.scene.collection.objects.link(obj)
    return target.objects


def to_mesh(obj):
    activate([obj])
    bpy.ops.object.convert(target='MESH')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return bpy.context.object


def bake_board(board):
    # Bake the actual reference material's grain, neutralized for per-note tint.
    material = board.data.materials[0]
    for node in material.node_tree.nodes:
        if node.type == 'VALTORGB':
            for element, value in zip(node.color_ramp.elements, [.74, 1.0]):
                element.color = (value, value, value, 1)
    activate([board])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(island_margin=.025)
    bpy.ops.object.mode_set(mode='OBJECT')
    image = bpy.data.images.new('Reference_Plank_Wood', width=1024, height=1024, alpha=False)
    image.colorspace_settings.name = 'sRGB'
    texture = material.node_tree.nodes.new('ShaderNodeTexImage')
    texture.image = image
    material.node_tree.nodes.active = texture
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 1
    scene.cycles.device = 'CPU'
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=10)
    image.filepath_raw = str(HERE / 'reference_music_machine_wood.png')
    image.file_format = 'PNG'
    image.save()
    image.pack()
    exported = bpy.data.materials.new('Reference_Painted_Wood')
    exported.use_nodes = True
    nodes, links = exported.node_tree.nodes, exported.node_tree.links
    shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value = .48
    shader.inputs['Coat Weight'].default_value = .1
    shader.inputs['Coat Roughness'].default_value = .4
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = image
    links.new(tex.outputs['Color'], shader.inputs['Base Color'])
    board.data.materials.clear()
    board.data.materials.append(exported)


def normalize_board(board):
    coords = np.array([v.co[:] for v in board.data.vertices], dtype=np.float64)
    low, high = coords.min(axis=0), coords.max(axis=0)
    center = (low + high) / 2
    scale = np.array(BOARD_SIZE) / (high - low)
    for vertex, co in zip(board.data.vertices, (coords - center) * scale):
        vertex.co = co
    board.data.update()
    board.name = 'Board'
    board.data.name = 'Reference_Plank_Mesh'
    board['source_model'] = 'reference_planks/reference_planks.blend:Plank_02_Ivory'
    board['nominal_dimensions_gltf'] = [.30, .06, .50]


def source_path(rail):
    points = rail.data.splines[0].bezier_points
    samples = []
    for a, b in zip(points, points[1:]):
        section = interpolate_bezier(a.co, a.handle_right, b.handle_left, b.co, 101)
        samples.extend(section if not samples else section[1:])
    coords = np.array([(p.x, 0, p.z) for p in samples], dtype=np.float64)
    deltas = np.diff(coords, axis=0)
    lengths = np.linalg.norm(deltas, axis=1)
    distance = np.concatenate(([0.0], np.cumsum(lengths)))
    return coords, deltas, lengths, distance


def frame_at(fraction, path):
    points, deltas, lengths, distance = path
    arc = fraction * distance[-1]
    i = min(max(int(np.searchsorted(distance, arc)), 1), len(points) - 1) - 1
    mix = (arc - distance[i]) / lengths[i]
    p = points[i] + mix * deltas[i]
    tangent = deltas[i] / lengths[i]
    normal = np.array([-tangent[2], 0, tangent[0]])
    return p, tangent, normal


def add_path_coordinates(obj, path, fixed_fraction=None):
    points, deltas, lengths, distance = path
    length_squared = lengths * lengths
    values = {key: [] for key in ('_SLIDE_U', '_SLIDE_N', '_SLIDE_T', '_SLIDE_Z')}
    fixed = frame_at(fixed_fraction, path) if fixed_fraction is not None else None
    for vertex in obj.data.vertices:
        co = np.array(vertex.co[:], dtype=np.float64)
        if fixed is None:
            projections = np.clip(np.einsum('ij,ij->i', co - points[:-1], deltas) / length_squared, 0, 1)
            closest = points[:-1] + projections[:, None] * deltas
            residuals = co - closest
            i = int(np.argmin(np.einsum('ij,ij->i', residuals, residuals)))
            fraction = (distance[i] + projections[i] * lengths[i]) / distance[-1]
            origin, tangent, normal = frame_at(fraction, path)
        else:
            fraction = fixed_fraction
            origin, tangent, normal = fixed
        offset = co - origin
        values['_SLIDE_U'].append(float(fraction))
        values['_SLIDE_N'].append(float(np.dot(offset, normal)))
        values['_SLIDE_T'].append(float(np.dot(offset, tangent)))
        values['_SLIDE_Z'].append(float(-co[1]))  # Blender Y -> glTF -Z
    for name, data in values.items():
        attribute = obj.data.attributes.new(name=name, type='FLOAT', domain='POINT')
        attribute.data.foreach_set('value', data)


def join_objects(objects, name, material):
    for obj in objects:
        obj.data.materials.clear()
        obj.data.materials.append(material)
    activate(objects)
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = name
    obj.data.name = name + '_Reference_Mesh'
    obj['source_model'] = 'reference_slide/reference_slide.blend'
    obj['source_rail_radius'] = .035
    obj['source_rail_half_spacing'] = .135
    obj['path_coordinates'] = '_SLIDE_U,_SLIDE_N,_SLIDE_T,_SLIDE_Z'
    return obj


def build_board_mount(material):
    """A rear bracket and round wall foot, entirely behind the ball corridor.

    Blender +Y points into the wall. The board's rear edge is at +.25;
    the wall is at +.242, so the wood enters it by .008 metres.
    """
    curve = bpy.data.curves.new('Board_Bracket_Curve', 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = 12
    curve.bevel_depth = .009
    curve.bevel_resolution = 3
    curve.use_fill_caps = True
    spline = curve.splines.new('BEZIER')
    points = [(0, .205, -.024), (0, .210, -.16),
              (0, .220, -.34), (0, .234, -.50)]
    spline.bezier_points.add(len(points) - 1)
    for point, co in zip(spline.bezier_points, points):
        point.co = co
        point.handle_left_type = point.handle_right_type = 'AUTO'
    bracket = bpy.data.objects.new('Board_Bracket', curve)
    bpy.context.scene.collection.objects.link(bracket)
    bracket = to_mesh(bracket)
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=.045, depth=.016,
        location=(0, .235, -.50), rotation=(math.pi / 2, 0, 0))
    foot = to_mesh(bpy.context.object)
    for obj in (bracket, foot):
        obj.data.materials.append(material)
        for face in obj.data.polygons:
            face.use_smooth = True
    activate([bracket, foot])
    bpy.ops.object.join()
    mount = bpy.context.object
    mount.name = 'BoardMount'
    mount.data.name = 'Wall_Bracket_And_Foot'
    mount['wall_depth_gltf'] = -.242
    return mount


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    board = append_objects(PLANK_SOURCE, ['Plank_02_Ivory'])[0]
    board.location = (0, 0, 0)
    board = to_mesh(board)
    bake_board(board)
    normalize_board(board)
    names = ['Rail_Front', 'Rail_Back'] + [
        '%s_%02d' % (prefix, i) for i in range(1, 8)
        for prefix in ['Saddle', 'Fitting_Neck', 'Lower_Gold_Fitting']]
    source = append_objects(SLIDE_SOURCE, names)
    path = source_path(source[0])
    brass = source[0].data.materials[0]
    rail_meshes = []
    fitting_meshes = []
    for obj in source:
        is_rail = obj.name.startswith('Rail_')
        fraction = None if is_rail else FITTING_FRACTIONS[int(obj.name.rsplit('_', 1)[-1]) - 1]
        obj = to_mesh(obj)
        add_path_coordinates(obj, path, fraction)
        (rail_meshes if is_rail else fitting_meshes).append(obj)
    rail_mesh = join_objects(rail_meshes, 'SlideRails', brass)
    fittings = join_objects(fitting_meshes, 'SlideFittings', brass)
    mount = build_board_mount(brass)
    objects = [board, mount, rail_mesh, fittings]
    assert not any(o.name.startswith('Example_Rolling_Ball') for o in bpy.data.objects)
    for obj in [rail_mesh, fittings]:
        assert all(name in obj.data.attributes for name in ('_SLIDE_U', '_SLIDE_N', '_SLIDE_T', '_SLIDE_Z'))
    bpy.context.view_layer.update()
    activate(objects)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT.with_suffix('.blend')))
    bpy.ops.export_scene.gltf(filepath=str(OUTPUT.with_suffix('.glb')), export_format='GLB',
        use_selection=True, export_apply=True, export_yup=True, export_attributes=True,
        export_extras=True, export_animations=False, export_cameras=False, export_lights=False)
    report = {'source_plank': str(PLANK_SOURCE), 'source_slide': str(SLIDE_SOURCE),
              'board_dimensions_gltf': [.30, .06, .50], 'wall_z': -.242,
              'wall_embed': .008, 'example_balls': 0,
              'objects': {o.name: {'vertices': len(o.data.vertices), 'polygons': len(o.data.polygons)} for o in objects}}
    OUTPUT.with_suffix('.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('REFERENCE_ASSET_READY ' + str(OUTPUT.with_suffix('.glb')))


if __name__ == '__main__':
    build()
