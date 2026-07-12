import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const M2V = {
  mixamorigHips: 'J_Bip_C_Hips',
  mixamorigSpine: 'J_Bip_C_Spine',
  mixamorigSpine1: 'J_Bip_C_Chest',
  mixamorigSpine2: 'J_Bip_C_UpperChest',
  mixamorigNeck: 'J_Bip_C_Neck',
  mixamorigHead: 'J_Bip_C_Head',
  mixamorigLeftShoulder: 'J_Bip_L_Shoulder',
  mixamorigLeftArm: 'J_Bip_L_UpperArm',
  mixamorigLeftForeArm: 'J_Bip_L_LowerArm',
  mixamorigLeftHand: 'J_Bip_L_Hand',
  mixamorigRightShoulder: 'J_Bip_R_Shoulder',
  mixamorigRightArm: 'J_Bip_R_UpperArm',
  mixamorigRightForeArm: 'J_Bip_R_LowerArm',
  mixamorigRightHand: 'J_Bip_R_Hand',
  mixamorigLeftUpLeg: 'J_Bip_L_UpperLeg',
  mixamorigLeftLeg: 'J_Bip_L_LowerLeg',
  mixamorigLeftFoot: 'J_Bip_L_Foot',
  mixamorigLeftToeBase: 'J_Bip_L_ToeBase',
  mixamorigRightUpLeg: 'J_Bip_R_UpperLeg',
  mixamorigRightLeg: 'J_Bip_R_LowerLeg',
  mixamorigRightFoot: 'J_Bip_R_Foot',
  mixamorigRightToeBase: 'J_Bip_R_ToeBase',
};

function retargetClip(clip, bones) {
  const tracks = [];
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf('.');
    if (dot < 0) continue;
    const bone = t.name.slice(0, dot);
    const prop = t.name.slice(dot + 1);
    const mapped = M2V[bone] || bone;
    const target = bones[mapped] ? mapped : (bones[bone] ? bone : null);
    if (!target) continue;
    if (prop !== 'quaternion' && prop !== 'position') continue;
    if (prop === 'position' && bone !== 'mixamorigHips' && target !== 'J_Bip_C_Hips') continue;
    const nt = t.clone();
    nt.name = `${target}.${prop}`;
    tracks.push(nt);
  }
  return tracks;
}

async function playFirstAnim(mixer, bones, anims) {
  for (const entry of anims || []) {
    try {
      const fbx = await new FBXLoader().loadAsync(entry.url);
      const clip = fbx.animations.find((c) => c.tracks.length > 0) || fbx.animations[0];
      if (!clip) continue;
      const tracks = retargetClip(clip, bones);
      if (!tracks.length) continue;
      const retargeted = new THREE.AnimationClip(entry.name, clip.duration, tracks);
      const action = mixer.clipAction(retargeted);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.reset().fadeIn(0.3).play();
      return action;
    } catch (_) {}
  }
  return null;
}

function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  if (!renderer.getContext()) throw new Error('WebGL context not created');
  return renderer;
}

export async function mountCompanion3D(canvas, config) {
  if (!canvas) throw new Error('No canvas element');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const renderer = createRenderer(canvas);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene.add(new THREE.AmbientLight(0xffffff, 1.8));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(1, 2, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.35);
  rim.position.set(-2, 1, -1);
  scene.add(rim);

  const gltf = await new GLTFLoader().loadAsync(config.modelURL);
  const model = gltf.scene;
  scene.add(model);

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;

  const lookY = size.y * 0.45;
  camera.position.set(0, lookY, size.y * 1.55);
  camera.lookAt(0, lookY, 0);

  const bones = {};
  model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const mixer = new THREE.AnimationMixer(model);
  let currentAction = await playFirstAnim(mixer, bones, config.anims);

  let lastT = performance.now();
  let raf = 0;
  let disposed = false;

  function resize() {
    const w = canvas.clientWidth || canvas.width || canvas.parentElement?.clientWidth || 200;
    const h = canvas.clientHeight || canvas.height || canvas.parentElement?.clientHeight || 400;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(1, w), Math.max(1, h), false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function tick(now) {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (mixer) mixer.update(dt);
    renderer.render(scene, camera);
  }

  resize();
  requestAnimationFrame(tick);

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas.parentElement || canvas);

  return {
    resize,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (currentAction) currentAction.stop();
      const gl = renderer.getContext();
      renderer.dispose();
      try { gl?.getExtension('WEBGL_lose_context')?.loseContext() } catch (_) {}
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
    },
  };
}
