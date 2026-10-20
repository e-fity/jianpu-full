/**
 * Per-instance emissive for an ``InstancedMesh`` standard material.
 *
 * ``setColorAt`` already multiplies the diffuse colour per instance, but there
 * is no per-instance emissive channel.  Two instanced attributes are injected
 * instead -- ``aGlowColor`` (vec3) and ``aGlow`` (float) -- so a board that just
 * landed glows in its *own* colour while every other board stays dark, even
 * though they all share one material and one draw call.
 *
 * The two shader-chunk markers are checked, so a three.js upgrade that renames
 * a chunk fails loudly instead of quietly dropping the glow.
 */

import * as THREE from "three";

function inject(source, marker, replacement, what) {
  if (!source.includes(marker)) {
    throw new Error(`three.js shader chunk ${marker} (${what}) is missing; ` +
      "the instanced glow injection cannot be applied");
  }
  return source.replace(marker, replacement);
}

/** Return ``material`` with per-instance emissive added (mutates in place). */
export function withInstanceGlow(material) {
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
    shader.fragmentShader = inject(shader.fragmentShader, "#include <map_fragment>",
      "#include <map_fragment>\nfloat woodGrain=dot(diffuseColor.rgb,vec3(0.2126,0.7152,0.0722)); diffuseColor.rgb=vec3(woodGrain);", "wood grain");
    shader.fragmentShader = inject(
      shader.fragmentShader, "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlowColor * vGlow * woodGrain;",
      "emissivemap_fragment",
    );
  };
  material.customProgramCacheKey = () => "ball3d-instance-glow";
  return material;
}

/** Allocate the two instanced attributes on ``geometry`` for ``count`` slots. */
export function instanceGlowAttributes(geometry, count) {
  geometry.setAttribute(
    "aGlowColor", new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
  );
  geometry.setAttribute(
    "aGlow", new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
  );
}

/** Write one instance's glow colour and strength. */
export function setInstanceGlow(geometry, index, rgb, strength) {
  const color = geometry.getAttribute("aGlowColor");
  const glow = geometry.getAttribute("aGlow");
  color.array[index * 3] = rgb[0];
  color.array[index * 3 + 1] = rgb[1];
  color.array[index * 3 + 2] = rgb[2];
  glow.array[index] = strength;
}

/** Mark both attributes dirty after a batch of writes. */
export function markInstanceGlow(geometry) {
  geometry.getAttribute("aGlowColor").needsUpdate = true;
  geometry.getAttribute("aGlow").needsUpdate = true;
}
