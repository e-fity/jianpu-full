/**
 * ``wood-drop`` realtime style, matched to the reference video.
 *
 * Warm SMALL wood paddles ride on ONE slim bent brass arm each, with a round
 * dark/gold wall foot.  The course is a deterministic repeating section (rows of
 * 3-4 paddles plus diagonal singles) that descends a dark grey panelled wall; a
 * large glossy pearl bounces continuously between notes and rides curved golden
 * channels between selected groups.  Two thin brass rails with hanging beads run
 * down the side, kept near the camera.
 *
 * Same contract as ``scene.mjs`` -- ``buildWoodScene`` returns ``{scene, camera,
 * update, render, stats, dispose}`` -- so ``export.mjs`` keeps the exact frame
 * loop, audio and export unchanged.  Every position comes from the pure helpers
 * in ``wood_motion.mjs``; there is no ``Math.random`` and no physical solver, so
 * a hop can never miss a note.
 *
 * No star bursts and no additive glow (the reference has neither); only soft
 * shadows, the pearl's reflections and a small damped tilt of a struck paddle.
 */

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import { orthoFrustum } from "./motion.mjs";
import * as S from "./style.mjs";
import * as P from "./pool.mjs";
import * as W from "./wood_motion.mjs";

const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/** Invisible and shadowless: parked far below the frame at a tiny scale. */
const HIDDEN = new THREE.Matrix4()
  .makeTranslation(0, -1000, 0)
  .multiply(new THREE.Matrix4().makeScale(1e-4, 1e-4, 1e-4));

/**
 * Dark grey panelled wall with fine joints, drawn once.  Deterministic (no
 * randomness), so every render of a plan is identical.
 */
function createPanelTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(size, size);
  const base = [72, 76, 83];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // gentle vertical gradient plus a faint grain so the panel is not flat
      const v = y / size;
      const grain = 0;
      const shade = -2.0 * v + grain;
      const i = (y * size + x) * 4;
      image.data[i] = Math.max(0, Math.min(255, Math.round(base[0] + shade)));
      image.data[i + 1] = Math.max(0, Math.min(255, Math.round(base[1] + shade)));
      image.data[i + 2] = Math.max(0, Math.min(255, Math.round(base[2] + shade)));
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  // fine panel joints: one vertical seam and one horizontal seam per tile
  ctx.strokeStyle = "rgba(28,30,34,0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(1, 0);
  ctx.lineTo(1, size);
  ctx.moveTo(0, 1);
  ctx.lineTo(size, 1);
  ctx.stroke();
  ctx.strokeStyle = "rgba(150,155,164,0.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(3, 0);
  ctx.lineTo(3, size);
  ctx.moveTo(0, 3);
  ctx.lineTo(size, 3);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Deterministic wood grain, drawn once and shared by every pooled paddle.
 * Warm sRGB browns with wavy rings and a couple of knots.
 */
function createWoodTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(size, size);
  const light = [235, 172, 104];
  const dark = [166, 90, 40];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const wobble = Math.sin(u * 9.0) * 3.0 + Math.sin(u * 23.0 + 1.7) * 1.5;
      const rings = Math.sin((v * 45.0 + wobble * 0.2) * Math.PI);
      const fibre = Math.sin((u * 90.0 + Math.sin(v * 14.0) * 2.0) * Math.PI);
      const knot = Math.exp(-(((u - 0.72) ** 2 + (v - 0.3) ** 2) * 55.0))
        + 0.7 * Math.exp(-(((u - 0.22) ** 2 + (v - 0.78) ** 2) * 70.0));
      let t = 0.65 + 0.12 * rings + 0.02 * fibre - 0.20 * knot;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const i = (y * size + x) * 4;
      image.data[i] = Math.round(dark[0] + (light[0] - dark[0]) * t);
      image.data[i + 1] = Math.round(dark[1] + (light[1] - dark[1]) * t);
      image.data[i + 2] = Math.round(dark[2] + (light[2] - dark[2]) * t);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 1);
  texture.anisotropy = 4;
  return texture;
}

/**
 * Build the wood-drop scene.
 *
 * @param {object} options
 * @param {THREE.WebGLRenderer} options.renderer
 * @param {object} options.plan  a ``ball3d-plan-v1`` object
 * @param {number} options.width
 * @param {number} options.height
 * @param {boolean} options.bloom
 */
export function buildWoodScene({ renderer, plan, width, height, bloom }) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  const segments = W.woodSegments(plan);
  const times = (plan.landings ?? []).map((landing) => landing.t);
  const count = (plan.boards ?? []).length;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x33363b); // softly lit charcoal

  // --- camera: orthographic portrait, front / slightly raised ---------------
  const frustum = orthoFrustum(width, height, W.ORTHO_SCALE);
  const camera = new THREE.OrthographicCamera(
    frustum.left, frustum.right, frustum.top, frustum.bottom, 0.1, 400.0,
  );
  camera.up.set(0, 1, 0);

  // --- grey panelled wall: sized from the course span, so long songs fit ----
  const span = W.boardSpan(count);
  const wallW = span.x1 - span.x0 + 4.0;
  const wallH = span.y1 - span.y0 + 24.0;
  const panelTexture = createPanelTexture();
  panelTexture.repeat.set(Math.max(1, wallW / 5.0), Math.max(1, wallH / 5.0));
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(wallW, wallH),
    new THREE.MeshStandardMaterial({
      map: panelTexture, color: 0xffffff, roughness: 0.96, metalness: 0.0,
    }),
  );
  wall.position.set((span.x0 + span.x1) / 2, (span.y0 + span.y1) / 2, W.WALL_Z);
  wall.receiveShadow = true;
  scene.add(wall);

  // --- procedural environment for the pearl's broad reflections -------------
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTarget = pmrem.fromScene(room, 0.04);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.35;
  room.dispose();
  pmrem.dispose();

  // --- lights: one shadowed sun plus soft fill/env --------------------------
  scene.add(new THREE.HemisphereLight(0x9aa3ad, 0x1b1d22, 0.42));
  scene.add(new THREE.AmbientLight(0xffffff, 0.16));

  const sun = new THREE.DirectionalLight(0xfff1e0, 1.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.intensity = 0.38;
  sun.shadow.camera.left = -7.0;
  sun.shadow.camera.right = 7.0;
  sun.shadow.camera.top = 7.0;
  sun.shadow.camera.bottom = -7.0;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 60.0;
  sun.shadow.normalBias = 0.02;
  sun.shadow.bias = -0.00002;
  scene.add(sun);
  scene.add(sun.target);
  const sunOffset = new THREE.Vector3(-3.0, 4.0, 9.0);

  const fill = new THREE.DirectionalLight(0xdfe6f2, 0.4);
  fill.position.set(3.0, 4.0, 8.0);
  scene.add(fill);

  // --- wood paddles: one pooled, instanced plank geometry -------------------
  const woodTexture = createWoodTexture();
  const boardGeometry = new RoundedBoxGeometry(W.BOARD_W, W.BOARD_H, W.BOARD_D, 2, 0.018);
  const boardMaterial = new THREE.MeshStandardMaterial({
    map: woodTexture, roughness: 0.58, metalness: 0.0, envMapIntensity: 0.4,
  });
  const boardSlots = P.assertPoolFits(P.boardPoolSize(times), "wood board");
  const boards = new THREE.InstancedMesh(boardGeometry, boardMaterial, boardSlots);
  boards.frustumCulled = false;
  boards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  boards.castShadow = true;
  boards.receiveShadow = true;
  scene.add(boards);

  // --- brass: one slim bent arm + round wall foot per paddle ----------------
  const bracketSlots = boardSlots;
  const brassMaterial = new THREE.MeshStandardMaterial({
    color: 0xb9853a, metalness: 0.85, roughness: 0.32,
    emissive: 0x000000, emissiveIntensity: 0, envMapIntensity: 2.0,
  });
  const goldMaterial = new THREE.MeshStandardMaterial({
    color: 0xcfad70, metalness: 0.8, roughness: 0.20, side: THREE.DoubleSide,
    emissive: 0x000000, emissiveIntensity: 0, envMapIntensity: 2.0,
  });
  const armGeometry = new THREE.CylinderGeometry(1.0, 1.0, 1.0, 10);
  const footGeometry = new THREE.CylinderGeometry(1.0, 1.0, 1.0, 18);
  footGeometry.rotateX(Math.PI / 2); // disc faces the wall (+Z)
  const beadGeometry = new THREE.SphereGeometry(1.0, 12, 10);

  function instanced(geometry, material, slots) {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, slots));
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  const feet = instanced(footGeometry, brassMaterial, bracketSlots);
  const armA = instanced(armGeometry, brassMaterial, bracketSlots);
  const armB = instanced(armGeometry, brassMaterial, bracketSlots);

  // Reuse a small set of continuous open trough meshes; update only on reassignment.
  const channelSlots = W.MAX_CHANNELS;
  const channels = Array.from({length:channelSlots}, () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(W.CHANNEL_SUBDIV*54),3));
    const mesh = new THREE.Mesh(geometry,goldMaterial);
    mesh.frustumCulled=false; mesh.castShadow=true; mesh.receiveShadow=true;
    scene.add(mesh); return {mesh,seg:null};
  });
  const beadGroups=4;
  const beadSlots=beadGroups*W.BEAD_COUNT;
  const railSlots=beadGroups*((W.BEAD_COUNT-1)*2+W.BEAD_COUNT);
  const beads=instanced(beadGeometry,goldMaterial,beadSlots);
  const beadRails=instanced(armGeometry,brassMaterial,railSlots);

  // --- glossy pearl ball ----------------------------------------------------
  const ballMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xd7d1be, roughness: 0.10, metalness: 0.88,
    clearcoat: 1.0, clearcoatRoughness: 0.04, ior: 1.55,
    iridescence: 0.12, iridescenceIOR: 1.3, iridescenceThicknessRange: [120, 420],
    envMapIntensity: 1.15,
  });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(W.BALL_R, 48, 24), ballMaterial);
  ball.castShadow = true;
  scene.add(ball);

  // --- optional bloom (same pipeline as the classic scene) ------------------
  let composer = null;
  if (bloom) {
    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType, samples: S.BLOOM_MSAA,
    });
    composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(
      new THREE.Vector2(width, height),
      S.BLOOM_STRENGTH, S.BLOOM_RADIUS, S.BLOOM_THRESHOLD,
    ));
    composer.addPass(new OutputPass());
  }

  const matrix = new THREE.Matrix4();
  const mid = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const yawQuat = new THREE.Quaternion();

  /** A unit-height cylinder stretched between two points. */
  function placeSegment(mesh, slot, a, b, radius) {
    dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const length = dir.length() || 1e-6;
    mid.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    quat.setFromUnitVectors(UP, dir.multiplyScalar(1 / length));
    scale.set(radius, length, radius);
    matrix.compose(mid, quat, scale);
    mesh.setMatrixAt(slot, matrix);
  }

  /** Axis-aligned scaled box/disc about a point. */
  function placeAt(mesh, slot, x, y, z, sx, sy, sz) {
    mid.set(x, y, z);
    scale.set(sx, sy, sz);
    matrix.compose(mid, quat.identity(), scale);
    mesh.setMatrixAt(slot, matrix);
  }

  function hide(mesh, slot) {
    mesh.setMatrixAt(slot, HIDDEN);
  }

  function placePaddle(slot, index, tilt) {
    if (tilt) {
      quat.setFromAxisAngle(Z_AXIS, tilt);
    } else {
      quat.identity();
    }
    quat.multiply(yawQuat.setFromAxisAngle(UP,W.boardYaw(index)));
    mid.set(W.boardX(index), W.boardTopY(index) - W.BOARD_H * 0.5, W.boardZ());
    scale.set(1, 1, 1);
    matrix.compose(mid, quat, scale);
    boards.setMatrixAt(slot, matrix);
  }

  /** ONE slim bent brass arm: wall foot, elbow, and a short reach under the plank. */
  function placeArm(slot, index) {
    const bx = W.boardX(index);
    const topY = W.boardTopY(index);
    const wallZ = W.WALL_Z + 0.03;
    const footY = topY - 1.05;
    const elbow = [bx, topY - 0.36, -0.24];
    placeAt(feet, slot, bx, footY, wallZ + 0.02, 0.075, 0.075, 0.03);
    placeSegment(armA, slot, [bx, footY, wallZ], elbow, 0.022);
    placeSegment(armB, slot, elbow, [bx, topY - W.BOARD_H - 0.02, W.boardZ()], 0.020);
  }

  function hidePaddle(slot) {
    hide(boards, slot);
    hide(feet, slot);
    hide(armA, slot);
    hide(armB, slot);
  }

  function placeChannels(trackY) {
    const live=W.channelsNear(segments,trackY);
    if(live.length>channelSlots) throw new Error('Visible channel pool overflow');
    for(let slot=0;slot<channelSlots;slot++) {
      const item=channels[slot],seg=live[slot]?.seg;
      item.mesh.visible=Boolean(seg);
      if(!seg || item.seg===seg) continue;
      item.seg=seg;
      const vertices=item.mesh.geometry.attributes.position.array;
      let offset=0;
      const triangle=(a,b,c)=>{for(const p of [a,b,c]) for(const v of p) vertices[offset++]=v;};
      const quad=(a,b,c,d)=>{triangle(a,b,c);triangle(a,c,d);};
      const raised=(p,n)=>p.map((v,i)=>v+n[i]*W.CHANNEL_RAIL_H);
      for(let i=0;i<W.CHANNEL_SUBDIV;i++) {
        const a=W.channelCross(seg,i/W.CHANNEL_SUBDIV),b=W.channelCross(seg,(i+1)/W.CHANNEL_SUBDIV);
        quad(a.left,a.right,b.right,b.left);
        quad(a.left,b.left,raised(b.left,b.normal),raised(a.left,a.normal));
        quad(a.right,b.right,raised(b.right,b.normal),raised(a.right,a.normal));
      }
      item.mesh.geometry.attributes.position.needsUpdate=true;
      item.mesh.geometry.computeVertexNormals();
    }
  }

  // World-anchored curved double rails, not decorations glued to the camera.
  function placeBeads(trackY) {
    const first=Math.max(0,Math.floor(-trackY/W.CYCLE_DROP)-1);
    let bi=0,ri=0;
    for(let c=first;c<first+beadGroups;c++) {
      if(c*W.CYCLE>=count) break;
      let previous=null;
      for(let j=0;j<W.BEAD_COUNT;j++) {
        const u=j/(W.BEAD_COUNT-1),x=-2.05+.85*u;
        const y=-c*W.CYCLE_DROP-5.7+.3*(2*u-1)**2;
        const front=[x,y,.2],back=[x,y,.08];
        placeAt(beads,bi++,x,y-.19,.14,W.BEAD_R,W.BEAD_R,W.BEAD_R);
        placeSegment(beadRails,ri++,[x,y,.14],[x,y-.14,.14],.012);
        if(previous) {
          placeSegment(beadRails,ri++,previous[0],front,.016);
          placeSegment(beadRails,ri++,previous[1],back,.016);
        }
        previous=[front,back];
      }
    }
    for(;bi<beadSlots;bi++) hide(beads,bi);
    for(;ri<railSlots;ri++) hide(beadRails,ri);
  }

  function update(t) {
    const ballPos = W.sampleWoodBall(segments, t);
    ball.position.set(ballPos[0], ballPos[1], ballPos[2]);

    const track = W.sampleWoodTrack(segments, t);
    const view = W.woodCameraPlacement(track);
    camera.position.set(view.location[0], view.location[1], view.location[2]);
    camera.lookAt(view.target[0], view.target[1], view.target[2]);

    // the shadow rig follows the ball down the wall
    sun.target.position.set(track[0] * W.CAM_TRACK_DAMP, track[1], W.WALL_Z);
    sun.position.copy(sun.target.position).add(sunOffset);
    sun.target.updateMatrixWorld();

    // a struck paddle tilts only after the ball has rolled clear of it
    const active = W.segmentIndexAt(segments, t);
    let tiltIndex = -1;
    let tilt = 0;
    if (active >= 0) {
      const seg = segments[active];
      if (seg.kind !== "hold" && t > seg.departure) {
        tilt = W.tiltAngle(t - seg.departure);
        if (tilt !== 0) tiltIndex = seg.from;
      }
    }

    const pool = P.boardPool(times, t);
    const indices = P.poolIndices(pool);
    for (let slot = 0; slot < boardSlots; slot += 1) {
      const index = slot < indices.length ? indices[slot] : null;
      if (index === null) {
        hidePaddle(slot);
        continue;
      }
      placePaddle(slot, index, index === tiltIndex ? tilt : 0);
      placeArm(slot, index);
    }
    boards.instanceMatrix.needsUpdate = true;
    for (const mesh of [feet, armA, armB]) mesh.instanceMatrix.needsUpdate = true;

    placeChannels(track[1]);

    placeBeads(track[1]);
    beads.instanceMatrix.needsUpdate = true;
    beadRails.instanceMatrix.needsUpdate = true;
  }

  function render() {
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  function stats() {
    return {
      board_slots: boardSlots,
      bracket_slots: bracketSlots,
      channel_slots: channelSlots,
      bead_slots: beadSlots,
      materials: 5,
      lights: 4,
      bloom: Boolean(composer),
      render: {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      },
    };
  }

  function dispose() {
    scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      }
    });
    woodTexture.dispose();
    panelTexture.dispose();
    envTarget.dispose();
    if (composer) composer.dispose();
  }

  return { scene, camera, update, render, stats, dispose };
}

