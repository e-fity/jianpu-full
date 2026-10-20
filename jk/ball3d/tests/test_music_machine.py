"""Static and end-to-end checks for the music-machine delivery.

These assert the properties a reviewer cares about without needing Blender or a
browser: the fixed cycle is gone, the 2D and 3D views share one layout module,
the asset contract names match, and the 2D preview CLI really writes one
self-contained HTML file.
"""
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
LAYOUT = ROOT / 'realtime' / 'src' / 'layout.mjs'
ASSET_SCRIPT = ROOT / 'assets' / 'build_reference_music_machine.py'
REFERENCE = ROOT / 'assets' / 'reference_music_machine.glb'
GLB = ROOT / 'assets' / 'music_machine.glb'
COMPACT = ROOT / 'assets' / 'music_machine_compact.glb'


def read(path):
    return path.read_text(encoding='utf8')


def glb_document(path):
    data = path.read_bytes()
    assert data[:4] == b'glTF'
    length = struct.unpack('<I', data[12:16])[0]
    assert struct.unpack('<I', data[16:20])[0] == 0x4E4F534A  # 'JSON'
    return json.loads(data[20:20 + length].decode('utf8'))


def board_bounds(document):
    by_name = {node.get('name'): node for node in document.get('nodes', [])}
    assert 'Board' in by_name and 'mesh' in by_name['Board']
    mesh = document['meshes'][by_name['Board']['mesh']]
    accessor = document['accessors'][mesh['primitives'][0]['attributes']['POSITION']]
    lo, hi = accessor['min'], accessor['max']
    return lo, hi, [hi[k] - lo[k] for k in range(3)]


def layout_constants():
    """The collision constants the renderer solves with, from the layout module."""
    source = read(LAYOUT)
    out = {}
    for name in ('BOARD_W', 'BOARD_H', 'BOARD_D', 'BALL_R'):
        match = re.search(r'^export const %s = ([0-9.]+);' % name, source, re.M)
        assert match, name
        out[name] = float(match.group(1))
    return out


def test_layout_has_no_fixed_cycle():
    source = read(LAYOUT)
    for forbidden in ('% CYCLE', '% 10', 'CYCLE_DROP', 'boardLocal', '[3,9]', '[3, 9]'):
        assert forbidden not in source, forbidden
    # the auditable thresholds must exist
    assert 'LONG_NOTE_MIN' in source
    assert 'REST_CHANNEL_MIN' in source
    assert 'CHANNEL_MIN_TIME' in source
    assert 'MAX_CHANNEL_SPEED' in source


def test_two_views_share_one_layout_module():
    assert './layout.mjs' in read(ROOT / 'realtime' / 'src' / 'preview2d.mjs')
    assert './layout.mjs' in read(ROOT / 'realtime' / 'src' / 'music_machine.mjs')


def test_asset_contract_names():
    script = read(ASSET_SCRIPT)
    scene = read(ROOT / 'realtime' / 'src' / 'music_machine.mjs')
    for name in ('Board', 'BoardMount', 'SlideRails', 'SlideFittings'):
        assert name in script and name in scene
    assert 'export_scene.gltf' in script
    for path in (ROOT / 'make_realtime_video.py', ROOT / 'realtime' / 'export_session.mjs'):
        assert 'reference_music_machine.glb' in read(path)
    document = glb_document(REFERENCE)
    names = {node.get('name') for node in document['nodes']}
    assert names == {'Board', 'BoardMount', 'SlideRails', 'SlideFittings'}
    for node in document['nodes']:
        if node['name'].startswith('Slide'):
            mesh = document['meshes'][node['mesh']]
            for prim in mesh['primitives']:
                assert {'_SLIDE_U', '_SLIDE_N', '_SLIDE_T', '_SLIDE_Z'} <= prim['attributes'].keys()
    assert document.get('images'), 'the reference wood texture is embedded'


def test_glb_has_the_three_named_meshes():
    for path, build in (
            (GLB, 'blender -b -P ball3d/assets/build_music_machine.py'),
            (COMPACT, 'blender -b -P ball3d/assets/build_music_machine.py '
                      '-- --preset compact')):
        if not path.exists():
            pytest.skip('build it with: ' + build)
        document = glb_document(path)
        names = {node.get('name') for node in document.get('nodes', [])}
        assert {'Board', 'Arm', 'Foot'} <= names, (path.name, names)
        assert document.get('meshes'), 'the GLB contains no meshes'
        assert document.get('images'), 'the wood texture must be embedded'


def test_classic_glb_geometry_dimensions_and_axes():
    if not GLB.exists():
        pytest.skip('build it with: blender -b -P ball3d/assets/build_music_machine.py')
    lo, hi, size = board_bounds(glb_document(GLB))
    # glTF is Y-up: Blender 0.60 x 0.50 x 0.075 becomes 0.60 x 0.075 x 0.50.
    # The mount ball adds ~0.055 below the plank, so only bound the thickness.
    assert abs(size[0] - 0.60) < 0.02, size
    assert abs(size[2] - 0.50) < 0.02, size
    assert 0.05 <= size[1] <= 0.20, size
    # local origin is the plank centre (contacts/mounts are relative to it)
    assert abs(lo[0] + hi[0]) < 0.02, lo


def test_reference_glb_matches_the_layout_constants():
    """The mesh the renderer draws must fit the exact collision slab."""
    lo, hi, size = board_bounds(glb_document(REFERENCE))
    want = layout_constants()
    for axis, name in enumerate(('BOARD_W', 'BOARD_H', 'BOARD_D')):
        assert size[axis] == pytest.approx(want[name], abs=1e-6)
        assert lo[axis] == pytest.approx(-want[name] / 2, abs=1e-6)
        assert hi[axis] == pytest.approx(want[name] / 2, abs=1e-6)
    assert want == {'BOARD_W': 0.30, 'BOARD_H': 0.06, 'BOARD_D': 0.50, 'BALL_R': 0.10}


def test_export_route_loads_the_glb_async():
    export = read(ROOT / 'realtime' / 'src' / 'export.mjs')
    assert 'buildMusicMachine' in export
    assert 'await buildMusicMachine' in export
    assert 'config.assets' in export and 'glb' in export
    scene = read(ROOT / 'realtime' / 'src' / 'music_machine.mjs')
    assert 'GLTFLoader' in scene and 'loadAsync' in scene
    # the mesh that was actually loaded is measured at run time: a GLB that does
    # not match the collision constants stops the export instead of rendering
    assert 'measureSourceAssembly' in scene
    assert 'the loaded GLB does not match the layout constants' in scene
    session = read(ROOT / 'realtime' / 'export_session.mjs')
    # the served URL is derived from the file that is really served, so the page
    # can never receive the classic plank while the layout assumed the compact
    assert 'path.basename(glbPath)' in session


@pytest.mark.skipif(shutil.which('node') is None, reason='Node.js is required')
def test_layout_preview_cli_writes_self_contained_html(tmp_path):
    score = {
        'format': 'jianpu2letter-notes-v1', 'key': '1=C', 'tempo_qpm': 60,
        'lines': [{'notes': [{'n': n, 'o': 0, 'q': q} for n, q in
                            [(1, 1), (2, .5), (0, 1.5), (3, 2.0), (5, .5), (4, 1.0)]]}],
    }
    score_path = tmp_path / 'song.json'
    score_path.write_text(json.dumps(score), encoding='utf8')
    out = tmp_path / 'song_layout2d.html'
    proc = subprocess.run(
        [sys.executable, str(ROOT / 'make_layout_preview.py'),
         '--input', str(score_path), '--output', str(out), '--minify'],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    html = out.read_text(encoding='utf8')
    assert 'window.__PLAN' in html
    assert '<script src=' not in html, 'the preview must not reference external scripts'
    assert 'buildLayout' in html or 'layout' in html
