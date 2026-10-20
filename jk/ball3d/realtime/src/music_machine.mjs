/** Music-driven scene using the approved Blender plank and twin-rail assets.
 * The shared layout supplies note contacts and slide paths; the imported meshes
 * use the reference geometry; gravity, contacts and guided rails share one course.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import defaultConfig from "../config.json" with { type: "json" };
import { boardSpring, cameraPresentation, shadowPresentation, visibleBoards, validatePresentation } from "./presentation.mjs";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import * as S from "./style.mjs";
import * as L from "./layout.mjs";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createGravityKit } from "./gravity_layout.mjs";
import { boardPose, spatialRailPoint, spatialRailNormal, spatialRailRotation } from "./spatial_course.mjs";
import { hull, clipScreen, intersects, rectangle } from "./screen_geometry.mjs";
import { referencePlankSize, NOTE_LIGHTS, notePulse, wallSwing } from "./wall_course.mjs";
import { deformSlide, noteFitting } from "./reference_geometry.mjs";
import { withRailGlow, railVisible, passageGlow } from "./rail_glow.mjs";
import { visualDefaults, hexToRgb } from "./settings.mjs";
import { instanceGlowAttributes, setInstanceGlow, withInstanceGlow } from "./instance_glow.mjs";
import { lyricMetrics } from "./lyric_style.mjs";

/** The reference master asset every editor geometry is derived from. */
const MASTER = { w: 0.30, h: 0.06, d: 0.50 };

const Z_AXIS = new THREE.Vector3(0, 0, 1);

const WALL_MARGIN = 12.0;

/**
 * The GLB this style is built for.  ``layout.mjs`` sizes the collision boxes,
 * the contact offset and the ball from its own constants (``BOARD_W = 0.30``),
 * so the asset must be the reference build; ``measureSourceAssembly`` below measures
 * the mesh that was actually loaded and refuses to draw the 0.60 m classic one.
 */
export const BUILD_GLB_CMD =
  "blender -b -P ball3d/assets/build_reference_music_machine.py";

/** Deterministic dark panelled wall (no randomness -> identical renders). */
function createPanelTexture(base = [72, 76, 83], grid=true) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    const shade = -2.0 * (y / size);
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      image.data[i] = Math.max(0, Math.min(255, Math.round(base[0] + shade)));
      image.data[i + 1] = Math.max(0, Math.min(255, Math.round(base[1] + shade)));
      image.data[i + 2] = Math.max(0, Math.min(255, Math.round(base[2] + shade)));
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  if(grid) {
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
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

/** Fixed brace whose measured end-to-end length is a fraction of plank width. */
function mountGeometry(hinge, wallZ, length, width,paired=false) {
  const dz = hinge.z - wallZ;
  const foot = new THREE.Vector3(hinge.x, hinge.y - Math.sqrt(length*length-dz*dz), wallZ);
  const direction = hinge.clone().sub(foot);
  const rod = new THREE.CylinderGeometry(width*.04, width*.04, length, 12);
  rod.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), direction.clone().normalize()));
  rod.translate(...hinge.clone().add(foot).multiplyScalar(.5).toArray());
  const joint = new THREE.SphereGeometry(width*.06, 16, 12);
  joint.translate(...hinge.toArray());
  const base = new THREE.CylinderGeometry(width*.09, width*.09, width*.05, 16);
  base.rotateX(Math.PI/2); base.translate(...foot.toArray());
  const assembly=mergeGeometries([rod,joint,base]);
  let geometry=assembly;
  if(paired) {
    const braces=[assembly.clone().translate(-width*.43,0,0),assembly.clone().translate(width*.43,0,0)];
    geometry=mergeGeometries(braces);braces.forEach(brace=>brace.dispose());assembly.dispose();
  }
  for(const part of [rod,joint,base])part.dispose();
  return geometry;
}
function softShadowTexture(rgb='0,0,0') {
  const canvas=document.createElement("canvas");canvas.width=canvas.height=128;
  const ctx=canvas.getContext("2d"),gradient=ctx.createRadialGradient(64,64,0,64,64,64);
  gradient.addColorStop(0,`rgba(${rgb},1)`);
  gradient.addColorStop(.4,`rgba(${rgb},.55)`);gradient.addColorStop(1,`rgba(${rgb},0)`);
  ctx.fillStyle=gradient;ctx.fillRect(0,0,128,128);
  return new THREE.CanvasTexture(canvas);
}

/** Fetch and parse the GLB, returning the named reference meshes or throwing. */
async function loadAssembly(url) {
  const loader = new GLTFLoader();
  let gltf;
  try {
    const response=await fetch(url);
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    gltf = await loader.parseAsync(await response.arrayBuffer(),new URL('.',new URL(url,location.href)).href);
  } catch (error) {
    throw new Error(`could not load the music-machine GLB (${url}): ${error} — ` +
      "build it with: blender -b -P ball3d/assets/build_reference_music_machine.py");
  }
  const found = {};
  gltf.scene.traverse((object) => {
    if (object.isMesh && ["Board", "BoardMount", "SlideRails", "SlideFittings"].includes(object.name)) {
      found[object.name] = object;
    }
  });
  for (const name of ["Board", "BoardMount", "SlideRails", "SlideFittings"]) {
    if (!found[name]) {
      throw new Error(`the GLB has no mesh named ${name}; rebuild it with ` +
        "ball3d/assets/build_reference_music_machine.py");
    }
  }
  return found;
}

/** Validate the source GLB against the unchanged solver geometry.
 * The separate visual board_size report describes the smaller contact-anchored
 * slabs actually drawn in this stage. The ball and slide radii stay unchanged.
 */
function measureSourceAssembly(parts, ball, kit, scale) {
  const box = (mesh) => {
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry.clone();
    geometry.computeBoundingBox();
    const local = geometry.boundingBox.clone();
    geometry.dispose();
    return local.applyMatrix4(mesh.matrixWorld);
  };
  const board = box(parts.Board);
  const raw = new THREE.Vector3();
  board.getSize(raw);
  const size = new THREE.Vector3(raw.x * scale[0], raw.y * scale[1], raw.z * scale[2]);
  const mount = box(parts.BoardMount);
  const mountFrontZ = kit.BOARD_Z + mount.max.z * scale[2];
  const rearEdgeZ = kit.BOARD_Z + board.min.z * scale[2];
  const faceY = board.max.y * scale[1];
  const backY = board.min.y * scale[1];
  const drawnBall = (ball.geometry.parameters?.radius
    ?? (() => {
      ball.geometry.computeBoundingSphere();
      return ball.geometry.boundingSphere.radius;
    })()) * Math.abs(ball.scale.x);
  // the constants live in the layout *module*: the layout object itself only
  // carries this song's boards/segments/channels
  const { BOARD_W, BOARD_H, BOARD_D, BALL_R: R } = kit;
  const tol = 0.02;
  // 1. the file itself must be the reference master (never the classic 0.60 m one)
  const master = {
    width: Math.abs(raw.x - MASTER.w) <= tol,
    depth: Math.abs(raw.z - MASTER.d) <= tol,
    thickness: raw.y >= MASTER.h - tol,
  };
  // Source geometry must match the solver; the drawn ball keeps its radius.
  const checks = {
    width: Math.abs(size.x - BOARD_W) <= tol,
    depth: Math.abs(size.z - BOARD_D) <= tol,
    // the drawn face sits on the collision slab's front face ...
    face: Math.abs(faceY - BOARD_H / 2) <= tol,
    // ... and the plank body (plus its tucked joint ball) stays inside the
    // collision box, so nothing drawn can enter the ball's corridor unseen
    behind: backY >= -BOARD_H / 2 - tol,
    ball: Math.abs(drawnBall - R) <= tol,
    wall_attachment: rearEdgeZ < kit.WALL_Z && kit.WALL_Z - rearEdgeZ <= .02 * kit.BOARD_D,
    mount_clearance: mountFrontZ <= kit.BOARD_Z - R,

  };
  const report = {
    master_size: [raw.x, raw.y, raw.z],
    scale: scale.slice(),
    board_size: [size.x, size.y, size.z],
    board_face_y: faceY,
    board_back_y: backY,
    wall_z: kit.WALL_Z,
    board_rear_z: rearEdgeZ,
    mount_front_z: mountFrontZ,
    drawn_ball_r: drawnBall,
    want: { w: BOARD_W, h: BOARD_H, d: BOARD_D, ball_r: R },
    ball_r: R,
    master: master,
    checks,
    ok: Object.values(checks).every(Boolean) && Object.values(master).every(Boolean),
  };
  if (!report.ok) {
    // A 0.60 m asset with 0.30 m collision constants is exactly the mismatch
    // this export cannot survive: the drawn board would be twice as wide as the
    // box the solver keeps clear, so every audited clearance would be a lie.
    throw new Error(
      "music-machine: the loaded GLB does not match the layout constants "
      + `${JSON.stringify(report)}; rebuild the reference asset with `
      + `\`${BUILD_GLB_CMD}\``,
    );
  }
  return report;
}

function woodTexture(map, strength) {
  if (!map) return map;
  // strength 0 = no grain at all: the map is dropped, so the plank is drawn as
  // the flat per-instance colour (the grain cannot survive as a low-contrast
  // ghost).  1 = the baked map, untouched.
  if (strength <= 0.001) return null;
  if (strength >= 0.999) return map;
  const image = map.image;
  if (!image || !image.width || typeof document === "undefined") return map;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  // flatten the grain: contract every pixel toward the map's mean tone, so a
  // partial strength is a visibly weaker grain rather than a dimmer board
  ctx.filter = `contrast(${(0.05 + 0.95 * strength).toFixed(3)}) `
    + `saturate(${(0.25 + 0.75 * strength).toFixed(3)}) brightness(${(1 + 0.35 * (1 - strength)).toFixed(3)})`;
  ctx.drawImage(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = map.colorSpace;
  texture.flipY = map.flipY;
  texture.wrapS = map.wrapS;
  texture.wrapT = map.wrapT;
  texture.anisotropy = map.anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Build the scene.
 *
 * @param {object} options
 * @param {THREE.WebGLRenderer} options.renderer
 * @param {object} options.plan  a ``ball3d-plan-v1`` object
 * @param {number} options.width
 * @param {number} options.height
 * @param {boolean} options.bloom
 * @param {string} options.glbUrl  URL of the built GLB (see BUILD_GLB_CMD)
 * @param {object} [options.kit]      the layout module instance for this task's
 *   geometry (see layout_kit.mjs).  Defaults to the shipped constants.
 * @param {object} [options.visuals]  normalised visual settings (settings.mjs)
 * @returns {Promise<object>} the scene controller
 */
export async function buildMusicMachine({
  renderer, plan, width, height, bloom, glbUrl, kit = L, visuals, layout,
  presentation = defaultConfig, hdrUrl = "/editor/environment",
}) {
  if (!glbUrl) throw new Error(`music-machine needs --glb (${BUILD_GLB_CMD})`);
  const V = visuals || visualDefaults();
  const C = structuredClone(validatePresentation(presentation));
  if (!layout && (!kit || typeof kit.buildLayout !== "function")) {
    throw new Error("music-machine: a layout kit is required (layout_kit.mjs)");
  }
  kit = createGravityKit(kit, C);
  const solved = layout || kit.buildLayout(plan);
  const times = solved.boards.map((board) => board.t);

  const framing = { mode: "perspective", ball_width: C.ball.screenWidth,
    max_boards_across: C.camera.maxBoardsAcross, downwardTilt: C.camera.downwardTilt };
  const parts = await loadAssembly(glbUrl);

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = V.exposure;
  renderer.shadowMap.enabled = V.shadows !== false;

  const scene = new THREE.Scene();
  const lyricScene = new THREE.Scene();
  scene.background = new THREE.Color(0x33363b);

  const camera = new THREE.PerspectiveCamera(C.camera.fov, width / height, 0.05, 400);
  const side = 2 * kit.BALL_R * C.boards.sideDiameters;
  const wallMounted=solved.format==='ball3d-wall-v1';
  const plankSize=wallMounted?referencePlankSize(side):[side,kit.BOARD_H,side];
  const wallZ = wallMounted?solved.wallZ:0.008 - side;

  // --- wall, sized from the layout so any song length fits ------------------
  const ys = solved.segments.flatMap(s => [s.p0[1],s.p1[1]]).concat([solved.pad.top_y]);
  const xs = solved.segments.flatMap(s => [s.p0[0],s.p1[0]]).concat([solved.pad.pos[0]]);
  const y0 = Math.min(...ys) - WALL_MARGIN;
  const y1 = Math.max(...ys) + WALL_MARGIN;
  const x0 = Math.min(...xs) - 2 * WALL_MARGIN;
  const x1 = Math.max(...xs) + 2 * WALL_MARGIN;
  const panelTexture = createPanelTexture(hexToRgb(V.wall_color),!wallMounted);
  panelTexture.repeat.set(Math.max(1, (x1 - x0) / 5), Math.max(1, (y1 - y0) / 5));
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(x1 - x0, y1 - y0),
    new THREE.MeshStandardMaterial({
      map: panelTexture, color: 0xffffff, roughness: 0.96, metalness: 0.0,
    }),
  );
  wall.position.set((x0 + x1) / 2, (y0 + y1) / 2, wallZ);
  wall.receiveShadow = true;
  scene.add(wall);
  if(C.spatial?.enabled && !wallMounted) wall.visible=false;

  // Local CC0 HDR: loading failure aborts rather than replacing glass lighting.
  const hdr = await new HDRLoader().loadAsync(hdrUrl);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromEquirectangular(hdr);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = C.environment.intensity;
  scene.environmentRotation.y = C.environment.rotation;
  hdr.dispose();
  pmrem.dispose();

  // --- lights ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x9aa3ad, 0x1b1d22, 0.42));
  scene.add(new THREE.AmbientLight(0xffffff, 0.16));
  const sun = new THREE.DirectionalLight(0xfff1e0, V.sun);
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
  const rim = new THREE.DirectionalLight(C.ball.rimColor, C.ball.rimIntensity);
  scene.add(rim, rim.target);
  // Keep the light count fixed so shader compilation cannot depend on seek order.
  const spillLights=wallMounted?Array.from({length:4},()=>new THREE.PointLight(0xffffff,0,side*9,2)):[];
  for(const light of spillLights)scene.add(light);

  // Boards remain in the layout and are selected by the current camera frustum.
  const boardSlots = solved.boards.length;
  const boardMaterial = withInstanceGlow(parts.Board.material.clone());
  boardMaterial.color.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
  boardMaterial.envMapIntensity = 0.4;
  const woodMap = woodTexture(boardMaterial.map, V.wood);
  if (woodMap !== boardMaterial.map) boardMaterial.map = woodMap;
  const goldMaterial = parts.SlideRails.material.clone();
  goldMaterial.color.setStyle(V.arm_color);
  goldMaterial.envMapIntensity = 1.4;
  const boardMeshes = Array.from({ length: boardSlots }, (_, index) => {
    const geometry = parts.Board.geometry.clone();
    instanceGlowAttributes(geometry, 1);
    const wood = withInstanceGlow(boardMaterial.clone());
    wood.transparent = false;
    const mesh = new THREE.InstancedMesh(geometry, wood, 1);
    mesh.name = `NoteBoard_${index}`;
    mesh.frustumCulled = false;
    const metal = goldMaterial.clone();
    metal.transparent = false;
    const mount = new THREE.Mesh(new THREE.BufferGeometry(), metal);
    mount.name = `BoardRod_${index}`;
    for (const object of [mesh, mount]) {
      object.castShadow = true;
      object.receiveShadow = true;
      scene.add(object);
    }
    let halo=null;
    if(wallMounted) {
      const board=solved.boards[index],bw=board.size[0];
      halo=new THREE.Mesh(new THREE.PlaneGeometry(bw*8,bw*8),new THREE.MeshBasicMaterial({
        map:softShadowTexture('255,255,255'),color:NOTE_LIGHTS[solved.boards[index].n-1],transparent:true,opacity:0,
        depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false}));
      halo.position.set(board.pos[0],board.pos[1],wallZ+.006);scene.add(halo);
    }
    return { mesh, mount, halo };
  });
  // The mesh's path coordinate carries the physical passage time to the shader.
  const channelMeshes = solved.channels.map(seg => {
    if(seg.spatial && wallMounted) {
      // Same tube radius and spacing the clearance test uses: the twin rails are
      // about a third of a plank wide, and the ball visually rests on them.
      const R=kit.BALL_R, scale=R*2, radius=.035*scale, spacing=.135*scale;
      const drop=Math.sqrt((R+radius)**2-spacing**2);
      const meshes=[-1,1].map(sign=>{
        const points=Array.from({length:65},(_,i)=>{
          const u=i/64, p=new THREE.Vector3(...spatialRailPoint(seg,u));
          const angle=seg.angle0+(seg.sweep||0)*u;
          return p.addScaledVector(new THREE.Vector3(...spatialRailNormal(seg,u)),-drop)
            .add(new THREE.Vector3(Math.cos(angle)*sign*spacing,0,Math.sin(angle)*sign*spacing));
        });
        const material=goldMaterial.clone();
        material.color.setStyle('#d8b97e');
        material.roughness=.34;material.metalness=1;
        material.emissive=new THREE.Color('#ffcf7a');material.emissiveIntensity=0;
        const mesh=new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),64,radius,12,false),material);
        mesh.geometry.computeBoundingSphere();mesh.castShadow=true;mesh.receiveShadow=true;scene.add(mesh);return mesh;
      });
      return {meshes,beads:[],clock:{value:0},seg};
    }
    if(seg.spatial && !wallMounted) {
      const meshes=(wallMounted?[-1,1]:[0]).map(sign=>{
        const radius=side*(wallMounted?.012:.018),offset=sign*side*.09;
        const drop=Math.sqrt((kit.BALL_R+radius)**2-offset**2);
        const points=Array.from({length:65},(_,i)=>{
          const p=new THREE.Vector3(...spatialRailPoint(seg,i/64)),a=seg.angle0+seg.sweep*i/64;
          return p.add(new THREE.Vector3(Math.cos(a)*offset,-drop,Math.sin(a)*offset));
        });
        const material=goldMaterial.clone();if(wallMounted){material.color.setStyle('#a8adb5');material.roughness=.26;material.metalness=1;}
        const mesh=new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),64,radius,8,false),material);
        mesh.geometry.computeBoundingSphere();mesh.castShadow=true;scene.add(mesh);return mesh;
      });
      return {meshes,beads:[],clock:{value:0},seg};
    }
    const railParts = [parts.SlideRails];
    const clock={value:0};
    const meshes = railParts.map(part => {
      const material = goldMaterial.clone();
      const mesh = new THREE.Mesh(part.geometry.clone(), material);
      deformSlide(mesh.geometry, seg, kit);
      if(!seg.spatial)withRailGlow(mesh.material,mesh.geometry,seg,C.tracks,clock);
      mesh.geometry.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      return mesh;
    });
    const beads=(seg.beads||[]).map(event=>{
      const material=goldMaterial.clone();material.emissive=new THREE.Color('#ffb52e');
      const mesh=new THREE.Mesh(noteFitting(parts.SlideFittings.geometry,seg,kit,event.u),material);
      mesh.castShadow=true;mesh.receiveShadow=true;scene.add(mesh);
      return {mesh,event};
    });
    return { meshes, beads, clock, seg };
  });

  const ballMaterial = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(C.ball.attenuationColor).lerp(new THREE.Color('#ffffff'),.45), metalness: 0, transmission: C.ball.transmission,
    ior: C.ball.ior, roughness: C.ball.roughness,
    thickness: 2 * kit.BALL_R * C.ball.thicknessDiameters,
    clearcoat: 1, clearcoatRoughness: C.ball.roughness,
    iridescence: 1, iridescenceIOR: 1.4, iridescenceThicknessRange: [100, 600],
    envMapIntensity: C.ball.environmentIntensity,
    attenuationColor: C.ball.attenuationColor,
    attenuationDistance: 2 * kit.BALL_R * C.ball.attenuationDiameters,
    emissive: C.ball.emissiveColor, emissiveIntensity: C.ball.emissiveIntensity,
  });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(kit.BALL_R, 64, 48), ballMaterial);
  scene.add(ball);
  const ballGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softShadowTexture('255,255,255'), color: 0xff8fb8, transparent: true,
    opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  ballGlow.scale.setScalar(kit.BALL_R * 6);
  scene.add(ballGlow);
  const ballShadow = new THREE.Mesh(new THREE.PlaneGeometry(2,2), new THREE.MeshBasicMaterial({
    map:softShadowTexture(),transparent:true,depthWrite:false,toneMapped:false,
  }));
  scene.add(ballShadow);

  // Validate the loaded source asset; visual slabs are smaller subsets whose
  // top/leading edge is anchored to the original contact, not re-solved.
  const sourceGeometry = measureSourceAssembly(parts, ball, kit, [
    kit.BOARD_W / MASTER.w, kit.BOARD_H / MASTER.h, kit.BOARD_D / MASTER.d,
  ]);
  const geometryReport = {
    source: sourceGeometry, board_size: plankSize,
    board_size_range:[0,1,2].map(k=>boardSlots?[Math.min(...solved.boards.map(b=>(b.size??plankSize)[k])),Math.max(...solved.boards.map(b=>(b.size??plankSize)[k]))]:[plankSize[k],plankSize[k]]),
    source_plank:wallMounted?'reference_planks/reference_planks.blend:Plank_02_Ivory':null,
    original_proportions_restored:wallMounted,wall_mounted:wallMounted,
    board_to_ball: C.boards.sideDiameters, ball_r: kit.BALL_R,
    wall_z: wallZ, contact_preserved: true, board_response: "analytic-damped-hinge", rod_length: C.boards.rodLengthWidths*side,
    gravity: kit.G,
    slide_parts: ["SlideRails", "SlideFittings"], ok: sourceGeometry.ok,
  };

  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType, samples: S.BLOOM_MSAA,
  });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bokeh = new BokehPass(scene, camera, {
    focus: 5, aperture: C.dof.aperture, maxblur: C.dof.maxblur,
  });
  bokeh.enabled = C.dof.enabled;
  composer.addPass(bokeh);
  const bloomStrength = visuals ? V.bloom : (bloom ? S.BLOOM_STRENGTH : 0);
  if (bloom !== false && bloomStrength > 0) composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(width, height), bloomStrength, S.BLOOM_RADIUS, S.BLOOM_THRESHOLD,
  ));
  composer.addPass(new OutputPass());

  const matrix = new THREE.Matrix4(), mid = new THREE.Vector3();
  const quat = new THREE.Quaternion(), scale = new THREE.Vector3();
  const tintColor = new THREE.Color().setStyle(V.board_color);
  const color = new THREE.Color();
  const frustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4();
  const boardBounds = [], plankBounds = [], boardPoses = [];
  const plankPoints=[],lyrics=[];
  const hingeQuat = new THREE.Quaternion(), animatedQuat = new THREE.Quaternion();
  const animatedMid = new THREE.Vector3(), rimOffset = new THREE.Vector3(.8, .9, 0);
  const boxPoints = box => [0, 1, 2, 3, 4, 5, 6, 7].map(i => [
    (i & 1) ? box.max.x : box.min.x, (i & 2) ? box.max.y : box.min.y,
    (i & 4) ? box.max.z : box.min.z,
  ]);
  for (let index = 0; index < boardSlots; index++) {
    const { mesh, mount } = boardMeshes[index];
    const board = solved.boards[index], tilt = board.tilt || 0;
    const nx = Math.sin(tilt), ny = Math.cos(tilt);
    const off = (board.off ?? 0) * side / kit.BOARD_W;
    mid.set(board.contact[0] - Math.cos(tilt) * off - nx * kit.BOARD_H / 2,
      board.contact[1] + Math.sin(tilt) * off - ny * kit.BOARD_H / 2,
      0.004 - side / 2);
    quat.setFromAxisAngle(Z_AXIS, -tilt);
    if(C.spatial?.enabled) {mid.fromArray(board.pos);quat.fromArray(board.quaternion);}
    const size=board.size??plankSize;
    scale.set(size[0] / MASTER.w, size[1] / MASTER.h, size[2] / MASTER.d);
    matrix.compose(mid, quat, scale);
    mesh.setMatrixAt(0, matrix);
    mesh.instanceMatrix.needsUpdate = true;
    const pivot = new THREE.Vector3(mid.x,mid.y-kit.BOARD_H/2,mid.z);
    if(C.spatial?.enabled)pivot.copy(boardPose(board,size[1]).pivot);
    mount.geometry.dispose();
    mount.geometry=mountGeometry(pivot,C.spatial?.enabled&&!wallMounted?pivot.z:wallZ,C.boards.rodLengthWidths*size[0],size[0],wallMounted);
    mount.updateMatrixWorld(true);
    // Include the bracket: it can still be in frame after the slab leaves it.
    mesh.geometry.computeBoundingBox();
    mount.geometry.computeBoundingBox();
    const mountBounds = mount.geometry.boundingBox.clone().applyMatrix4(mount.matrixWorld);
    plankBounds.push(mesh.geometry.boundingBox.clone().applyMatrix4(matrix));
    boardBounds.push(plankBounds[index].clone().union(mountBounds));
    boardPoses.push({ mid: mid.clone(), quat: quat.clone(), scale: scale.clone(),
      pivot, axis: new THREE.Vector3(...board.tilt_axis), mountBounds });
    plankPoints.push(boxPoints(mesh.geometry.boundingBox).map(p=>new THREE.Vector3(...p).applyMatrix4(matrix)));
    if(C.spatial?.enabled && board.lyric) {
      const text=String(board.lyric),metrics=lyricMetrics(text,1),canvas=document.createElement('canvas');
      canvas.width=metrics.textureWidth;canvas.height=metrics.textureHeight;
      const ctx=canvas.getContext('2d');ctx.font=`bold ${metrics.fontSize}px "Microsoft YaHei", sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.strokeStyle='#101114';ctx.lineWidth=12;ctx.lineJoin='round';ctx.strokeText(text,canvas.width/2,canvas.height/2);
      ctx.fillStyle='#f8f1dc';ctx.fillText(text,canvas.width/2,canvas.height/2);
      const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
      const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthTest:false,depthWrite:false,toneMapped:false}));
      sprite.renderOrder=10;lyricScene.add(sprite);lyrics.push({index,sprite,text});
    }
    const rgb = kit.BOARD_PALETTE[board.palette % kit.BOARD_PALETTE.length].rgb;
    color.setRGB(...rgb, THREE.LinearSRGBColorSpace).lerp(tintColor, V.board_tint);
    if(wallMounted)color.setStyle('#08090b');
    mesh.setColorAt(0, color);
    mesh.instanceColor.needsUpdate = true;
  }
  let disposed = false, lastSample = null;

  function update(t) {
    const ballPos = kit.sampleBall(solved, t);
    ball.position.fromArray(ballPos);
    ballGlow.position.fromArray(ballPos);
    if(C.spatial?.enabled) {
      ball.quaternion.identity();
      for(const rail of solved.segments)if(rail.kind==='ride'&&rail.spatial&&t>=rail.t0)
        ball.quaternion.premultiply(spatialRailRotation(rail,Math.min(1,(t-rail.t0)/rail.duration),kit.BALL_R));
    }
    const shadow=shadowPresentation(ballPos,kit.supportAt(solved,t),side,wallZ,C.shadow);
    ballShadow.position.fromArray(shadow.position);
    ballShadow.scale.set(shadow.radius,shadow.radius,1);
    ballShadow.material.opacity=shadow.opacity;
    if(C.spatial?.enabled)ballShadow.visible=wallMounted;
    // Absolute event age; recompute each pose so seeks never accumulate rotations.
    for (let index = 0; index < boardSlots; index++) {
      const pose = boardPoses[index], mesh = boardMeshes[index].mesh;
      const cap=C.boards.maxTilt*Math.PI/180;
      const board=solved.boards[index];
      const angle=THREE.MathUtils.clamp(wallMounted?wallSwing(t,board,C.boards):boardSpring(t,board.hits,C.boards),-cap,cap);
      hingeQuat.setFromAxisAngle(pose.axis,angle);
      animatedMid.copy(pose.mid).sub(pose.pivot).applyQuaternion(hingeQuat).add(pose.pivot);
      animatedQuat.copy(hingeQuat).multiply(pose.quat);
      matrix.compose(animatedMid, animatedQuat, pose.scale);
      mesh.setMatrixAt(0, matrix); mesh.instanceMatrix.needsUpdate = true;
      plankBounds[index].copy(mesh.geometry.boundingBox).applyMatrix4(matrix);
      boardBounds[index].copy(plankBounds[index]).union(pose.mountBounds);
      if(C.spatial?.enabled)plankPoints[index]=boxPoints(mesh.geometry.boundingBox).map(p=>new THREE.Vector3(...p).applyMatrix4(matrix));
    }
    const first = times.findIndex(onset => onset > t);
    const onSlide = solved.segments.some(seg => seg.kind === 'ride' && t >= seg.t0 && t < seg.t1);
    const ordinary = first >= 0 && !onSlide && (first === 0 ||
      solved.boards[first - 1].group === solved.boards[first].group);
    const ahead = [];
    if (ordinary || C.spatial?.enabled && first>=0) for (let index = first; index < Math.min(first + (C.spatial?.enabled?10:3), boardSlots); index++) {
      if (!C.spatial?.layeredPhrases && solved.boards[index].group !== solved.boards[first].group) break;
      ahead.push({ index, points: boxPoints(boardBounds[index]) });
    }
    const view = cameraPresentation(s => C.spatial?.enabled?kit.supportAt(solved,s):kit.sampleBall(solved, s), plan.duration,
      t, camera.aspect, kit.BALL_R, C, ahead,{ballPosition:ballPos});
    camera.position.fromArray(view.position);
    if(C.spatial?.enabled)camera.far=view.depth+(wallMounted?plankSize[2]+4:1.5);
    camera.lookAt(...view.lookAt);
    // Shift the projection, retaining the exact weighted target and viewing angle.
    camera.setViewOffset(camera.aspect, 1, view.shift[0] * camera.aspect / 2,
      -view.shift[1] / 2, camera.aspect, 1);
    camera.updateMatrixWorld(true);
    rim.target.position.copy(ball.position);
    rim.position.copy(ball.position).addScaledVector(
      camera.getWorldDirection(animatedMid), 1.2).add(rimOffset);
    rim.target.updateMatrixWorld();
    bokeh.uniforms.focus.value = view.depth;
    sun.target.position.set(ballPos[0], ballPos[1], wallZ);
    sun.position.copy(sun.target.position).add(sunOffset);
    sun.target.updateMatrixWorld();

    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    const live = visibleBoards(boardBounds, frustum).filter(index=>!C.spatial?.enabled||first<0||index<first+10);
    for (let index = 0; index < boardSlots; index++) {
      const { mesh, mount, halo } = boardMeshes[index];
      mesh.visible = mount.visible = false;
      if(halo)halo.visible=false;
    }
    const litBoards=[];
    for (const index of live) {
      const { mesh, mount, halo } = boardMeshes[index];
      mesh.visible = mount.visible = true;
      mesh.getColorAt(0, color);
      if(wallMounted) {
        const pulse=notePulse(t,times[index]),light=new THREE.Color(NOTE_LIGHTS[solved.boards[index].n-1]);
        setInstanceGlow(mesh.geometry,0,light.toArray(),pulse*C.boards.glowStrength);
        halo.visible=pulse>0;halo.material.opacity=pulse*.28;
        if(pulse>0)litBoards.push({board:solved.boards[index],pulse});
      } else setInstanceGlow(mesh.geometry, 0, kit.boardGlowColor([color.r, color.g, color.b]),
        kit.glowAt(solved, t, index) * V.glow * C.boards.glowStrength);
      mesh.geometry.getAttribute("aGlowColor").needsUpdate = true;
      mesh.geometry.getAttribute("aGlow").needsUpdate = true;
    }
    litBoards.sort((a,b)=>b.pulse-a.pulse);
    spillLights.forEach((light,index)=>{
      const hit=litBoards[index];light.intensity=hit?hit.pulse*C.boards.glowStrength*.18:0;
      if(hit){const b=hit.board,bw=b.size[0];light.color.setStyle(NOTE_LIGHTS[b.n-1]);light.distance=bw*9;
        light.position.set(b.contact[0],b.contact[1]+bw*.25,b.contact[2]+bw*.45);}
    });
    const labelBounds=[];
    if(C.spatial?.enabled) {
      for(const label of lyrics) {
        label.sprite.visible=false;
        if(!live.includes(label.index))continue;
        const anchor=new THREE.Vector3(...solved.boards[label.index].contact).project(camera);
        const {halfH,halfW,gap}=lyricMetrics(label.text,camera.aspect);
        const corners=plankPoints[label.index].map(p=>p.clone().project(camera));
        const x=(Math.min(...corners.map(p=>p.x))+Math.max(...corners.map(p=>p.x)))/2;
        const bottom=Math.min(...corners.map(p=>p.y));
        // Each lyric stays below its own animated plank at every output size.
        const y=bottom-gap-halfH,poly=rectangle(x,y,halfW,halfH);
        const position=new THREE.Vector3(x,y,anchor.z).unproject(camera);
        label.sprite.position.copy(position);label.sprite.scale.set(position.distanceTo(new THREE.Vector3(x+halfW*2,y,anchor.z).unproject(camera)),
          position.distanceTo(new THREE.Vector3(x,y+halfH*2,anchor.z).unproject(camera)),1);
        label.sprite.visible=true;labelBounds.push({index:label.index,polygon:poly});
      }
    }
    const visibleRails=[];
    for(const [index,rail] of channelMeshes.entries()) {
      const visible=railVisible(rail.seg,t,wallMounted);
      rail.clock.value=t-rail.seg.t0;
      for(const mesh of rail.meshes)mesh.visible=visible;
      if(wallMounted) {
        const riding=t>=rail.seg.t0-.2&&t<=rail.seg.t1+.2?1:0;
        for(const mesh of rail.meshes)mesh.material.emissiveIntensity=.08+.3*riding;
      }
      for(const bead of rail.beads) {
        bead.mesh.visible=visible;
        bead.mesh.material.emissiveIntensity=passageGlow(t,bead.event.t,C.tracks.beadSeconds)*2;
      }
      if(visible && rail.meshes.some(mesh=>frustum.intersectsSphere(mesh.geometry.boundingSphere)))visibleRails.push(index);
    }
    const focal = 1 / (2 * camera.aspect * Math.tan(camera.fov * Math.PI / 360));
    framing.ball_width = 2 * kit.BALL_R * focal / Math.sqrt(view.depth ** 2 - kit.BALL_R ** 2);
    lastSample = { t, ball: ballPos, target: view.target, camera: view.position,
      shadow, focus: view.depth, horizontal_span: view.horizontalSpan, boards_across: view.boardsAcross,
      ball_screen: view.ballScreen, projection_shift: view.shift, travel: view.trend,
      ordinary_group: ordinary, upcoming: ahead.map(board => board.index),
      rest: solved.silence.some(r=>t>=r.t0-1e-9&&t<r.t1-1e-9), visible_rails:visibleRails,
      protected_boards: view.protectedBoards,
      labels:labelBounds, visible: live.map(index => ({ index, time: times[index] })) };
    if(wallMounted)lastSample.board_lights=live.map(index=>({index,n:solved.boards[index].n,color:NOTE_LIGHTS[solved.boards[index].n-1],
      pulse:notePulse(t,times[index]),base:'#08090b'}));
  }

  function render() {
    composer.render();
    if(lyrics.length) {
      const clear=renderer.autoClear;renderer.autoClear=false;renderer.clearDepth();renderer.render(lyricScene,camera);renderer.autoClear=clear;
    }
  }
  function measureFrame() {
    ball.updateMatrixWorld(true);
    const vertex = new THREE.Vector3();
    const positions = ball.geometry.getAttribute("position");
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i).applyMatrix4(ball.matrixWorld).project(camera);
      minX = Math.min(minX, vertex.x); maxX = Math.max(maxX, vertex.x);
      minY = Math.min(minY, vertex.y); maxY = Math.max(maxY, vertex.y);
    }
    const future = lastSample.upcoming.map(index => {
      const projected = C.spatial?.enabled?plankPoints[index].map(p=>p.clone().project(camera).toArray()):boxPoints(boardBounds[index]).map(p => vertex.fromArray(p).project(camera).toArray());
      return { index, complete: projected.every(p => p[0] >= -1 && p[0] <= 1 && p[1] >= -1 && p[1] <= 1 && p[2] >= -1 && p[2] <= 1) };
    });
    const planks=lastSample.visible.map(({index})=>{
      const points=C.spatial?.enabled?plankPoints[index].map(p=>p.clone().project(camera).toArray()):boxPoints(plankBounds[index]).map(p=>vertex.fromArray(p).project(camera).toArray());
      const polygon=clipScreen(hull(points));
      return {index,polygon,min:[0,1].map(k=>Math.max(-1,Math.min(...points.map(p=>p[k])))),
        max:[0,1].map(k=>Math.min(1,Math.max(...points.map(p=>p[k]))))};
    }).filter(b=>b.max[0]>b.min[0]&&b.max[1]>b.min[1]);
    const overlaps=[];
    for(let i=0;i<planks.length;i++)for(let j=0;j<i;j++){
      const a=planks[i],b=planks[j];
      if(intersects(a.polygon,b.polygon))overlaps.push([a.index,b.index]);
    }
    const ballOcclusions=[];
    const ballPolygon=Array.from({length:32},(_,i)=>[(minX+maxX)/2+(maxX-minX)/2*Math.cos(i*Math.PI/16),
      (minY+maxY)/2+(maxY-minY)/2*Math.sin(i*Math.PI/16)]);
    const raycaster=new THREE.Raycaster(),sphere=new THREE.Sphere(ball.position,kit.BALL_R),hit=new THREE.Vector3();
    for(const plank of planks)if(intersects(plank.polygon,ballPolygon)) {
      let occluded=false;
      for(let x=1;x<8&&!occluded;x++)for(let y=1;y<8;y++) {
        raycaster.setFromCamera(new THREE.Vector2(minX+(maxX-minX)*x/8,minY+(maxY-minY)*y/8),camera);
        if(!raycaster.ray.intersectSphere(sphere,hit))continue;
        const distance=hit.distanceTo(raycaster.ray.origin),hits=raycaster.intersectObject(boardMeshes[plank.index].mesh,false);
        if(hits.some(h=>h.distance<distance-1e-5)){occluded=true;break;}
      }
      if(occluded)ballOcclusions.push(plank.index);
    }
    const labelOverlaps=[];
    for(let i=0;i<lastSample.labels.length;i++) {
      const a=lastSample.labels[i];
      for(let j=0;j<i;j++)if(intersects(a.polygon,lastSample.labels[j].polygon))labelOverlaps.push([a.index,lastSample.labels[j].index]);
      if(intersects(a.polygon,ballPolygon))labelOverlaps.push([a.index,'ball']);
      for(const b of planks)if(intersects(a.polygon,b.polygon))labelOverlaps.push([a.index,`board:${b.index}`]);
    }
    return { ...lastSample, plank_screen_bounds:planks, plank_screen_overlaps:overlaps,
      ball_occluded_by:ballOcclusions,label_overlaps:labelOverlaps,
      ball_screen:[(minX+maxX+2)/4,(2-minY-maxY)/4],
      ball_width_fraction: (maxX - minX) / 2,
      ball_inside: minX >= -1 && maxX <= 1 && minY >= -1 && maxY <= 1,
      future_boards: future, future_complete: future.filter(b => b.complete).length };
  }
  function setSize(nextWidth, nextHeight) {
    camera.aspect = nextWidth / nextHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(nextWidth, nextHeight, false);
    composer.setSize(nextWidth, nextHeight);
    // BokehPass stores aspect in its shader as well as in the camera.
    bokeh.uniforms.aspect.value = camera.aspect;
  }
  function stats() {
    return {
      style: "music-machine", board_slots: boardSlots, mount_slots: boardSlots,
      channel_slots: channelMeshes.length, channels: solved.channels.length,
      tracks: solved.audit.tracks, spatial: solved.audit.spatial,
      visibility: "camera-frustum", groups: solved.groups.length, asset: "reference_music_machine.glb",
      layout: { seed: solved.seed, format: solved.format }, geometry: geometryReport,
      visuals: V, presentation: C, framing,
      camera: { type: "PerspectiveCamera", fov: camera.fov,
        downward_tilt: C.camera.downwardTilt, max_boards_across: C.camera.maxBoardsAcross, gaussian_past: C.camera.pastWindow, gaussian_future: C.camera.futureWindow },
      audio: { voice: "json-synthesised", vocals: false },
      sample: lastSample,
      render: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
    };
  }

  /**
   * Release everything this scene owns.
   *
   * The editor rebuilds the scene on every look change, so anything left here
   * accumulates: GPU geometry, the GLB master parts (which are *not* in the
   * scene -- only their clones are), the cloned and re-tinted materials, the
   * wood map and its source image, the panel canvas, the environment render
   * target, the shadow map render targets and the composer's own buffers.
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    const seen = new Set();
    const releaseTexture = (texture) => {
      if (!texture || seen.has(texture)) return;
      seen.add(texture);
      const image = texture.image;
      if (image && typeof image.close === "function") image.close();  // ImageBitmap
      texture.dispose();
    };
    const releaseMaterial = (material) => {
      if (!material || seen.has(material)) return;
      seen.add(material);
      for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap",
        "emissiveMap", "aoMap", "alphaMap", "envMap", "lightMap"]) {
        releaseTexture(material[key]);
      }
      material.dispose();
    };
    scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      const materials = object.material === undefined ? []
        : (Array.isArray(object.material) ? object.material : [object.material]);
      materials.forEach(releaseMaterial);
      if (object.dispose && typeof object.dispose === "function"
          && object.isInstancedMesh) object.dispose();
    });
    // the GLB parts themselves are not in the scene: their clones are, and a
    // geometry/material change must not leave the loaded masters behind
    for (const part of Object.values(parts)) {
      if (part.geometry) part.geometry.dispose();
      releaseMaterial(part.material);
    }
    releaseMaterial(boardMaterial);
    releaseMaterial(goldMaterial);
    releaseTexture(panelTexture);
    for(const label of lyrics)releaseMaterial(label.sprite.material);
    lyricScene.clear();
    releaseTexture(envTarget.texture);
    envTarget.dispose();
    for (const light of [sun, fill, rim]) {
      if (light && light.shadow && typeof light.shadow.dispose === "function") {
        light.shadow.dispose();
      }
    }
    for (const pass of composer.passes) pass.dispose();
    composer.dispose();
    scene.clear();
  }

  return {
    scene, camera, update, render, stats, dispose, setSize, framing, measureFrame,
    layout: solved,
    constants: kit,
    visuals: V,
  };
}
