"""Blender 4.5 LTS (EEVEE) renderer for the ball3d generator.

Run through Blender, not with CPython::

    blender -b --factory-startup --python-exit-code 1 -P render_scene.py -- \
        --plan plan.json --frames-dir frames/ --samples 32

Axis convention: the plan is **Y-up** (x = track, y = height, z = lane) while
Blender is **Z-up**, so every plan coordinate crosses the boundary through
to_blender() (x, y, z -> x, z, y).  Board thickness stays vertical, support
posts grow along Blender +Z, the floor is the Blender XY plane and the camera
offsets are expressed directly in Blender axes.

The scene is real geometry (boards with thickness, support posts, a floor, a sun
that casts long shadows, a pearl ball, star particles) rendered by EEVEE with a
compositor Glare node for the coloured glow.  Motion is analytic: every frame is
sampled from score.sample_ball() at exactly frame_index / fps.

The whole sequence goes through ONE animation render (Blender builds its render
state once and keeps it); a frame_change_pre handler applies the analytic state
of each frame at ``frame_time(frame, fps)``, which is the same sampling the
previous per-frame loop used.  Star bursts share one immutable material per
palette hue; boards keep one material each because their emission is animated.

The module imports bpy defensively so that the pure geometry helpers can also be
imported and tested by CPython (see tests/test_render_geometry.py).
"""

from __future__ import annotations

import argparse
import bisect
import math
import os
import sys
import time

try:
    import bpy
    from mathutils import Vector
except ImportError:                     # plain CPython: helpers only
    bpy = None
    Vector = None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score  # noqa: E402

ENGINE = "BLENDER_EEVEE_NEXT"
BG = (0.45, 0.46, 0.48, 1.0)            # neutral medium gray world
BG_STRENGTH = 0.30                      # little ambient -> shadows keep contrast
SUN_ENERGY = 2.6
FILL_ENERGY = 45.0
GROUND_MARGIN = 40.0                    # floor clearance around the whole track
CAM_OFFSET = (-3.0, -6.0, 5.5)          # Blender XYZ: behind, sideways, above
CAM_LOOKAHEAD = (0.6, 0.0, 0.0)
ORTHO_SCALE = 8.0                       # portrait: ~4.5 m wide, 4-6 boards visible
FILL_OFFSET = (2.5, -3.0, 3.5)          # soft area fill, offset from the ball
SPARK_LANE = -0.4                       # point light nudged toward the camera
SPARK_HEIGHT = 0.35                     # just above the floor -> floor halo
SPARK_DECAY = 0.35                      # seconds for the landing flash to fade

# saturated contact-light palette, chosen by pitch class (never white)
PALETTE_HUES = (0.52,   # cyan
                0.36,   # green
                0.13,   # yellow
                0.08,   # orange
                0.88)   # magenta
GLOW_STRENGTH = 2.2                     # board flash after a landing
STAR_STRENGTH = 3.0
STARS_PER_LANDING = 6                   # sparse bursts
SPARK_IDLE = 6.0                        # watts, keeps a faint colored floor pool
SPARK_PEAK = 45.0
IDLE_BOARD = (0.05, 0.06, 0.075, 1.0)   # dark charcoal/blue board body

# Animation output: Blender replaces each '#' with one frame-number digit, so
# this writes frame_000001.png ... exactly the names the CLI muxes.
FRAME_PREFIX = "frame_"
FRAME_HASHES = "######"
PNG_COMPRESSION = 10                    # lossless either way; less zlib CPU/frame


# --- plan -> Blender (pure helpers, unit tested without bpy) -----------------

def to_blender(p):
    """Plan (x, y=height, z=lane) -> Blender Z-up (x, y=lane, z=height)."""
    return (p[0], p[2], p[1])


def board_box(plan_board, c):
    """Plan board -> Blender (box centre, box size); thickness becomes +Z."""
    return to_blender(plan_board["pos"]), (c["board_w"], c["board_d"], c["board_h"])


def post_params(plan_board, c):
    """Plan board -> Blender (post centre, radius, height) for the support."""
    x, lane = plan_board["pos"][0], plan_board["pos"][2]
    height = plan_board["top_y"] - c["board_h"]
    return (x, lane, height * 0.5), c["support_r"], height


def camera_placement(plan, t):
    """Blender camera location and look-at target: both follow sample_track()."""
    track = to_blender(score.sample_track(plan, t))
    return (track[0] + CAM_OFFSET[0], track[1] + CAM_OFFSET[1], track[2] + CAM_OFFSET[2]), \
           (track[0] + CAM_LOOKAHEAD[0], track[1] + CAM_LOOKAHEAD[1],
            track[2] + CAM_LOOKAHEAD[2])


def ground_bounds(plan, margin=GROUND_MARGIN):
    """Blender-space floor rectangle (x0, x1, y0, y1): board extents + margin.

    Sized from the plan rather than a fixed constant, so songs of any length are
    covered (the margin is what keeps the floor edge out of frame).
    """
    xs, lanes = [], []
    for spec in list(plan["boards"]) + [plan["pad"]]:
        x, _y, lane = spec["pos"]
        xs.append(x)
        lanes.append(lane)
    return (min(xs) - margin, max(xs) + margin,
            min(lanes) - margin, max(lanes) + margin)


def ground_covers_track(plan, margin=GROUND_MARGIN):
    """True when the derived floor reaches past every board with the margin."""
    x0, x1, y0, y1 = ground_bounds(plan, margin)
    for spec in list(plan["boards"]) + [plan["pad"]]:
        x, _y, lane = spec["pos"]
        if not (x0 <= x <= x1 and y0 <= lane <= y1):
            return False
        if x1 - x < margin - 1e-9 or x - x0 < margin - 1e-9:
            return False
    return True


def palette_hue(key):
    """Saturated contact-light hue (cyan/green/yellow/orange/magenta).

    ``key`` is a pitch class for event colours, or any index, so nearby notes
    never collapse onto a near-white average.
    """
    return PALETTE_HUES[int(key) % len(PALETTE_HUES)]


def glow_color(key):
    return _hsv(palette_hue(key), 0.85, 1.0)


def frame_time(frame, fps):
    """Absolute time of a 1-based Blender frame: ``(frame - 1) / fps``.

    The one mapping shared by the animation handler and ``score.frame_times()``
    (which samples frame i at exactly i / fps), so rendering the whole sequence
    in one Blender call lands on the same times as the old per-frame loop.
    """
    return (int(frame) - 1) / float(fps)


def frame_pattern(frames_dir):
    """Blender output path with '#' padding -> frame_000001.png ..."""
    return os.path.join(frames_dir, FRAME_PREFIX + FRAME_HASHES)


def frame_filename(index):
    """The PNG name Blender writes for a 1-based frame (CLI contract).

    The digit count comes from FRAME_HASHES, so the path we hand to Blender and
    the names the CLI expects can never drift apart.
    """
    return "%s%0*d.png" % (FRAME_PREFIX, len(FRAME_HASHES), int(index))


# --- material sharing --------------------------------------------------------
# A star burst's material is immutable (fixed colour, fixed strength), so bursts
# of the same palette hue share one material.  Boards never share: their
# emission strength animates, and sharing would make unrelated boards light up.

def star_material_key(midi):
    """Palette slot whose material a landing's burst can reuse."""
    return int(midi) % len(PALETTE_HUES)


def star_materials_by_palette(landings):
    """{palette slot: [landing index, ...]} for the shared burst materials."""
    groups = {}
    for landing in landings:
        groups.setdefault(star_material_key(landing["midi"]), []).append(landing["i"])
    return groups


def board_material_key(index):
    """Every board keeps its own material: one key per board, never shared."""
    return int(index)


# --- mesh builders (pure: verts/faces lists) ---------------------------------

def _add_box(verts, faces, center, size):
    cx, cy, cz = center
    hx, hy, hz = size[0] * 0.5, size[1] * 0.5, size[2] * 0.5
    base = len(verts)
    for dz in (-hz, hz):
        for dy in (-hy, hy):
            for dx in (-hx, hx):
                verts.append((cx + dx, cy + dy, cz + dz))
    faces.extend([
        (base + 0, base + 2, base + 3, base + 1),  # -z
        (base + 4, base + 5, base + 7, base + 6),  # +z
        (base + 0, base + 1, base + 5, base + 4),  # -y
        (base + 2, base + 6, base + 7, base + 3),  # +y
        (base + 0, base + 4, base + 6, base + 2),  # -x
        (base + 1, base + 3, base + 7, base + 5),  # +x
    ])


def _add_cylinder(verts, faces, center, radius, height, segments):
    """Cylinder with its axis along Blender +Z (up)."""
    cx, cy, cz = center
    base = len(verts)
    for z in (cz - height * 0.5, cz + height * 0.5):
        for i in range(segments):
            a = 2.0 * math.pi * i / segments
            verts.append((cx + radius * math.cos(a), cy + radius * math.sin(a), z))
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((base + i, base + j, base + segments + j, base + segments + i))
    faces.append(tuple(base + i for i in range(segments))[::-1])
    faces.append(tuple(base + segments + i for i in range(segments)))


def _add_octahedron(verts, faces, cx, cy, cz, size):
    base = len(verts)
    verts.extend([(cx, cy, cz + size), (cx, cy, cz - size), (cx - size, cy, cz),
                  (cx, cy - size, cz), (cx + size, cy, cz), (cx, cy + size, cz)])
    faces.extend([(base + 0, base + 2, base + 3), (base + 0, base + 3, base + 4),
                  (base + 0, base + 4, base + 5), (base + 0, base + 5, base + 2),
                  (base + 1, base + 3, base + 2), (base + 1, base + 4, base + 3),
                  (base + 1, base + 5, base + 4), (base + 1, base + 2, base + 5)])


def particle_geometry(landing, c, stars=STARS_PER_LANDING):
    """Sparse radiating star octahedra around a landing, in Blender local coords."""
    verts, faces = [], []
    seed = landing["i"]
    for k in range(stars):
        ang = 2.0 * math.pi * k / float(stars)
        rad = c["ball_r"] * (1.8 + 0.45 * ((seed * 7 + k * 13) % 5))
        size = 0.014 + 0.004 * ((seed * 5 + k * 3) % 4)
        _add_octahedron(verts, faces, math.cos(ang) * rad, math.sin(ang) * rad,
                        0.05 * ((seed + k) % 3), size)
    return verts, faces


# --- bpy scene ---------------------------------------------------------------

def _parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    ap = argparse.ArgumentParser(prog="render_scene.py")
    ap.add_argument("--plan", required=True)
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--samples", type=int, default=32)
    ap.add_argument("--max-frames", type=int, default=0,
                    help="0 = render the whole plan (debug aid)")
    return ap.parse_args(argv)


def _require_bpy():
    if bpy is None:
        raise RuntimeError("render_scene.py must run inside Blender "
                           "(blender -b --python-exit-code 1 -P render_scene.py)")
    return bpy


def _clear_scene():
    """Drop the factory-startup cube / light / camera and their data blocks."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.lights,
                       bpy.data.cameras, bpy.data.worlds):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def _new_mesh_object(name, verts, faces, collection):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def _material(name, base_color, roughness=0.5, metallic=0.0,
              emission=None, strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        raise RuntimeError("Principled BSDF node missing in Blender %s"
                           % bpy.app.version_string)
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        for name_, value in (("Emission Color", emission),
                             ("Emission Strength", strength)):
            if name_ not in bsdf.inputs:
                raise RuntimeError("Principled input %r missing in Blender %s"
                                   % (name_, bpy.app.version_string))
            bsdf.inputs[name_].default_value = value
    return mat, bsdf


def _set_emission(bsdf, strength):
    bsdf.inputs["Emission Strength"].default_value = strength


def _hsv(h, s, v):
    h = h % 1.0
    i = int(h * 6.0)
    f = h * 6.0 - i
    p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    r, g, b = [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i % 6]
    return (r, g, b, 1.0)


def _look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def _setup_glare(tree):
    """Coloured glow around the emissive boards / star particles.

    Direct Blender 4.5 API, verified by introspection in the installed build:
    the type and quality are still node properties while 'Threshold' and 'Size'
    are node inputs, and 'Size' is normalised (0.5) rather than the legacy 1-9
    integer property.  A wrong socket name raises KeyError here, instead of the
    silent RNA_float_set warning a legacy property assignment would produce.
    """
    nodes = tree.nodes
    rl = nodes.new("CompositorNodeRLayers")
    glare = nodes.new("CompositorNodeGlare")
    comp = nodes.new("CompositorNodeComposite")
    glare.glare_type = "FOG_GLOW"
    glare.quality = "HIGH"
    # 0.7: low enough that a saturated colour (whose luminance stays well below
    # its brightest channel) still glows, high enough that the grey floor does not
    glare.inputs["Threshold"].default_value = 0.7
    glare.inputs["Size"].default_value = 0.5
    tree.links.new(rl.outputs["Image"], glare.inputs["Image"])
    tree.links.new(glare.outputs["Image"], comp.inputs["Image"])
    return glare


def _engine_setup(scene, plan, samples):
    """Select EEVEE Next and really apply the sample count (no silent fallbacks)."""
    try:
        scene.render.engine = ENGINE
    except TypeError as exc:
        raise RuntimeError("Blender %s does not provide %r (4.5 LTS required): %s"
                           % (bpy.app.version_string, ENGINE, exc))
    if scene.render.engine != ENGINE:
        raise RuntimeError("render engine is %r, expected %r"
                           % (scene.render.engine, ENGINE))
    if samples < 1:
        raise RuntimeError("--samples must be >= 1 (got %r)" % (samples,))
    if not hasattr(scene.eevee, "taa_render_samples"):
        raise RuntimeError("EEVEE has no taa_render_samples in Blender %s"
                           % bpy.app.version_string)
    scene.eevee.taa_render_samples = int(samples)
    if int(scene.eevee.taa_render_samples) != int(samples):
        raise RuntimeError("EEVEE samples stayed at %r, requested %d"
                           % (scene.eevee.taa_render_samples, samples))

    scene.render.resolution_x = int(plan["width"])
    scene.render.resolution_y = int(plan["height"])
    scene.render.resolution_percentage = 100
    scene.render.fps = int(plan["fps"])
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.compression = PNG_COMPRESSION   # lossless
    scene.render.film_transparent = False


def build(plan, samples):
    c = plan["constants"]
    coll = bpy.context.collection
    scene = bpy.context.scene

    _clear_scene()
    _engine_setup(scene, plan, samples)

    world = bpy.data.worlds.new("bg")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = BG
    world.node_tree.nodes["Background"].inputs[1].default_value = BG_STRENGTH
    scene.world = world

    # Standard keeps the saturated hues saturated; AgX pushes bright colours
    # toward white, which is what made the earlier render look washed out.
    # (the default look for Standard is already "None", so it is left alone)
    try:
        scene.view_settings.view_transform = "Standard"
    except (TypeError, ValueError) as exc:
        raise RuntimeError("cannot select the Standard view transform: %s" % exc)
    if scene.view_settings.view_transform != "Standard":
        raise RuntimeError("view transform stayed %r instead of Standard"
                           % scene.view_settings.view_transform)

    # compositor glare = coloured glow around emissive boards / particles
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()
    _setup_glare(tree)

    if not ground_covers_track(plan):
        raise RuntimeError("derived ground %r does not cover the track"
                           % (ground_bounds(plan),))

    # floor: Blender XY plane at z = 0, sized from the boards (any song length)
    gx0, gx1, gy0, gy1 = ground_bounds(plan)
    ground_mat, _ = _material("ground", (0.30, 0.31, 0.33, 1.0), roughness=0.9)
    _new_mesh_object("ground",
                     [(gx0, gy0, 0), (gx1, gy0, 0), (gx1, gy1, 0), (gx0, gy1, 0)],
                     [(0, 1, 2, 3)], coll).data.materials.append(ground_mat)

    # sun at a low-ish angle -> long shadows; plus a fill that follows the ball
    sun_data = bpy.data.lights.new("sun", type="SUN")
    sun_data.energy = SUN_ENERGY
    sun_data.angle = math.radians(1.5)
    sun = bpy.data.objects.new("sun", sun_data)
    sun.rotation_euler = (math.radians(52.0), 0.0, math.radians(126.0))
    coll.objects.link(sun)

    fill_data = bpy.data.lights.new("fill", type="AREA")
    fill_data.energy = FILL_ENERGY
    fill_data.size = 8.0
    fill = bpy.data.objects.new("fill", fill_data)
    coll.objects.link(fill)

    # coloured point light near the current landing: EEVEE emission alone does
    # not light the floor, this is what makes the coloured halo
    spark_data = bpy.data.lights.new("spark", type="POINT")
    spark_data.energy = SPARK_IDLE
    spark_data.shadow_soft_size = 0.5
    spark = bpy.data.objects.new("spark", spark_data)
    coll.objects.link(spark)

    # every landing board plus the start pad (pad = no landing, no glow)
    board_specs = [dict(plan["pad"], landing_t=None)] + \
                  [dict(b, landing_t=plan["landings"][b["index"]]["t"])
                   for b in plan["boards"]]
    board_objs = []
    for spec in board_specs:
        color = glow_color(spec.get("midi") or plan["ref_midi"])
        # idle body: dark charcoal/blue with only a hint of the event hue
        body = tuple(IDLE_BOARD[i] + 0.09 * color[i] for i in range(3)) + (1.0,)
        mat, bsdf = _material("board_%d" % board_material_key(spec["index"]), body,
                              roughness=0.45, metallic=0.1, emission=color,
                              strength=0.0)
        center, size = board_box(spec, c)
        verts, faces = [], []
        _add_box(verts, faces, center, size)
        obj = _new_mesh_object("board_%d" % spec["index"], verts, faces, coll)
        obj.data.materials.append(mat)
        board_objs.append({"obj": obj, "bsdf": bsdf, "landing_t": spec["landing_t"],
                           "strength": -1.0})

    # support posts, merged into one mesh object (kept cheap); axis = Blender +Z
    post_verts, post_faces = [], []
    for spec in board_specs:
        center, radius, height = post_params(spec, c)
        if height <= 0.05:
            raise RuntimeError("support post for board %r would be %r m tall"
                               % (spec["index"], height))
        _add_cylinder(post_verts, post_faces, center, radius, height,
                      c["support_segs"])
    post_mat, _ = _material("post", (0.28, 0.29, 0.32, 1.0), roughness=0.6, metallic=0.4)
    _new_mesh_object("posts", post_verts, post_faces, coll).data.materials.append(post_mat)

    # pearl ball
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24,
                                         radius=c["ball_r"], location=(0, 0, 0))
    ball = bpy.context.active_object
    ball.name = "ball"
    bpy.ops.object.shade_smooth()
    pearl, pearl_bsdf = _material("pearl", (0.97, 0.96, 0.94, 1.0), roughness=0.06,
                                  metallic=0.0, emission=(0.9, 0.93, 1.0, 1.0),
                                  strength=0.0)
    for name, value in (("Coat Weight", 0.6), ("Coat Roughness", 0.05),
                        ("IOR", 1.55)):
        if name in pearl_bsdf.inputs:
            pearl_bsdf.inputs[name].default_value = value
    ball.data.materials.append(pearl)

    # star particles: one object per landing, each animating its own scale, but
    # sharing one immutable material per palette hue (5 instead of one per
    # landing) -- the burst colour/strength never changes, so this is visually
    # identical to a material per burst.
    star_mats = {}
    for key in sorted(star_materials_by_palette(plan["landings"])):
        color = glow_color(key)
        mat, _ = _material("star_palette_%d" % key, color, roughness=0.3,
                           emission=color, strength=STAR_STRENGTH)
        star_mats[key] = mat

    particle_objs = []
    for landing in plan["landings"]:
        verts, faces = particle_geometry(landing, c)
        obj = _new_mesh_object("stars_%d" % landing["i"], verts, faces, coll)
        obj.data.materials.append(star_mats[star_material_key(landing["midi"])])
        obj.scale = (0.0001, 0.0001, 0.0001)
        particle_objs.append({"obj": obj, "t": landing["t"],
                              "base": to_blender(landing["ball_pos"]), "scale": None})

    # orthographic oblique side view: 4-6 boards read across the frame, the ball
    # stays small and fully inside it through the whole hop
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = ORTHO_SCALE
    cam_data.clip_start = 0.1
    cam_data.clip_end = 2000.0
    cam = bpy.data.objects.new("cam", cam_data)
    coll.objects.link(cam)
    scene.camera = cam
    cam.location, target = camera_placement(plan, 0.0)
    _look_at(cam, target)

    # hue of the light pool: the landing just reached, else the first one
    landing_times = [l["t"] for l in plan["landings"]]
    landing_hues = [palette_hue(l["midi"]) for l in plan["landings"]]

    return {"boards": board_objs, "particles": particle_objs, "ball": ball,
            "pearl_bsdf": pearl_bsdf, "cam": cam, "fill": fill, "spark": spark,
            "landing_times": landing_times, "landing_hues": landing_hues,
            "pad_hue": palette_hue(plan["ref_midi"]), "scene": scene,
            "star_materials": len(star_mats)}


# --- per-frame animation (analytic, deterministic) ---------------------------

def apply_frame(ctx, plan, t):
    c = plan["constants"]
    ball_pos = score.sample_ball(plan, t)
    ball = ctx["ball"]
    ball.location = to_blender(ball_pos)

    recent = 0.0
    for b in ctx["boards"]:
        if b["landing_t"] is None:          # start pad: never glows
            continue
        dt = t - b["landing_t"]
        strength = 0.0
        if 0.0 <= dt < c["glow_life"] * 3.0:
            strength = GLOW_STRENGTH * math.exp(-dt / (c["glow_life"] * 0.35))
            recent = max(recent, strength)
        if abs(strength - b["strength"]) > 1e-3:
            _set_emission(b["bsdf"], strength)
            b["strength"] = strength
    # a glossy pearl, not a glowing white disk: only a faint response
    _set_emission(ctx["pearl_bsdf"], min(0.9, 0.25 * recent))

    for p in ctx["particles"]:
        dt = t - p["t"]
        scale = 0.0
        if 0.0 <= dt <= c["hop_life"]:
            rise = min(1.0, dt / 0.10)
            fade = max(0.0, 1.0 - dt / c["hop_life"])
            scale = (0.35 + 0.95 * rise) * fade
        if p["scale"] is None or abs(scale - p["scale"]) > 1e-3:
            s = max(scale, 0.0001)
            x, y, z = p["base"]
            p["obj"].scale = (s, s, s)
            p["obj"].location = (x, y, z + 0.35 * max(0.0, dt))
            p["scale"] = scale

    # camera and fill follow the smooth track line, not the parabola, so the
    # view does not pitch up/down with every hop
    cam_location, target = camera_placement(plan, t)
    cam = ctx["cam"]
    cam.location = cam_location
    _look_at(cam, target)

    track_bl = to_blender(score.sample_track(plan, t))
    fill = ctx["fill"]
    fill.location = (track_bl[0] + FILL_OFFSET[0],
                     track_bl[1] + FILL_OFFSET[1],
                     track_bl[2] + FILL_OFFSET[2])
    _look_at(fill, track_bl)

    # coloured point light at the current landing -> coloured floor halo
    times, hues = ctx["landing_times"], ctx["landing_hues"]
    idx = bisect.bisect_right(times, t + 1e-9) - 1
    if idx >= 0:
        hue, flash_age = hues[idx], max(0.0, t - times[idx])
    else:
        hue, flash_age = ctx["pad_hue"], 0.0     # lead-in: pad hue, dim
    spark = ctx["spark"]
    spark.data.color = _hsv(hue, 0.85, 1.0)[:3]
    spark.data.energy = SPARK_IDLE + SPARK_PEAK * math.exp(-flash_age / SPARK_DECAY)
    spark.location = (track_bl[0], track_bl[1] + SPARK_LANE, SPARK_HEIGHT)


def frame_count(plan):
    """ceil(duration * fps) -- must match score.frame_times() and the CLI."""
    return int(math.ceil(float(plan["duration"]) * int(plan["fps"]) - 1e-9))


def render_frames(ctx, plan, frames_dir, total):
    """Render frames 1..total with ONE Blender animation render call.

    The old loop called ``render(write_still=True)`` per frame, rebuilding the
    render state every time.  An animation render builds it once and keeps it,
    while the analytic per-frame state is applied from a frame_change_pre
    handler at exactly the same times (``frame_time``).  The handler is removed
    again in a finally block, and the frames it actually ran for are checked, so
    a handler that never fired fails loudly instead of writing static images.
    """
    scene = ctx["scene"]
    fps = int(plan["fps"])
    scene.frame_start = 1
    scene.frame_end = total
    scene.render.filepath = frame_pattern(frames_dir)

    handled = []
    failures = []

    def apply_current_frame(scene_, _depsgraph=None):
        if failures:
            return
        frame = int(scene_.frame_current)
        try:
            apply_frame(ctx, plan, frame_time(frame, fps))
        except Exception as exc:
            # Blender can swallow handler exceptions. Never accept stale frames
            # or allow the caller to mux a video after a failed state update.
            failures.append((frame, exc))
        else:
            handled.append(frame)

    bpy.app.handlers.frame_change_pre.append(apply_current_frame)
    try:
        bpy.ops.render.render(animation=True)
    finally:
        bpy.app.handlers.frame_change_pre.remove(apply_current_frame)

    if failures:
        frame, exc = failures[0]
        raise RuntimeError("animation state update failed at frame %d: %s"
                           % (frame, exc)) from exc
    missed = sorted(set(range(1, total + 1)) - set(handled))
    if missed:
        raise RuntimeError("per-frame handler never ran for %d of %d frames "
                           "(first: %d)" % (len(missed), total, missed[0]))


def main():
    args = _parse_args()
    _require_bpy()
    plan = score.load_plan(args.plan)
    score.check_segments(plan)
    frames_dir = os.path.abspath(args.frames_dir)
    os.makedirs(frames_dir, exist_ok=True)

    started = time.perf_counter()
    ctx = build(plan, args.samples)
    build_s = time.perf_counter() - started

    total = frame_count(plan)
    if args.max_frames:
        total = min(total, args.max_frames)

    started = time.perf_counter()
    render_frames(ctx, plan, frames_dir, total)
    render_s = time.perf_counter() - started

    # exact completeness: the names must be frame_000001.png ... frame_000300.png
    written = sorted(n for n in os.listdir(frames_dir)
                     if n.startswith(FRAME_PREFIX) and n.endswith(".png"))
    expected = [frame_filename(i) for i in range(1, total + 1)]
    if written != expected:
        raise RuntimeError("expected %d frames %s..%s in %s, found %d (%s)"
                           % (total, expected[0], expected[-1], frames_dir,
                              len(written), ", ".join(written[:3]) or "none"))

    print("[ball3d] stats: %d objects (%d boards, %d bursts), %d materials "
          "(%d shared star), %dx%d @ %dfps, samples %d"
          % (len(bpy.data.objects), len(ctx["boards"]), len(ctx["particles"]),
             len(bpy.data.materials), ctx["star_materials"],
             plan["width"], plan["height"], int(plan["fps"]), args.samples),
          flush=True)
    print("[ball3d] timing: build %.2fs, render %.2fs for %d frames (%.3fs/frame)"
          % (build_s, render_s, total, render_s / max(total, 1)), flush=True)
    print("[ball3d] rendered %d frames at %dx%d (EEVEE samples %d) -> %s"
          % (total, plan["width"], plan["height"], args.samples, frames_dir),
          flush=True)


if __name__ == "__main__":
    main()
