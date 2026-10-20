/**
 * three.js scene for the realtime renderer: the same *plan* and the same
 * established ball3d look as ``render_scene.py`` (dark suspended boards, a
 * pearl ball, long soft shadows, a coloured floor halo at the current landing),
 * rebuilt for throughput:
 *
 *  * one ``InstancedMesh`` for every board, one for every support post and one
 *    for every star particle, each with **one** shared material; per-instance
 *    glow is an instanced attribute injected into the standard shader, so boards
 *    keep independent glow (a board that just landed glows, the rest stay dark)
 *    without 335 materials.
 *  * the instance count is a bounded pool derived from the plan, not a guess:
 *    ``pool.mjs`` proves it always contains the ball's board, the board it is
 *    hopping to, everything inside the shadow frustum and every board that can
 *    still be glowing.
 *
 * The plan is Y-up, so plan coordinates are used **directly**; only the Blender
 * offsets copied from ``render_scene.py`` cross through
 * ``motion.blenderToPlan()`` (Blender ``(x, y, z)`` is plan ``(x, z, y)``), which
 * is what turns Blender's camera offset ``(-3, -6, 5.5)`` into the plan's
 * ``(-3, 5.5, -6)``.
 *
 * Motion is analytic and deterministic: ``update(t)`` is a pure function of the
 * plan and ``t``, called with exactly ``i / fps``.  Nothing here uses
 * ``Math.random`` or a clock.
 */

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import {
  blenderToPlan,
  cameraPlacement,
  groundBounds,
  orthoFrustum,
  sampleBall,
  sampleTrack,
} from "./motion.mjs";
import * as S from "./style.mjs";
import * as P from "./pool.mjs";

const BLACK = [0, 0, 0];

/** Linear-RGB array -> three.js Color without an sRGB conversion. */
function linearColor(rgb) {
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);
}

function inject(source, marker, replacement, what) {
  if (!source.includes(marker)) {
    throw new Error(`three.js shader chunk ${marker} (${what}) is missing; ` +
      "the instanced glow injection cannot be applied");
  }
  return source.replace(marker, replacement);
}

/**
 * Add per-instance emissive to a standard material.
 *
 * ``InstancedMesh.setColorAt`` already multiplies the diffuse colour per
 * instance; emissive has no such channel, so two instanced attributes are
 * injected: ``aGlowColor`` (vec3) and ``aGlow`` (float).  The replacements are
 * checked, so a three.js upgrade that renames a chunk fails loudly instead of
 * quietly dropping the glow.
 */
function withInstanceGlow(material) {
  material.onBeforeCompile = (shader) => {
    const vertex = [
      "attribute vec3 aGlowColor;",
      "attribute float aGlow;",
      "varying vec3 vGlowColor;",
      "varying float vGlow;",
    ].join("\n");
    const fragment = [
      "varying vec3 vGlowColor;",
      "varying float vGlow;",
    ].join("\n");
    shader.vertexShader = inject(
      shader.vertexShader, "#include <common>", `#include <common>\n${vertex}`,
      "vertex common",
    );
    shader.vertexShader = inject(
      shader.vertexShader, "#include <begin_vertex>",
      "#include <begin_vertex>\nvGlowColor = aGlowColor;\nvGlow = aGlow;",
      "begin_vertex",
    );
    shader.fragmentShader = inject(
      shader.fragmentShader, "#include <common>", `#include <common>\n${fragment}`,
      "fragment common",
    );
    shader.fragmentShader = inject(
      shader.fragmentShader, "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlowColor * vGlow;",
      "emissivemap_fragment",
    );
  };
  material.customProgramCacheKey = () => "ball3d-instance-glow";
  return material;
}

function instanceGlowAttributes(geometry, count) {
  geometry.setAttribute(
    "aGlowColor", new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
  );
  geometry.setAttribute(
    "aGlow", new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
  );
}

/** Parked far below the floor at a degenerate scale: invisible, no shadow. */
const HIDDEN = new THREE.Matrix4()
  .makeTranslation(0, -1000, 0)
  .multiply(new THREE.Matrix4().makeScale(1e-4, 1e-4, 1e-4));

/**
 * Build the scene and return its controller.
 *
 * @param {object} options
 * @param {THREE.WebGLRenderer} options.renderer
 * @param {object} options.plan  a ``ball3d-plan-v1`` object
 * @param {number} options.width
 * @param {number} options.height
 * @param {boolean} options.bloom
 */
export function buildScene({ renderer, plan, width, height, bloom }) {
  const c = plan.constants;
  const landings = plan.landings;
  const times = landings.map((landing) => landing.t);
  // A board glows while its age is below glow_life * 3 (render_scene.py).
  const glowWindow = c.glow_life * S.GLOW_WINDOW_FACTOR;

  const scene = new THREE.Scene();
  // Blender->plan swaps two axes (a reflection). Reflect the render world and
  // camera Z together to retain Blender's screen direction and face winding.
  scene.scale.z = -1;
  scene.background = linearColor([
    S.BG[0] * S.BG_STRENGTH, S.BG[1] * S.BG_STRENGTH, S.BG[2] * S.BG_STRENGTH,
  ]);

  // --- camera: same orthographic oblique view as Blender --------------------
  const frustum = orthoFrustum(width, height, S.ORTHO_SCALE);
  const camera = new THREE.OrthographicCamera(
    frustum.left, frustum.right, frustum.top, frustum.bottom,
    S.CAMERA_NEAR, S.CAMERA_FAR,
  );
  camera.up.set(0, 1, 0);

  // --- floor: one quad, sized from the plan so any song length is covered ----
  const bounds = groundBounds(plan, S.GROUND_MARGIN);
  const floorGeometry = new THREE.PlaneGeometry(
    bounds.x1 - bounds.x0, bounds.z1 - bounds.z0,
  );
  floorGeometry.rotateX(-Math.PI / 2);
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: linearColor(S.GROUND_COLOR), roughness: S.GROUND_ROUGHNESS, metalness: 0.0,
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.position.set((bounds.x0 + bounds.x1) / 2, 0, (bounds.z0 + bounds.z1) / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  // --- lights --------------------------------------------------------------
  // Ambient matches Blender's world: radiance BG * strength means irradiance
  // pi * BG * strength, and three.js's AmbientLight contributes intensity/pi.
  const ambient = new THREE.AmbientLight(linearColor(S.BG), S.BG_STRENGTH * Math.PI);
  scene.add(ambient);

  const sunDirection = S.sunDirectionPlan();
  const sunOffset = S.sunLightOffset(sunDirection);
  const sun = new THREE.DirectionalLight(0xffffff, S.SUN_ENERGY);
  sun.castShadow = true;
  sun.shadow.mapSize.set(S.SHADOW_MAP, S.SHADOW_MAP);
  sun.shadow.camera.left = -S.SHADOW_EXTENT;
  sun.shadow.camera.right = S.SHADOW_EXTENT;
  sun.shadow.camera.top = S.SHADOW_EXTENT;
  sun.shadow.camera.bottom = -S.SHADOW_EXTENT;
  sun.shadow.camera.near = S.SUN_NEAR;
  sun.shadow.camera.far = S.SUN_FAR;
  sun.shadow.normalBias = S.SHADOW_NORMAL_BIAS;
  sun.shadow.radius = 3; // ~ the 1.5 deg sun disc, softened for PCF
  scene.add(sun);
  scene.add(sun.target);

  // Soft fill: a shadowless point light at a fixed offset from the track, which
  // is what a Blender AREA light at a fixed offset amounts to.  A Lambertian
  // area emitter of power P gives irradiance ~ P/(pi d^2), so the intensity is
  // P/pi and the decay is the default inverse square.
  const fill = new THREE.PointLight(0xffffff, S.FILL_ENERGY / Math.PI, 0, 2);
  const fillOffset = blenderToPlan(S.FILL_OFFSET_BLENDER);
  scene.add(fill);

  // Coloured point light at the current landing -> the coloured floor halo.
  const spark = new THREE.PointLight(0xffffff, S.wattsToCandela(S.SPARK_IDLE), 0, 2);
  scene.add(spark);
  const padHue = S.paletteHue(plan.ref_midi);
  const landingHues = landings.map((landing) => S.paletteHue(landing.midi));

  // --- boards + posts: bounded pools, one draw call each --------------------
  const boardOptions = { glowWindow };
  const boardSlots = P.assertPoolFits(P.boardPoolSize(times, boardOptions), "board");
  const boardGeometry = new THREE.BoxGeometry(c.board_w, c.board_h, c.board_d);
  instanceGlowAttributes(boardGeometry, boardSlots);
  const boardMaterial = withInstanceGlow(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.45, metalness: 0.1,
  }));
  const boards = new THREE.InstancedMesh(boardGeometry, boardMaterial, boardSlots);
  // The pool moves along the whole song; cached instance bounds would go stale.
  boards.frustumCulled = false;
  boards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  boards.castShadow = true;
  boards.receiveShadow = true;
  scene.add(boards);

  const postGeometry = new THREE.CylinderGeometry(
    c.support_r, c.support_r, 1, c.support_segs,
  );
  const postMaterial = new THREE.MeshStandardMaterial({
    color: linearColor(S.POST_COLOR), roughness: 0.6, metalness: 0.4,
  });
  const posts = new THREE.InstancedMesh(postGeometry, postMaterial, boardSlots);
  posts.frustumCulled = false;
  posts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  posts.castShadow = true;
  scene.add(posts);

  // --- pearl ball -----------------------------------------------------------
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(c.ball_r, 48, 24),
    new THREE.MeshPhysicalMaterial({
      color: linearColor(S.PEARL_COLOR),
      roughness: S.PEARL_ROUGHNESS,
      metalness: 0.0,
      emissive: linearColor(S.PEARL_EMISSION),
      emissiveIntensity: 0.0,
      clearcoat: S.PEARL_COAT,
      clearcoatRoughness: S.PEARL_COAT_ROUGHNESS,
      ior: S.PEARL_IOR,
    }),
  );
  ball.castShadow = true;
  scene.add(ball);
  const pearlMaterial = ball.material;

  // --- star bursts: one instanced octahedron per star -----------------------
  const burstSlots = P.assertPoolFits(
    P.burstPoolSize(times, c.hop_life, S.STARS_PER_LANDING), "particle",
  );
  const starGeometry = new THREE.OctahedronGeometry(1);
  instanceGlowAttributes(starGeometry, burstSlots);
  const starMaterial = withInstanceGlow(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.3, metalness: 0.0,
  }));
  const stars = new THREE.InstancedMesh(starGeometry, starMaterial, burstSlots);
  stars.frustumCulled = false;
  stars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(stars);

  // Per-landing burst layout, computed once from the plan (deterministic).
  const burstParticles = landings.map((landing) => S.burstParticles(landing, c.ball_r));
  const burstStars = S.STARS_PER_LANDING;
  const maxBurstWindow = Math.max(1, Math.floor(burstSlots / burstStars));

  // --- post-processing: compositor FOG_GLOW -> UnrealBloomPass --------------
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
  const scratchScale = new THREE.Vector3();
  const scratchPosition = new THREE.Vector3();
  const noRotation = new THREE.Quaternion();
  const scratchColor = new THREE.Color();

  function place(instanced, index, x, y, z, sx, sy, sz) {
    scratchPosition.set(x, y, z);
    scratchScale.set(sx, sy, sz);
    matrix.compose(scratchPosition, noRotation, scratchScale);
    instanced.setMatrixAt(index, matrix);
  }

  function setColor(instanced, index, rgb) {
    instanced.setColorAt(
      index, scratchColor.setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace),
    );
  }

  function setGlow(glowColorAttr, glowAttr, index, rgb, strength) {
    glowColorAttr.array[index * 3] = rgb[0];
    glowColorAttr.array[index * 3 + 1] = rgb[1];
    glowColorAttr.array[index * 3 + 2] = rgb[2];
    glowAttr.array[index] = strength;
  }

  /**
   * Apply the analytic state of ``t`` -- the same state
   * ``render_scene.apply_frame`` applies to each Blender frame.
   */
  function update(t) {
    const ballPos = sampleBall(plan, t);
    ball.position.set(ballPos[0], ballPos[1], ballPos[2]);

    const pool = P.boardPool(times, t, boardOptions);
    const indices = P.poolIndices(pool);
    const boardGlowColor = boards.geometry.getAttribute("aGlowColor");
    const boardGlow = boards.geometry.getAttribute("aGlow");
    let recent = 0;

    for (let slot = 0; slot < boardSlots; slot += 1) {
      const index = slot < indices.length ? indices[slot] : null;
      if (index === null) {
        boards.setMatrixAt(slot, HIDDEN);
        posts.setMatrixAt(slot, HIDDEN);
        setColor(boards, slot, BLACK);
        boardGlow.array[slot] = 0;
        continue;
      }
      const spec = index === -1 ? plan.pad : plan.boards[index];
      const midi = index === -1 ? plan.ref_midi : plan.boards[index].midi;
      const x = spec.pos[0];
      const topY = spec.top_y;
      const z = spec.pos[2];
      place(boards, slot, x, topY - c.board_h * 0.5, z, 1, 1, 1);

      // support post: from the floor up to the board underside
      const postHeight = topY - c.board_h;
      if (postHeight <= 0.05) {
        throw new Error(`support post for board ${index} would be ${postHeight} m tall`);
      }
      place(posts, slot, x, postHeight * 0.5, z, 1, postHeight, 1);

      setColor(boards, slot, S.boardBodyColor(midi));
      // The start pad never glows: it is a board, not a landing.
      const strength = index === -1
        ? 0.0 : S.glowStrength(t - times[index], c.glow_life);
      setGlow(boardGlowColor, boardGlow, slot, S.glowColor(midi), strength);
      recent = Math.max(recent, strength);
    }
    boards.instanceMatrix.needsUpdate = true;
    if (boards.instanceColor) boards.instanceColor.needsUpdate = true;
    posts.instanceMatrix.needsUpdate = true;
    boardGlowColor.needsUpdate = true;
    boardGlow.needsUpdate = true;

    // star bursts of the landings that are still alive
    const burst = P.burstPool(times, t, c.hop_life);
    const starGlowColor = stars.geometry.getAttribute("aGlowColor");
    const starGlow = stars.geometry.getAttribute("aGlow");
    for (let slot = 0; slot < maxBurstWindow; slot += 1) {
      const live = slot < burst.count;
      const index = burst.lo + slot;
      const base = live ? landings[index].ball_pos : null;
      const dt = live ? t - times[index] : 0;
      const burstScale = live ? S.burstScale(dt, c.hop_life) : 0;
      const lift = live ? S.burstRise(dt) : 0;
      const color = live ? S.glowColor(landings[index].midi) : BLACK;
      for (let k = 0; k < burstStars; k += 1) {
        const star = slot * burstStars + k;
        if (!live) {
          stars.setMatrixAt(star, HIDDEN);
          setColor(stars, star, BLACK);
          starGlow.array[star] = 0;
          continue;
        }
        const particle = burstParticles[index][k];
        const s = Math.max(particle.size * burstScale, 0.0001);
        place(stars, star,
          base[0] + particle.offset[0],
          base[1] + particle.offset[1] + lift,
          base[2] + particle.offset[2],
          s, s, s);
        setColor(stars, star, color);
        // The Blender burst fades by *scale*, not by emission strength.
        setGlow(starGlowColor, starGlow, star, color, S.STAR_STRENGTH);
      }
    }
    stars.instanceMatrix.needsUpdate = true;
    if (stars.instanceColor) stars.instanceColor.needsUpdate = true;
    starGlowColor.needsUpdate = true;
    starGlow.needsUpdate = true;

    // a glossy pearl, not a glowing white disk
    pearlMaterial.emissiveIntensity = S.pearlGlow(recent);

    // camera + fill follow the smooth track line, never the hop's parabola
    const view = cameraPlacement(plan, t, S.CAM_OFFSET_BLENDER, S.CAM_LOOKAHEAD_BLENDER);
    camera.position.set(view.location[0], view.location[1], -view.location[2]);
    camera.lookAt(view.target[0], view.target[1], -view.target[2]);

    const track = sampleTrack(plan, t);
    fill.position.set(
      track[0] + fillOffset[0], track[1] + fillOffset[1], track[2] + fillOffset[2],
    );

    // sun: fixed direction, shadow frustum snapped to the shadow texel grid so
    // the shadows do not crawl while the camera follows the ball
    const snapX = S.snapToTexel(ballPos[0]);
    const snapZ = S.snapToTexel(ballPos[2]);
    sun.target.position.set(snapX, 0, snapZ);
    sun.position.set(snapX + sunOffset[0], sunOffset[1], snapZ + sunOffset[2]);
    sun.target.updateMatrixWorld();

    // coloured halo: the landing just reached, else the pad hue
    const index = P.activeLanding(times, t);
    const hue = index >= 0 ? landingHues[index] : padHue;
    const age = index >= 0 ? Math.max(0.0, t - times[index]) : 0.0;
    const sparkColor = S.hsv(hue, 0.85, 1.0);
    spark.color.setRGB(
      sparkColor[0], sparkColor[1], sparkColor[2], THREE.LinearSRGBColorSpace,
    );
    spark.intensity = S.wattsToCandela(S.sparkEnergy(age));
    spark.position.set(track[0], S.SPARK_HEIGHT, track[2] + S.SPARK_LANE);
  }

  function render() {
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  /** Mirror of the Blender renderer's "[ball3d] stats:" line. */
  function stats() {
    return {
      board_slots: boardSlots,
      star_slots: burstSlots,
      bursts_per_frame: maxBurstWindow,
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
    if (composer) composer.dispose();
  }

  return { scene, camera, update, render, stats, dispose };
}
