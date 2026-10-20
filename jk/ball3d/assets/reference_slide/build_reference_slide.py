"""Build the gold twin-rail slide from the supplied reference image.
Run with Blender 4.5: blender -b --python-exit-code 1 -P build_reference_slide.py
Dimensions and the indistinct spherical fittings are visual approximations.
"""
import bpy
import bmesh
import bisect
import json
from pathlib import Path
from mathutils import Vector
from mathutils.geometry import interpolate_bezier

OUT = Path(__file__).resolve().parent
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version = 0
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'


def collection(name):
    result = bpy.data.collections.new(name)
    scene.collection.children.link(result)
    return result


rails = collection('01_Editable_Rails')
hangers = collection('02_Spherical_Fittings')
studio = collection('90_Render_Studio')


def move_to(obj, destination):
    for source in list(obj.users_collection):
        source.objects.unlink(obj)
    destination.objects.link(obj)


def principled_material(name, color, metallic, roughness):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Metallic'].default_value = metallic
    shader.inputs['Roughness'].default_value = roughness
    return mat


gold = principled_material('Warm_Polished_Brass', (.73, .51, .16), 1, .22)
ball_gold = principled_material('Polished_Gold_Spheres', (.79, .59, .22), 1, .16)
ground_mat = principled_material('Soft_Gray_Backdrop', (.19, .19, .185), 0, .85)

# The rail bends in the X/Z plane. The two copies are offset along Y.
# Eight Bezier control points keep the entire silhouette directly editable.
points = [Vector((x, 0, z)) for x, z in [
    (-3.55, 1.63), (-2.65, 1.76), (-1.50, 1.66), (-.25, 1.52),
    (.92, 1.61), (1.92, 2.03), (2.58, 2.77), (2.94, 3.78),
]]
rail_radius = .035
rail_spacing = .27
left_handles, right_handles = [], []
for i, point in enumerate(points):
    before = points[max(i - 1, 0)]
    after = points[min(i + 1, len(points) - 1)]
    tangent = (after - before).normalized()
    before_length = (point - before).length if i else (after - point).length
    after_length = (after - point).length if i < len(points) - 1 else before_length
    left_handles.append(point - tangent * before_length / 3)
    right_handles.append(point + tangent * after_length / 3)

rail_objects = []
for name, offset in [('Rail_Front', -rail_spacing / 2), ('Rail_Back', rail_spacing / 2)]:
    data = bpy.data.curves.new(name + '_Bezier', 'CURVE')
    data.dimensions = '3D'
    data.resolution_u = 40
    data.bevel_depth = rail_radius
    data.bevel_resolution = 5
    data.use_fill_caps = True
    spline = data.splines.new('BEZIER')
    spline.bezier_points.add(len(points) - 1)
    displacement = Vector((0, offset, 0))
    for i, bp in enumerate(spline.bezier_points):
        bp.co = points[i] + displacement
        bp.handle_left_type = 'FREE'
        bp.handle_right_type = 'FREE'
        bp.handle_left = left_handles[i] + displacement
        bp.handle_right = right_handles[i] + displacement
    obj = bpy.data.objects.new(name, data)
    rails.objects.link(obj)
    data.materials.append(gold)
    obj['description'] = 'Editable round brass rail; local X along track, Z up.'
    obj['tube_radius_m'] = rail_radius
    obj['rail_center_spacing_m'] = rail_spacing
    rail_objects.append(obj)

# Arc-length sampling places each fitting on the same Bezier path as the rails.
samples = []
for i in range(len(points) - 1):
    section = interpolate_bezier(points[i], right_handles[i], left_handles[i + 1], points[i + 1], 100)
    samples.extend(section if not samples else section[1:])
distances = [0.0]
for a, b in zip(samples, samples[1:]):
    distances.append(distances[-1] + (b - a).length)


def on_track(fraction):
    distance = fraction * distances[-1]
    index = min(max(bisect.bisect_left(distances, distance), 1), len(samples) - 1)
    a, b = samples[index - 1], samples[index]
    mix = (distance - distances[index - 1]) / (distances[index] - distances[index - 1])
    tangent = (b - a).normalized()
    up_normal = Vector((-tangent.z, 0, tangent.x))
    return a.lerp(b, mix), up_normal


def sphere(name, center, radius, destination):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=radius, location=center)
    obj = bpy.context.object
    obj.name = name
    move_to(obj, destination)
    obj.data.materials.append(ball_gold)
    for face in obj.data.polygons:
        face.use_smooth = True
    return obj


def tube_between(name, a, b, radius, destination):
    center = (a + b) / 2
    direction = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=radius, depth=direction.length, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = direction.to_track_quat('Z', 'Y').to_euler()
    move_to(obj, destination)
    obj.data.materials.append(gold)
    for face in obj.data.polygons:
        face.use_smooth = len(face.vertices) == 4
    bevel = obj.modifiers.new('Small edge rounding', 'BEVEL')
    bevel.width = .007
    bevel.segments = 3
    obj.modifiers.new('Weighted normals', 'WEIGHTED_NORMAL')
    return obj


# The indistinct lower pieces are represented as seven separate spherical fittings.
for i, fraction in enumerate([.075, .19, .305, .42, .535, .65, .755], 1):
    point, normal = on_track(fraction)
    saddle = point - normal * .045
    tube_between('Saddle_%02d' % i, saddle + Vector((0, -.145, 0)),
                 saddle + Vector((0, .145, 0)), .021, hangers)
    tube_between('Fitting_Neck_%02d' % i, saddle, point - normal * .115, .034, hangers)
    fitting = sphere('Lower_Gold_Fitting_%02d' % i, point - normal * .22, .14, hangers)
    fitting['reference_note'] = 'Spherical interpretation of the low-resolution fitting.'

bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, 0))
ground = bpy.context.object
ground.name = 'Gray_Backdrop'
move_to(ground, studio)
ground.data.materials.append(ground_mat)


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def area(name, location, energy, size, color, target, size_y=None):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy, data.size, data.color = energy, size, color
    data.shape = 'RECTANGLE'
    data.size_y = size_y if size_y is not None else size
    obj = bpy.data.objects.new(name, data)
    studio.objects.link(obj)
    obj.location = location
    aim(obj, target)


area('Wide_Upper_Softbox', (-2.5, -3.5, 7.5), 1100, 7, (1, .95, .85), (0, 0, 2), 3)
area('Back_Edge_Strip', (0, 3.5, 6.8), 1500, 7, (1, .92, .73), (0, 0, 2), 1.5)
area('Right_White_Softbox', (5, -1, 4.8), 500, 3, (.90, .94, 1), (1, 0, 2.4), 4)
area('Front_Reflection_Strip', (-1, -6, 2.4), 110, 6, (1, 1, 1), (0, 0, 2), .45)
world = bpy.data.worlds.new('Neutral_Studio')
world.use_nodes = True
background = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
background.inputs['Color'].default_value = (.32, .34, .38, 1)
background.inputs['Strength'].default_value = .45
scene.world = world

camera_data = bpy.data.cameras.new('Reference_View')
camera = bpy.data.objects.new('Reference_View', camera_data)
studio.objects.link(camera)
camera.location = (4.5, -14, 6.5)
aim(camera, (-.25, 0, 2.42))
camera_data.type = 'ORTHO'
camera_data.ortho_scale = 8.0
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 64
scene.cycles.use_denoising = True
scene.render.resolution_x = 1600
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.filepath = str(OUT / 'reference_slide_preview.png')
scene.view_settings.view_transform = 'AgX'
scene.view_settings.exposure = .1

# Validate the main asset geometry before saving it.
bpy.context.view_layer.update()
assert len(rails.objects) == 2
assert len([o for o in hangers.objects if o.name.startswith('Lower_Gold_Fitting')]) == 7
for obj in hangers.objects:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    assert all(e.is_manifold for e in bm.edges), obj.name
    assert bm.calc_volume(signed=True) > 0, obj.name
    bm.free()
bpy.ops.object.select_all(action='DESELECT')
for obj in rail_objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = rail_objects[0]
for screen in bpy.data.screens:
    for region in screen.areas:
        if region.type == 'VIEW_3D':
            region.spaces.active.region_3d.view_perspective = 'CAMERA'
            region.spaces.active.shading.type = 'MATERIAL'
notes = bpy.data.texts.new('README')
notes.write('Gold twin-rail slide modeled from the supplied reference image.\n'
            '01_Editable_Rails: two capped, round Bezier rails. Tab into Edit Mode to reshape.\n'
            '02_Spherical_Fittings: seven separate spherical fittings with small mounting ties.\n'
            '90_Render_Studio: preview-only camera, lights and gray backdrop.\n'
            'No external textures are required. Dimensions are visual approximations.\n'
            'The image does not establish whether the lower fittings are bells or spheres.\n'
            'This is a visual model; no rolling physics or animation is configured.\n')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'reference_slide.blend'))
report = {'blender_version': bpy.app.version_string, 'rails': 2, 'lower_fittings': 7,
          'example_balls': 0, 'rail_radius_m': rail_radius, 'rail_spacing_m': rail_spacing,
          'centerline_length_m': distances[-1], 'control_points': [list(p) for p in points]}
(OUT / 'model_check.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
bpy.ops.render.render(write_still=True)
print('SLIDE_BUILD_COMPLETE ' + str(OUT))


