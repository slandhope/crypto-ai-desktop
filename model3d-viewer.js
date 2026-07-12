import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const msg = document.getElementById('msg');
const say = (t) => { msg.textContent = t; msg.style.display = 'block'; };

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

let scene, camera, renderer, controls, mixer, model, currentAction;
const clock = new THREE.Clock();
const bones = {};

function hideMsgSoon(match) {
  setTimeout(() => {
    if (!match || msg.textContent.includes(match)) msg.style.display = 'none';
  }, 2500);
}

function retargetClip(clip) {
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

async function loadAnim(entry) {
  try {
    say(`Loading ${entry.name}...`);
    const fbx = await new FBXLoader().loadAsync(entry.url);
    const clip = fbx.animations.find((c) => c.tracks.length > 0) || fbx.animations[0];
    if (!clip) {
      say(`No animation in ${entry.name}`);
      return false;
    }
    const tracks = retargetClip(clip);
    if (!tracks.length) {
      say(`Animation loaded but bones did not match Nova's skeleton`);
      return false;
    }
    const retargeted = new THREE.AnimationClip(entry.name, clip.duration, tracks);
    if (currentAction) currentAction.fadeOut(0.3);
    currentAction = mixer.clipAction(retargeted);
    currentAction.reset().fadeIn(0.3).play();
    say(`Playing ${entry.name}`);
    hideMsgSoon('Playing');
    return true;
  } catch (e) {
    say(`Animation error: ${e.message}`);
    return false;
  }
}

function buildAnimBar(entries) {
  const bar = document.getElementById('anim-bar');
  bar.innerHTML = '';
  entries.forEach((entry) => {
    const btn = document.createElement('div');
    btn.className = 'anim-btn';
    btn.textContent = entry.name;
    btn.onclick = () => { loadAnim(entry); };
    bar.appendChild(btn);
  });
}

async function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 100);
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c3d'), antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x0a0a0c);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene.add(new THREE.AmbientLight(0xffffff, 1.8));
  const d = new THREE.DirectionalLight(0xffffff, 1.2);
  d.position.set(1, 2, 2);
  scene.add(d);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  say('Loading Nova...');
  const gltf = await new GLTFLoader().loadAsync(window.__modelURL);
  model = gltf.scene;
  scene.add(model);

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;
  controls.target.set(0, size.y * 0.45, 0);
  camera.position.set(0, size.y * 0.45, size.y * 1.6);
  controls.update();

  mixer = new THREE.AnimationMixer(model);
  model.traverse((o) => { if (o.isBone) bones[o.name] = o; });

  const entries = window.__anims || [];
  buildAnimBar(entries);

  if (!entries.length) {
    say('Nova loaded — add Mixamo .fbx animations to assets/vrm/');
    return;
  }

  let played = false;
  for (const entry of entries) {
    if (await loadAnim(entry)) { played = true; break; }
  }
  if (!played) say('Nova loaded — no compatible animations found');
  else hideMsgSoon('Playing');
}

window.__loadAnim = (url) => {
  const entry = (window.__anims || []).find((a) => a.url === url);
  if (entry) loadAnim(entry);
};

function loop() {
  requestAnimationFrame(loop);
  const dt = clock.getDelta();
  if (mixer) mixer.update(dt);
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}
loop();

init().catch((e) => say(`Init error: ${e.message}`));
