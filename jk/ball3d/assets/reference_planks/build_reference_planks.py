"""Create three editable pastel wooden planks from the supplied visual reference.
Run: blender -b --python-exit-code 1 -P build_reference_planks.py
The source image provides proportions only; dimensions are an artistic assumption.
"""
import bpy
import bmesh
import json
import math
from pathlib import Path
from mathutils import Vector

OUT = Path(__file__).resolve().parent
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version = 0
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
boards_collection = bpy.data.collections.new('01_Wooden_Planks')
studio_collection = bpy.data.collections.new('02_Preview_Studio')
scene.collection.children.link(boards_collection)
scene.collection.children.link(studio_collection)


def wood_material(name, base):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*base, 1)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (720, 100)
    shader = nodes.new('ShaderNodeBsdfPrincipled')
    shader.location = (460, 100)
    shader.inputs['Roughness'].default_value = .48
    shader.inputs['Specular IOR Level'].default_value = .3
    shader.inputs['Coat Weight'].default_value = .1
    shader.inputs['Coat Roughness'].default_value = .4
    links.new(shader.outputs['BSDF'], output.inputs['Surface'])
    coords = nodes.new('ShaderNodeTexCoord')
    coords.location = (-950, 0)
    stretch = nodes.new('ShaderNodeVectorMath')
    stretch.operation = 'MULTIPLY'
    stretch.inputs[1].default_value = (8, .7, 15)
    stretch.location = (-740, 40)
    links.new(coords.outputs['Object'], stretch.inputs[0])
    grain = nodes.new('ShaderNodeTexNoise')
    grain.location = (-520, 160)
    grain.inputs['Scale'].default_value = 3.5
    grain.inputs['Detail'].default_value = 3
    grain.inputs['Roughness'].default_value = .65
    links.new(stretch.outputs['Vector'], grain.inputs['Vector'])
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.label = 'Subtle painted wood grain'
    ramp.location = (-260, 220)
    ramp.color_ramp.elements[0].position = .2
    ramp.color_ramp.elements[0].color = (*(v * .74 for v in base), 1)
    ramp.color_ramp.elements[1].position = .78
    ramp.color_ramp.elements[1].color = (*(min(1, v * 1.08 + .02) for v in base), 1)
    links.new(grain.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], shader.inputs['Base Color'])
    fibres = nodes.new('ShaderNodeTexNoise')
    fibres.location = (-510, -160)
    fibres.inputs['Scale'].default_value = 16
    fibres.inputs['Detail'].default_value = 2
    links.new(stretch.outputs['Vector'], fibres.inputs['Vector'])
    bump = nodes.new('ShaderNodeBump')
    bump.location = (180, -80)
    bump.inputs['Strength'].default_value = .14
    bump.inputs['Distance'].default_value = .008
    links.new(fibres.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], shader.inputs['Normal'])
    return material


def create_plank(name, width, length, thick, location, seed, material):
    # Counterclockwise outline with worn clipped corners and gently uneven sides.
    outline = [(-.38, -.50), (.36, -.50), (.47, -.484), (.50, -.458),
               (.498, -.29), (.483, -.15), (.491, .035), (.478, .20),
               (.496, .365), (.481, .46), (.39, .493), (.22, .50),
               (-.33, .497), (-.47, .476), (-.50, .438), (-.492, .28),
               (-.475, .12), (-.492, -.04), (-.483, -.20), (-.50, -.38),
               (-.475, -.465)]
    outline = [(width * (x + .004 * math.sin(i * 2.3 + seed)), length * y)
               for i, (x, y) in enumerate(outline)]
    n = len(outline)
    vertices = [(x, y, z) for z in (-thick / 2, thick / 2) for x, y in outline]
    faces = [tuple(reversed(range(n))), tuple(range(n, n * 2))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    mesh = bpy.data.meshes.new(name + '_Mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    boards_collection.objects.link(obj)
    obj.location = location
    obj.data.materials.append(material)
    bevel = obj.modifiers.new('Soft worn edges', 'BEVEL')
    bevel.width = .028
    bevel.segments = 4
    bevel.limit_method = 'ANGLE'
    bevel.angle_limit = math.radians(20)
    bevel.harden_normals = True
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    normal = obj.modifiers.new('Weighted surface normals', 'WEIGHTED_NORMAL')
    normal.keep_sharp = True
    normal.weight = 50
    obj['description'] = 'Separate editable plank; length is local Y; up is local Z.'
    obj['nominal_dimensions_m'] = [width, length, thick]
    obj['reference_note'] = 'Dimensions inferred from image proportions; not measured.'
    bm = bmesh.new()
    bm.from_mesh(mesh)
    assert all(edge.is_manifold for edge in bm.edges), name + ' has an open edge'
    assert bm.calc_volume(signed=True) > 0, name + ' has inverted normals'
    bm.free()
    return obj


pink = wood_material('Painted_Wood_Rose', (.67, .255, .35))
pearl = wood_material('Painted_Wood_Ivory', (.79, .80, .67))
yellow = wood_material('Painted_Wood_Honey', (.92, .56, .16))
boards = [
    create_plank('Plank_01_Pink', .94, 4.55, .17, (-1.58, .64, 1.05), 1, pink),
    create_plank('Plank_02_Ivory', .92, 4.65, .17, (0, -.12, 1.02), 3, pearl),
    create_plank('Plank_03_Yellow', .89, 4.50, .17, (1.52, -.38, 1.0), 5, yellow),
]

floor_mat = bpy.data.materials.new('Dark_Warm_Reflective_Background')
floor_mat.use_nodes = True
floor_shader = next(n for n in floor_mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
floor_shader.inputs['Base Color'].default_value = (.042, .018, .023, 1)
floor_shader.inputs['Roughness'].default_value = .26
floor_shader.inputs['Metallic'].default_value = .24
floor_shader.inputs['Specular IOR Level'].default_value = .4
floor_mesh = bpy.data.meshes.new('Backdrop_Mesh')
floor_mesh.from_pydata([(-100, -100, 0), (100, -100, 0), (100, 100, 0), (-100, 100, 0)], [], [(0, 1, 2, 3)])
floor = bpy.data.objects.new('Backdrop', floor_mesh)
studio_collection.objects.link(floor)
floor.data.materials.append(floor_mat)


def aim(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def area(name, location, color, power, size, target):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy, data.color, data.shape, data.size = power, color, 'DISK', size
    obj = bpy.data.objects.new(name, data)
    studio_collection.objects.link(obj)
    obj.location = location
    aim(obj, target)


area('Large_Soft_Key', (-2, -1, 8), (1, .88, .80), 950, 7, (0, 0, 0))
area('Rose_Rim', (-4.5, 2, 3.2), (1, .19, .44), 420, 4, (-1, 0, .6))
area('Amber_Rim', (4, 3.5, 4.2), (1, .55, .18), 480, 3.5, (1.2, 0, .5))
area('Lavender_Fill', (0, -4.5, 3), (.54, .45, 1), 100, 4, (0, 0, 1))
world = bpy.data.worlds.new('Muted_Rose_Studio')
world.use_nodes = True
next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND').inputs['Color'].default_value = (.15, .11, .16, 1)
next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND').inputs['Strength'].default_value = .45
scene.world = world

camera_data = bpy.data.cameras.new('Reference_View')
camera = bpy.data.objects.new('Reference_View', camera_data)
studio_collection.objects.link(camera)
camera.location = (6.1, -8.6, 8.2)
aim(camera, (0, .13, .84))
camera_data.lens = 48
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.cycles.device = 'CPU'
scene.render.resolution_x = 1400
scene.render.resolution_y = 840
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = str(OUT / 'reference_planks_preview.png')
scene.view_settings.view_transform = 'AgX'
scene.view_settings.exposure = .45
scene.render.film_transparent = False
scene.render.image_settings.color_mode = 'RGB'
scene.use_nodes = True
nodes = scene.node_tree.nodes
nodes.clear()
render_layer = nodes.new('CompositorNodeRLayers')
glare = nodes.new('CompositorNodeGlare')
glare.glare_type = 'FOG_GLOW'
glare.quality = 'HIGH'
glare.threshold = 1.8
glare.mix = -.96
composite = nodes.new('CompositorNodeComposite')
scene.node_tree.links.new(render_layer.outputs['Image'], glare.inputs['Image'])
scene.node_tree.links.new(glare.outputs['Image'], composite.inputs['Image'])

bpy.context.view_layer.update()
for obj in boards:
    obj.select_set(True)
bpy.context.view_layer.objects.active = boards[1]
for screen in bpy.data.screens:
    for region in screen.areas:
        if region.type == 'VIEW_3D':
            region.spaces.active.region_3d.view_perspective = 'CAMERA'
            region.spaces.active.shading.type = 'MATERIAL'
readme = bpy.data.texts.new('README')
readme.write('Three pastel wooden planks modeled from the supplied reference.\n'
             '01_Wooden_Planks contains three separate editable watertight meshes.\n'
             '02_Preview_Studio contains only camera, lighting and backdrop.\n'
             'All wood textures are procedural and stored in this blend file.\n'
             'Metric scene; dimensions are artistic assumptions from visual proportions.\n'
             'Local Y follows the grain; local Z is up. Bevel modifiers stay editable.\n')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'reference_planks.blend'))
report = {'blender_version': bpy.app.version_string, 'boards': [
    {'name': o.name, 'dimensions_m': list(o.dimensions), 'vertices': len(o.data.vertices),
     'closed_manifold': True} for o in boards]}
(OUT / 'model_check.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
bpy.ops.render.render(write_still=True)
print('PLANK_BUILD_COMPLETE ' + str(OUT))

