"""Build the reusable "music machine" paddle asset for ball3d.

Run headless with Blender 4.5 (see the project README):

    D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe -b -P \
        ball3d/assets/build_music_machine.py -- --preset compact

``--preset compact`` is the 0.30 m paddle the realtime renderer loads today: its
constants are the ones in ``realtime/src/layout.mjs`` (``BOARD_W``/``BOARD_H``/
``BOARD_D``/``BALL_R``), and the renderer measures the loaded mesh at run time, so
a classic 0.60 m GLB stops the export instead of rendering wide planks with
narrow-planck clearances.  ``--preset classic`` (the default *here*, for
backwards compatibility) still writes ``music_machine.glb`` for comparison.

It writes, next to this script:

    music_machine.blend   the editable Blender file
    music_machine.glb     the classic 0.60 m asset (kept for comparison)
    music_machine_compact.glb the 0.30 m asset the renderer loads by default
    music_machine_wood.png the baked wood base-colour map (also embedded in GLB)

and, with ``--render-previews``, preview PNGs under ``out/music_machine_preview``.

Asset contract (three.js relies on every point below):

* Three meshes, named exactly ``Board``, ``Arm``, ``Foot``.
* Every mesh's **local origin is the board centre**, so the realtime scene can
  place all three at one point and only yaw the board.
* Board: ``0.60 x 0.50`` across/depth, ``0.075`` thick, bevel 0.012, wood grain
  baked into an image texture (no procedural node is left to export).
  * top-surface contact point (local)  = ``(0, 0, +0.0375)``
  * top-surface contact normal (local) = ``(0, 0, +1)``
  * support mount point (local)        = ``(0, 0, -0.0375)``
  These are also stored as custom properties ``contact_local`` /
  ``contact_normal`` / ``mount_local`` on the Board object.
* Arm: a slim bent brass tube from the mount to a round wall foot, authored with
  **plan axes** already applied: Blender ``+Z`` is up and Blender ``+Y`` is the
  wall behind the board (plan ``-Z``), so the glTF Y-up conversion lands the
  parts directly in the plan frame the realtime renderer uses.
* Foot: a round disc on the wall plane (plan ``z = -0.80``).

The wood map is written pixel-by-pixel in Python and saved as an image; the
material uses an Image Texture node, so **nothing needs baking** for glTF -- the
node graph is already exportable.
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from array import array
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
DEFAULT_OUT = HERE
PREVIEW_DIR = os.path.join(PROJECT, "out", "music_machine_preview")

# --- asset dimensions (metres, Blender axes) ---------------------------------
# ``classic`` is the 0.60 m paddle the first machine shipped.  ``compact`` is
# the coordinated narrow build: the plank, its bevel, the brass arm and the foot
# are all scaled together to 0.30 x 0.40 x 0.06 with the board's *centre* still
# the mesh origin, so ``realtime/src/layout.mjs`` (BOARD_W/H/D) and the drawn
# geometry keep one datum.  See NATURAL_FALL_SPACING_HANDOFF.md.
PRESETS = {
    "classic": dict(
        BOARD_X=0.60, BOARD_Y=0.50, BOARD_Z=0.075, BOARD_BEVEL=0.012,
        ARM_RADIUS=0.022, FOOT_RADIUS=0.085, FOOT_DEPTH=0.030, JOINT_RADIUS=0.055,
        WALL_Y=0.80, ELBOW=(0.0, 0.26, -0.34), FOOT_CENTER=(0.0, 0.80, -1.00),
        KNEE=None, JOINT_LIFT=0.0, ARM_START=None,
        suffix="",
    ),
    "compact": dict(
        BOARD_X=0.30, BOARD_Y=0.40, BOARD_Z=0.06, BOARD_BEVEL=0.006,
        # The bracket starts at the plank's *centre* (inside the collision box,
        # not on its underside surface) and sweeps backwards at ~3:1, so the
        # first place the tube leaves the box it is already 0.09 m behind the
        # plank plane.  Since the ball's corridor keeps its centre >= BALL_R
        # from every plank OBB, a bracket shaped like this can never be drawn
        # through the ball: measured clearance 0.134 m vs 0.10 m radius
        # (see NATURAL_FALL_SPACING_HANDOFF.md, "supports").
        ARM_RADIUS=0.011, FOOT_RADIUS=0.045, FOOT_DEPTH=0.016, JOINT_RADIUS=0.020,
        WALL_Y=0.80, KNEE=(0.0, 0.27, -0.09), JOINT_LIFT=0.020,
        ARM_START=(0.0, 0.0, 0.0),
        ELBOW=(0.0, 0.42, -0.30), FOOT_CENTER=(0.0, 0.80, -1.00),
        suffix="_compact",
    ),
}
BOARD_X, BOARD_Y, BOARD_Z = 0.60, 0.50, 0.075   # width, depth(plan z), thickness
BOARD_BEVEL = 0.012
ARM_RADIUS = 0.022
FOOT_RADIUS = 0.085
FOOT_DEPTH = 0.030
JOINT_RADIUS = 0.055   # small brass ball where the arm meets the plank
JOINT_LIFT = 0.0       # ... raised this far toward the face so it stays inside
KNEE = None            # optional extra arm control point (back-swept bracket)
ARM_START = None       # arm curve start (None = the mount on the plank underside)
WALL_Y = 0.80          # plan z = -0.80
MOUNT = (0.0, 0.0, -BOARD_Z / 2)
ELBOW = (0.0, 0.26, -0.34)
FOOT_CENTER = (0.0, WALL_Y, -1.00)


def apply_preset(name: str) -> str:
    """Rebind the module dimensions to a preset; returns the file suffix."""
    preset = PRESETS[name]
    global BOARD_X, BOARD_Y, BOARD_Z, BOARD_BEVEL, ARM_RADIUS, FOOT_RADIUS
    global FOOT_DEPTH, JOINT_RADIUS, JOINT_LIFT, KNEE, ARM_START, WALL_Y, MOUNT
    global ELBOW, FOOT_CENTER
    BOARD_X, BOARD_Y, BOARD_Z = preset["BOARD_X"], preset["BOARD_Y"], preset["BOARD_Z"]
    BOARD_BEVEL = preset["BOARD_BEVEL"]
    ARM_RADIUS = preset["ARM_RADIUS"]
    FOOT_RADIUS = preset["FOOT_RADIUS"]
    FOOT_DEPTH = preset["FOOT_DEPTH"]
    JOINT_RADIUS = preset["JOINT_RADIUS"]
    JOINT_LIFT = preset["JOINT_LIFT"]
    KNEE = preset["KNEE"]
    ARM_START = preset["ARM_START"]
    WALL_Y = preset["WALL_Y"]
    MOUNT = (0.0, 0.0, -BOARD_Z / 2)
    ELBOW = preset["ELBOW"]
    FOOT_CENTER = preset["FOOT_CENTER"]
    return preset["suffix"]

TEX_SIZE = 256


def log(message: str) -> None:
    print("[music-machine] %s" % message)


# --- scene helpers -----------------------------------------------------------

def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def link(obj) -> None:
    bpy.context.scene.collection.objects.link(obj)


def activate(obj) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


# --- wood texture (written directly, no bake needed) -------------------------

def _noise(x: float, y: float) -> float:
    """Deterministic 0..1 value noise (no imports, no RNG state)."""
    s = math.sin(x * 12.9898 + y * 78.233) * 43758.5453
    return s - math.floor(s)


def make_wood_image(name: str = "MM_Wood") -> bpy.types.Image:
    """Deterministic warm wood grain as sRGB pixel data, returned as an Image."""
    size = TEX_SIZE
    image = bpy.data.images.new(name, width=size, height=size, alpha=False)
    image.colorspace_settings.name = "sRGB"
    pixels = array("f", [0.0]) * (size * size * 4)
    light = (0.94, 0.74, 0.47)
    dark = (0.55, 0.30, 0.13)
    for y in range(size):
        v = y / size
        for x in range(size):
            u = x / size
            # grain runs along the plank length (u); the bands wander gently in v
            # instead of repeating as uniform diagonal stripes
            wander = 0.05 * math.sin(u * 2.3 + 0.4) + 0.02 * math.sin(u * 5.1 + 1.9)
            rings = math.sin(((v + wander) * 17.0) * math.pi)
            fibre = _noise(x * 0.5, y * 3.0) - 0.5
            coarse = _noise(x * 0.11, y * 0.11) - 0.5
            knot = (math.exp(-(((u - 0.72) ** 2 + (v - 0.30) ** 2) * 55.0))
                    + 0.7 * math.exp(-(((u - 0.22) ** 2 + (v - 0.78) ** 2) * 70.0)))
            t = 0.64 + 0.11 * rings + 0.05 * fibre + 0.07 * coarse - 0.22 * knot
            t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
            i = (y * size + x) * 4
            pixels[i] = dark[0] + (light[0] - dark[0]) * t
            pixels[i + 1] = dark[1] + (light[1] - dark[1]) * t
            pixels[i + 2] = dark[2] + (light[2] - dark[2]) * t
            pixels[i + 3] = 1.0
    image.pixels.foreach_set(pixels)
    image.pack()
    return image


def make_board_material(image: bpy.types.Image) -> bpy.types.Material:
    """Principled PBR with an Image Texture base colour (glTF-exportable)."""
    mat = bpy.data.materials.new("MM_Board")
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = tree.nodes["Principled BSDF"]
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.location = (-400, 0)
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.55
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def make_brass_material(name: str = "MM_Brass") -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.72, 0.52, 0.22, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.85
    bsdf.inputs["Roughness"].default_value = 0.30
    return mat


def assign(obj, material: bpy.types.Material) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(material)


# --- geometry ----------------------------------------------------------------

def build_board(material: bpy.types.Material):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.0))
    obj = bpy.context.active_object
    obj.name = "Board"
    obj.scale = (BOARD_X, BOARD_Y, BOARD_Z)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = obj.modifiers.new("bevel", "BEVEL")
    bevel.width = BOARD_BEVEL
    bevel.segments = 2
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    # a small mount ball where the arm meets the plank, so the joint is visible
    bpy.ops.mesh.primitive_uv_sphere_add(radius=JOINT_RADIUS, segments=20,
                                         ring_count=12,
                                         location=(MOUNT[0], MOUNT[1],
                                                   MOUNT[2] + JOINT_LIFT))
    joint = bpy.context.active_object
    joint.name = "BoardMount"
    activate(obj)
    bpy.ops.object.select_all(action="DESELECT")
    joint.select_set(True)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = "Board"
    assign(obj, material)
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    obj["contact_local"] = (0.0, 0.0, BOARD_Z / 2)
    obj["contact_normal"] = (0.0, 0.0, 1.0)
    obj["mount_local"] = MOUNT
    return obj


def build_arm(material: bpy.types.Material):
    curve = bpy.data.curves.new("MM_ArmCurve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 12
    curve.bevel_depth = ARM_RADIUS
    curve.bevel_resolution = 3
    curve.use_fill_caps = True
    path = [ARM_START or MOUNT] + ([KNEE] if KNEE else []) + [ELBOW, FOOT_CENTER]
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(path) - 1)
    for point, co in zip(spline.bezier_points, path):
        point.co = co
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new("Arm", curve)
    link(obj)
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.active_object
    obj.name = "Arm"
    assign(obj, material)
    return obj


def build_foot(material: bpy.types.Material):
    bpy.ops.mesh.primitive_cylinder_add(
        radius=FOOT_RADIUS, depth=FOOT_DEPTH,
        location=FOOT_CENTER, rotation=(math.pi / 2.0, 0.0, 0.0),
    )
    obj = bpy.context.active_object
    obj.name = "Foot"
    # bake the transform so the origin is the board centre, like Board/Arms
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    assign(obj, material)
    return obj


# --- previews ----------------------------------------------------------------

def _look_at(camera, target) -> None:
    direction = (target[0] - camera.location[0], target[1] - camera.location[1],
                 target[2] - camera.location[2])
    # a camera looks along its local -Z; rotate that onto the target direction
    quat = Vector(direction).to_track_quat("-Z", "Y")
    camera.rotation_euler = quat.to_euler()


def make_tinted_wood_material(name: str, image, tint) -> bpy.types.Material:
    """Wood texture multiplied by a board colour, so the grain stays visible."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = tree.nodes["Principled BSDF"]
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.location = (-560, 0)
    mix = tree.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    mix.location = (-300, 0)
    mix.inputs["B"].default_value = (tint[0], tint[1], tint[2], 1.0)
    grey = tree.nodes.new("ShaderNodeRGBToBW")
    tree.links.new(tex.outputs["Color"], grey.inputs[0])
    tree.links.new(grey.outputs[0], mix.inputs["A"])
    tree.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.55
    return mat


def _neutral_world(scene, value: float = 0.55) -> None:
    """A plain mid-grey world so metal and wood read against the background."""
    world = scene.world or bpy.data.worlds.new("MM_World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (value, value, value, 1.0)
        bg.inputs["Strength"].default_value = 1.0


def render_previews(out_dir: str, wood_image=None) -> None:
    """Small close-ups: front, oblique, multi-colour row, hit before/after."""
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new("PreviewWorld")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.16, 0.18, 0.21, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    _neutral_world(scene, 0.20)
    if scene.view_settings is not None:
        scene.view_settings.view_transform = "Standard"

    # lighting
    bpy.ops.object.light_add(type="SUN", location=(2.0, -3.0, 4.0))
    sun = bpy.context.active_object
    sun.data.energy = 2.0
    sun.data.angle = 0.2
    _look_at(sun, (0.0, 0.0, 0.0))
    bpy.ops.object.light_add(type="AREA", location=(-2.0, -2.5, 2.0))
    area = bpy.context.active_object
    area.data.energy = 120.0
    area.data.size = 3.0
    _look_at(area, (0.0, 0.0, 0.0))

    bpy.ops.object.camera_add(location=(0.0, -2.6, 0.35))
    camera = bpy.context.active_object
    camera.data.type = "ORTHO"
    scene.camera = camera

    def shoot(name: str, location, target, scale) -> None:
        camera.location = location
        camera.data.ortho_scale = scale
        _look_at(camera, target)
        scene.render.filepath = os.path.join(out_dir, name + ".png")
        bpy.ops.render.render(write_still=True)
        log("preview %s" % scene.render.filepath)

    # frame the whole assembly (plank, elbow arm and round foot), not just the
    # plank: centre on the arm's midpoint and leave a margin on all sides
    assembly_center = (0.0, 0.42, -0.48)
    shoot("front", (0.0, -3.0, 0.0), assembly_center, 1.7)
    shoot("oblique", (2.2, -2.6, 1.5), assembly_center, 1.9)

    # a row of palettes (same Board mesh, per-board material colours)
    board = bpy.data.objects["Board"]
    palette = [
        ("warm", (0.80, 0.42, 0.18, 1.0)),
        ("cyan", (0.16, 0.62, 0.70, 1.0)),
        ("violet", (0.44, 0.26, 0.72, 1.0)),
        ("green", (0.22, 0.60, 0.26, 1.0)),
        ("orange", (0.88, 0.46, 0.14, 1.0)),
    ]
    copies = []
    for k, (name, rgba) in enumerate(palette):
        duplicate = board.copy()
        duplicate.data = board.data.copy()
        duplicate.location = ((k - (len(palette) - 1) / 2.0) * 0.72, 0.0, 0.0)
        # tint the *same* wood texture instead of replacing it: the grain must
        # survive the per-board colour, matching the realtime look
        mat = make_tinted_wood_material("MM_%s" % name, wood_image, rgba)
        duplicate.data.materials.clear()
        duplicate.data.materials.append(mat)
        link(duplicate)
        copies.append(duplicate)
        for part_name in ("Arm", "Foot"):
            part = bpy.data.objects[part_name].copy()
            part.location.x = duplicate.location.x
            link(part)
            copies.append(part)
    board.hide_render = True
    bpy.data.objects["Arm"].hide_render = True
    bpy.data.objects["Foot"].hide_render = True
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 3.7
    camera.location = (0.0, -3.1, 1.7)
    camera.data.ortho_scale = 4.4
    _look_at(camera, (0.0, 0.30, -0.4))
    scene.render.filepath = os.path.join(out_dir, "palette.png")
    bpy.ops.render.render(write_still=True)
    log("preview %s" % scene.render.filepath)
    for duplicate in copies:
        bpy.data.objects.remove(duplicate, do_unlink=True)
    board.hide_render = False
    bpy.data.objects["Arm"].hide_render = False
    bpy.data.objects["Foot"].hide_render = False
    camera.data.type = "PERSP"

    # hit before / after: the board material's emission stands in for the glow
    bsdf = board.data.materials[0].node_tree.nodes["Principled BSDF"]
    emission_socket = bsdf.inputs.get("Emission Color")
    strength_socket = bsdf.inputs.get("Emission Strength")
    camera.location = (1.1, -2.4, 0.9)
    camera.data.ortho_scale = 2.1
    _look_at(camera, (0.0, 0.05, -0.25))
    for strength, name in ((0.0, "hit_before"), (0.8, "hit_after")):
        if strength_socket is not None:
            strength_socket.default_value = strength
        if emission_socket is not None:
            emission_socket.default_value = (1.0, 0.62, 0.34, 1.0)
        scene.render.filepath = os.path.join(out_dir, name + ".png")
        bpy.ops.render.render(write_still=True)
        log("preview %s" % scene.render.filepath)
    if strength_socket is not None:
        strength_socket.default_value = 0.0


# --- main --------------------------------------------------------------------

def build(out_dir: str, render: bool, preset: str = "classic") -> None:
    suffix = apply_preset(preset)
    reset_scene()
    image = make_wood_image()
    wood_path = os.path.join(out_dir, "music_machine%s_wood.png" % suffix)
    image.filepath_raw = wood_path
    image.file_format = "PNG"
    image.save()
    image.pack()
    log("wood texture %s" % wood_path)

    board_mat = make_board_material(image)
    brass_mat = make_brass_material()
    build_board(board_mat)
    build_arm(brass_mat)
    build_foot(brass_mat)

    blend_path = os.path.join(out_dir, "music_machine%s.blend" % suffix)
    glb_path = os.path.join(out_dir, "music_machine%s.glb" % suffix)
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    log("blend %s" % blend_path)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_extras=True,
    )
    log("glb %s" % glb_path)

    if render:
        render_previews(PREVIEW_DIR, image)


def main(argv) -> int:
    parser = argparse.ArgumentParser(prog="build_music_machine.py")
    parser.add_argument("--out-dir", default=DEFAULT_OUT,
                        help="where to write .blend/.glb/wood (default: this dir)")
    parser.add_argument("--render-previews", action="store_true",
                        help="also render close-up preview PNGs")
    parser.add_argument("--preset", default="classic", choices=sorted(PRESETS),
                        help="asset dimensions (classic 0.60 m, compact 0.30 m)")
    args = parser.parse_args(argv)
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    build(out_dir, args.render_previews, args.preset)
    log("done")
    return 0


if __name__ == "__main__":
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    raise SystemExit(main(argv))
