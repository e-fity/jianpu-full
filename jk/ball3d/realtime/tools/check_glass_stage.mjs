import { chromium } from "playwright-core";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:8011";
const out = new URL(`../../out/${process.argv[2] || "glass_stage"}/`, import.meta.url);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1550, height: 1450 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${base}/editor`);
  await page.waitForFunction(() => window.__editor);
  const upload = await page.request.post(`${base}/api/editor/import?name=10_notes.json`, {
    data: fs.readFileSync("D:/Downloads/10_notes.json"), headers: { "content-type": "application/json" },
  });
  const imported = await upload.json(); assert.equal(imported.ok, true);
  await page.evaluate(async id => { await window.__editor.loadSong({ import: id }); }, imported.import);
  await page.waitForFunction(() => window.__editor.state.scene, null, { timeout: 120000 });
  await page.evaluate(() => {
    window.__editor.pause(); window.__editor.setTime(20.5);
    window.__layoutBeforeVisual = window.__editor.state.layout;
  });
  const folder = page.getByText("透视跟随镜头", { exact: true });
  await folder.click();
  const fov = page.getByText("视野角 FOV", { exact: true }).locator("..").locator('input[type="number"]');
  await fov.fill("39"); await fov.press("Enter"); await fov.blur();
  await page.waitForFunction(() => window.__editor.state.scene?.camera.fov === 39);
  const properties = await page.evaluate(() => window.__editor.state.presentationGui.controllersRecursive().map(c => c.property));
  assert.ok(properties.includes("downwardTilt") && properties.includes("maxBoardsAcross"));
  for (const key of ["pastWindow", "futureWindow", "travelOffset", "attenuationColor", "emissiveIntensity", "rimIntensity", "pressAngle", "springFrequency", "springDamping"])
    assert.ok(properties.includes(key), `missing control: ${key}`);
  for (const key of ["tiltFromAbove", "ahead", "behind", "appearBefore", "fadeAfter", "smoothWindow", "lead"])
    assert.ok(!properties.includes(key), `removed control still present: ${key}`);
  const unchanged = await page.evaluate(() => window.__layoutBeforeVisual === window.__editor.state.layout);
  assert.equal(unchanged, true, "visual GUI must not re-solve the trajectory");
  await fov.fill("37"); await fov.press("Enter"); await fov.blur();
  await page.waitForFunction(() => window.__editor.state.scene?.camera.fov === 37);
  const downwardTilt = page.getByText("向下俯角（度）", { exact: true }).locator("..").locator('input[type="number"]');
  for (const angle of [20, 30, 25]) {
    await downwardTilt.fill(String(angle)); await downwardTilt.press("Enter"); await downwardTilt.blur();
    await page.waitForFunction(value => window.__editor.state.scene?.stats().camera.downward_tilt === value, angle);
    const actual = await page.evaluate(() => {
      const camera = window.__editor.state.scene.camera;
      return -Math.asin(camera.getWorldDirection(camera.position.clone()).y) * 180 / Math.PI;
    });
    assert.ok(Math.abs(actual - angle) < 1e-8);
  }
  assert.equal(await page.evaluate(() => window.__layoutBeforeVisual === window.__editor.state.layout), true);
  const visual = await page.evaluate(() => {
    const built = window.__editor.state.scene, config = window.__editor.state.presentation;
    let ball;
    built.scene.traverse(object => {
      if (object.isMesh && object.material?.isMeshPhysicalMaterial && object.geometry.type === "SphereGeometry") ball = object;
    });
    const material = ball.material;
    const planks = built.scene.children.filter(object => object.isInstancedMesh);
    const index = 37, plank = planks[index], onset = built.layout.boards[index].t;
    plank.geometry.computeBoundingBox();
    const box = plank.geometry.boundingBox, local = plank.position.clone().set(0, 0, box.max.z);
    const rear = plank.position.clone().set(0, 0, box.min.z), matrix = plank.matrix.clone();
    const poseAt = t => {
      built.update(t); plank.getMatrixAt(0, matrix);
      return { front: local.clone().applyMatrix4(matrix).toArray(), rear: rear.clone().applyMatrix4(matrix).toArray() };
    };
    const period = 1/config.boards.springFrequency;
    const base = poseAt(onset), down = poseAt(onset+period/4), up = poseAt(onset+period*3/4), again = poseAt(onset+period*5/4);
    const replay = poseAt(onset+period/4);
    // Scan the full song at 10 fps for ordinary groups, without rendering.
    const failures = [];
    let checked = 0, completeThree = 0, inside = true;
    for (let frame=0; frame<Math.ceil(built.layout.duration*10); frame++) {
      built.update(frame/10);
      const sample = built.measureFrame();
      inside &&= sample.ball_inside;
      if (sample.upcoming.length < 2) continue;
      checked++;
      if (sample.future_complete >= 3) completeThree++;
      if (sample.future_complete < 2) failures.push({t:frame/10,upcoming:sample.upcoming,protected:sample.protected_boards});
    }
    window.__editor.setTime(20.5);
    return { material: { transmission:material.transmission, attenuationColor:material.attenuationColor.getHexString(),
      attenuationDistance:material.attenuationDistance, emissiveIntensity:material.emissiveIntensity },
      spring:{onset,base,down,up,again,replay}, whole_song:{checked,completeThree,failures,inside} };
  });
  assert.equal(visual.material.transmission,1);
  assert.equal(visual.material.attenuationColor,"eee9df");
  assert.ok(visual.material.emissiveIntensity > 0 && visual.material.emissiveIntensity < .1);
  assert.ok(visual.spring.down.front[1] < visual.spring.base.front[1]);
  assert.ok(visual.spring.up.front[1] > visual.spring.base.front[1]);
  assert.ok(visual.spring.again.front[1] < visual.spring.base.front[1]);
  assert.deepEqual(visual.spring.down, visual.spring.replay);
  for(const pose of [visual.spring.down,visual.spring.up,visual.spring.again])
    assert.ok(Math.hypot(...pose.rear.map((v,i)=>v-visual.spring.base.rear[i])) < 2e-6);
  await page.getByText("保存 config.json", { exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("已保存 config.json"));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: fileURLToPath(new URL("preview_gui.png", out)), fullPage: true });
  const stats = await page.evaluate(() => window.__editor.state.scene.stats());
  const result = { ok: errors.length === 0, errors, lil_gui: true, fov_changed: [37, 39, 37], downward_angles_checked: [20, 30, 25],
    same_layout_object: unchanged, controls: properties, visual, stats };
  fs.writeFileSync(new URL("gui_check.json", out), JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, lil_gui: true, same_layout_object: unchanged }));
} finally { await browser.close(); }
