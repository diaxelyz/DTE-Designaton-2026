// Rotating 3D helmet for the home screen. Glows when the real helmet is connected.
import * as THREE from './three.module.min.js';

const COLORS = {
  connected:    {shell: 0x1f6b4f, glow: 0x7fe0a8, glowOn: 1.0},
  connecting:   {shell: 0x5b8f78, glow: 0x7fe0a8, glowOn: 0.45},
  disconnected: {shell: 0xb9c4be, glow: 0xdfe6e2, glowOn: 0.0},
  alert:        {shell: 0xc4501f, glow: 0xffb08f, glowOn: 1.0},
};

export function mountHelmet(canvas) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({canvas, alpha: true, antialias: true});
  } catch {
    return null;   // no WebGL: the app shows a flat helmet instead
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 1.25, 5.2);
  camera.lookAt(0, 0.25, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xcfe0d6, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 4, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbfe8d0, 0.7);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  const helmet = new THREE.Group();
  scene.add(helmet);

  // Shell: a stretched dome, longer front to back with a pointed tail
  const shellGeo = new THREE.SphereGeometry(1, 72, 40, 0, Math.PI * 2, 0, Math.PI * 0.56);
  const pos = shellGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (z < 0) pos.setZ(i, z * 1.25);             // tail at the back
  }
  shellGeo.computeVertexNormals();
  const shellMat = new THREE.MeshStandardMaterial({color: COLORS.disconnected.shell, roughness: 0.32, metalness: 0.25});
  const shell = new THREE.Mesh(shellGeo, shellMat);
  shell.scale.set(1.05, 0.92, 1.12);
  helmet.add(shell);

  // Inner liner (visible from below)
  const liner = new THREE.Mesh(shellGeo, new THREE.MeshStandardMaterial({color: 0x101818, side: THREE.BackSide, roughness: 0.9}));
  liner.scale.set(1.0, 0.88, 1.07);
  helmet.add(liner);

  // Glowing accents: vents along the top and a band around the rim
  const glowMat = new THREE.MeshStandardMaterial({color: 0x202828, emissive: COLORS.connected.glow, emissiveIntensity: 0, roughness: 0.4});
  for (let i = -2; i <= 2; i++) {
    const vent = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.85, 6, 12), glowMat);
    vent.rotation.x = Math.PI / 2;
    const x = i * 0.27;
    const y = Math.sqrt(Math.max(0, 1 - x * x)) * 0.92 * 0.985;
    vent.position.set(x * 1.05, y, -0.05);
    vent.rotation.z = -x * 0.9;
    helmet.add(vent);
  }
  const band = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 10, 120), glowMat);
  band.rotation.x = Math.PI / 2;
  band.position.y = Math.cos(Math.PI * 0.56) * 0.92 + 0.02;
  band.scale.set(1.06, 1.16, 1);
  helmet.add(band);

  // Visor at the front
  const visorGeo = new THREE.SphereGeometry(1.08, 40, 8, -Math.PI * 0.28, Math.PI * 0.56, Math.PI * 0.42, Math.PI * 0.1);
  const visor = new THREE.Mesh(visorGeo, new THREE.MeshStandardMaterial({color: 0x15201f, roughness: 0.5, side: THREE.DoubleSide}));
  visor.scale.set(1.02, 0.8, 1.12);
  visor.position.y = 0.05;
  helmet.add(visor);

  // The NeuroHalo sensor pod on the back
  const pod = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.1), new THREE.MeshStandardMaterial({color: 0x0f1716, roughness: 0.6}));
  pod.position.set(0, 0.32, -1.18);
  pod.rotation.x = 0.35;
  helmet.add(pod);
  const podLight = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.025, 0.02), glowMat);
  podLight.position.set(0, 0.33, -1.24);
  podLight.rotation.x = 0.35;
  helmet.add(podLight);

  // Soft glow disc under the helmet
  const halo = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.6, 64),
    new THREE.MeshBasicMaterial({color: COLORS.connected.glow, transparent: true, opacity: 0, side: THREE.DoubleSide}));
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -0.38;
  scene.add(halo);

  helmet.position.y = 0.05;
  let state = 'disconnected', running = true;
  const target = {...COLORS.disconnected};

  function setState(next) {
    state = COLORS[next] ? next : 'disconnected';
    Object.assign(target, COLORS[state]);
  }

  function resize() {
    const w = canvas.clientWidth || 300, h = canvas.clientHeight || 220;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  const shellColor = new THREE.Color(), glowColor = new THREE.Color();
  function frame(t) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (!canvas.isConnected) return;   // not on screen right now
    resize();
    const s = t / 1000;
    helmet.rotation.y = s * 0.45;
    helmet.position.y = 0.05 + Math.sin(s * 1.4) * 0.03;
    shellColor.setHex(target.shell);
    shellMat.color.lerp(shellColor, 0.06);
    glowColor.setHex(target.glow);
    glowMat.emissive.lerp(glowColor, 0.08);
    const pulse = state === 'connecting' || state === 'alert' ? 0.55 + 0.45 * Math.sin(s * 6) : 1;
    glowMat.emissiveIntensity += (target.glowOn * 1.6 * pulse - glowMat.emissiveIntensity) * 0.08;
    halo.material.color.lerp(glowColor, 0.08);
    halo.material.opacity += (target.glowOn * 0.28 * pulse - halo.material.opacity) * 0.08;
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  return {setState, stop() { running = false; renderer.dispose(); }};
}
