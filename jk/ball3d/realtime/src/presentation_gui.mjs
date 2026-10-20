import limits from "../presentation_limits.json" with { type: "json" };
import GUI from "three/examples/jsm/libs/lil-gui.module.min.js";

// Physics changes rebuild the analytic course; appearance changes reuse it.
export function presentationGui(config, onChange, onSave) {
  const gui = new GUI({ title: "音乐装置 · 参数", container: document.getElementById("presentation-gui") });
  gui.domElement.style.width = "100%";
  const groups = { ball: "球材质", boards: "木板", camera: "透视跟随镜头", environment: "HDR 环境", dof: "景深", physics: "重力与布局", tracks: "轨道外观 / 旧模式", spatial: "3D 错落布局", shadow: "球阴影" };
  const controls = {
    wallMounted: ["沿墙向下掉落"], wallDropWidths: ["逐板下降 / 板宽", .01],
    layeredPhrases: ["下落为主，少量同高横跳"],
    levelPhraseGap: ["同高组之间下降段数（±1）", 1], levelMaxNotes: ["水平同音组上限（最少 3 块）", 1],
    maxRestSeconds: ["长休止上限（秒，0=不压缩）", .1],
    seed: ["布局随机 seed", 1], speed: ["参考曲线速度", .05],
    minStepWidths: ["最小步长 / 板宽", .05], maxStepWidths: ["最大步长 / 板宽", .05],
    pitchScale: ["音高起伏 / 球径", .01], maxRails: ["全曲轨道上限", 1],
    longNoteRails: ["长音候选（仍受长间隔限制）"], glissandoRails: ["滑音候选（仍受长间隔限制）"],
    screenWidth: ["球径目标 / 画宽", .001], transmission: ["透射", 1],
    ior: ["折射率", .01], roughness: ["粗糙度", .01],
    thicknessDiameters: ["玻璃厚度 / 球径", .1], environmentIntensity: ["反射强度", .05],
    attenuationColor: ["乳白衰减色"], attenuationDiameters: ["衰减距离 / 球径", .1],
    emissiveColor: ["内发光色"], emissiveIntensity: ["内发光强度", .005],
    rimColor: ["轮廓光色"], rimIntensity: ["轮廓光强度", .1],
    sideDiameters: ["板边长 / 球径", .01], glowStrength: ["击打微光", .01],
    rodLengthWidths: ["杆长 / 板宽", .01], maxTilt: ["倾斜上限（度）", 1],
    dampingRatio: ["阻尼比 ζ", .01], angularFrequency: ["角频率 ω", 1], hitWindow: ["击打窗口（秒）", .1],
    gravity: ["统一重力 g", .01], spacingWidths: ["落点横距 / 板宽", .05],
    descentWidths: ["每次下降 / 板宽", .01],
    longMedianFactor: ["长音 / 中位间隔", .1], longMinSeconds: ["长音下限（秒）", .05],
    glissMinNotes: ["单调滑音最少音数", 1], glissMedianFactor: ["滑音间隔 / 中位间隔", .05],
    glissMaxSemitones: ["滑音最大音高步长", 1], minFlightSeconds: ["轨道后最短飞行（秒）", .01],
    maxLengthWidths: ["轨道弧长上限 / 板宽", .1], longSlopeWidths: ["长音坡幅上限 / 板宽", .01],
    glissSlopeWidths: ["滑音坡幅上限 / 板宽", .05], integrationSteps: ["能量积分精度", 256],
    solveIterations: ["坡幅二分次数", 1], timeTolerance: ["时长误差（秒）", .000001],
    trailSeconds: ["延音尾光衰减（秒）", .05], beadSeconds: ["金珠衰减（秒）", .05],
    leadFlight: ["开场下落时长（秒）", .05],
    opacity: ["阴影浓度", .01], radiusWidths: ["阴影半径 / 板宽", .01],
    heightSpread: ["高度扩散", .01], heightFade: ["高度衰减", .1],
    baseDistanceWidths: ["阴影初始距离 / 板宽", .01], heightDistance: ["高度离影距离", .05],
    lightOffsetX: ["阴影横向偏移", .01], deadZoneX: ["横向死区 / 画宽", .01],
    deadZoneY: ["纵向死区 / 画高", .01],
    fov: ["视野角 FOV", 1], downwardTilt: ["向下俯角（度）", 1],
    maxBoardsAcross: ["横向板宽上限", 1],
    yaw: ["左右视角（度）", 1], pastWindow: ["过去平滑窗口（秒）", .05],
    futureWindow: ["未来平滑窗口（秒）", .05], sigma: ["高斯宽度（秒）", .01],
    travelOffset: ["反向构图偏移", .01], directionSoftness: ["方向过渡速度", .01],
    edgeMargin: ["木板边缘留空", .005],
    samples: ["平滑采样数", 2], intensity: ["环境亮度", .05],
    rotation: ["环境旋转", .05], enabled: ["开启景深"],
    aperture: ["虚化强度", .001], maxblur: ["最大虚化", .001],
  };
  for (const [key, label] of Object.entries(groups)) {
    const folder = gui.addFolder(label);
    for (const field of Object.keys(config[key])) {
      if (field === "file") { folder.add(config[key], field).name("本地 HDR").disable(); continue; }
      const [name, step] = controls[field];
      const controller = field.endsWith("Color") ? folder.addColor(config[key], field)
        : typeof config[key][field] === "boolean"
        ? folder.add(config[key], field)
        : folder.add(config[key], field, ...limits[field], step);
      controller.name(field === 'enabled' && key === 'spatial' ? '开启 3D 布局' : name).onFinishChange(() => onChange(key,field));
      if (limits[field]?.[0] === limits[field]?.[1] && field !== "enabled") controller.disable();
    }
    if(key==='ball')for(const [name,look] of Object.entries({
      '柔光粉白':{ior:1.45,roughness:.09,thicknessDiameters:1.4,environmentIntensity:.75,attenuationColor:'#fff0f7',emissiveColor:'#fff0f7',emissiveIntensity:.12},
      '原版玻璃':{ior:1.5,roughness:.05,thicknessDiameters:1,environmentIntensity:1.25,attenuationColor:'#eee9df',emissiveColor:'#fff4e6',emissiveIntensity:.15},
    }))folder.add({apply(){Object.assign(config.ball,look);folder.controllers.forEach(c=>c.updateDisplay());onChange('ball','roughness');}},'apply').name(name);
    if (key !== "ball") folder.close();
  }
  gui.add({ save: onSave }, "save").name("保存 config.json");
  return gui;
}
