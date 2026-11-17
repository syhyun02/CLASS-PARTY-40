import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { TEAM_COLORS, FLAG_ACT, FLAG_DONE, FLAG_GRAB, FLAG_GROUNDED, FLAG_HELD, FLAG_HIDDEN, FLAG_SHOVED, FLAG_STUN, MAX_PLAYERS } from '@shared';
import { net } from '../game/net';
import { useStore } from '../game/store';

/**
 * 오리지널 캐릭터 "몽글이": 큰 머리와 통통한 몸의 2등신, 반짝이는 큰 눈, 볼터치, 웃는 입,
 * 짧은 팔다리와 꼬리, 번호마다 다른 머리 장식 7종.
 * 40명을 부위별 InstancedMesh 8개(= 드로우콜 8번)로 그린다. 애니메이션은 전부 계산식이다.
 */
interface Anim { x: number; y: number; z: number; speed: number; phase: number; groundY: number; yaw: number; seen: number; air: number; tilt: number }

const N = MAX_PLAYERS;
const root = new THREE.Matrix4();
const local = new THREE.Matrix4();
const out = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v = new THREE.Vector3();
const s = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const col = new THREE.Color();
const col2 = new THREE.Color();
const WHITE = new THREE.Color('#ffffff');
const LEAF = new THREE.Color('#40c057');
const FACE_DIST = 26; // 이보다 멀면 얼굴 부위를 생략한다(m)
const LIMBS = 13; // 발 2 + 손 2 + 배 1 + 머리 장식 3 + 꼬리 3 + 엉덩이 꼬리 1 + 팀 머리띠 1
const TEAM_C = TEAM_COLORS.map((c) => new THREE.Color(c));
const PINK = new THREE.Color('#ff6f9f');
const BOW = new THREE.Color('#ff4f8b');
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
const TAIL = new THREE.Color('#ff922b');
const TAIL_TIP = new THREE.Color('#fff4e6');
const ID_Q = new THREE.Quaternion();
const frustum = new THREE.Frustum();
const projScreen = new THREE.Matrix4();
const bound = new THREE.Sphere(new THREE.Vector3(), 1.6);

/**
 * 부위 기록기: 쓰는 부위만 앞에서부터 차례로 채운다(빈자리를 크기 0으로 남기면 GPU가 그것까지 그린다).
 * 코드에서는 "몇 번째 캐릭터의 몇 번 부위"라는 원래 번호(i)로 부르고, 실제 자리는 여기서 정한다.
 */
const slots = new Map<THREE.InstancedMesh, { n: number; map: Map<number, number> }>();
function slotOf(mesh: THREE.InstancedMesh, i: number): number {
  let st = slots.get(mesh);
  if (!st) { st = { n: 0, map: new Map() }; slots.set(mesh, st); }
  let k = st.map.get(i);
  if (k === undefined) { k = st.n++; st.map.set(i, k); }
  return k;
}
function colorAt(mesh: THREE.InstancedMesh, i: number, c: THREE.Color) {
  const k = slots.get(mesh)?.map.get(i);
  if (k !== undefined) mesh.setColorAt(k, c);
}
function part(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
  local.compose(v.set(x, y, z), ID_Q, s.set(sx, sy, sz));
  out.multiplyMatrices(root, local);
  mesh.setMatrixAt(slotOf(mesh, i), out);
}

/** 회전이 있는 부위(웃는 입, 웃는 눈)용 */
function partQ(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, rot: THREE.Quaternion) {
  local.compose(v.set(x, y, z), rot, s.set(sx, sy, sz));
  out.multiplyMatrices(root, local);
  mesh.setMatrixAt(slotOf(mesh, i), out);
}

/**
 * 닉네임표 묶음: 이름 40개를 그림 한 장(가로 4칸 × 세로 16칸)에 그려 두고, 이름표 전부를 그리기 명령 한 번으로 그린다.
 * 이름표는 항상 화면을 바라보고(빌보드), 칸마다 위치·크기·투명도만 다르다.
 */
const TAG_COLS = 4, TAG_ROWS = 16, TAG_W = 256, TAG_H = 64;
function makeTagAtlas() {
  const c = document.createElement('canvas');
  c.width = TAG_W * TAG_COLS; c.height = TAG_H * TAG_ROWS;
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  return { c, tex, names: new Map<number, string>() };
}
function drawTag(atlas: ReturnType<typeof makeTagAtlas>, slot: number, name: string) {
  const g = atlas.c.getContext('2d')!;
  const x = (slot % TAG_COLS) * TAG_W, y = Math.floor(slot / TAG_COLS) * TAG_H;
  g.clearRect(x, y, TAG_W, TAG_H);
  g.font = '700 34px Jua, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round'; g.lineWidth = 8; g.strokeStyle = 'rgba(59,47,99,0.9)';
  g.strokeText(name, x + TAG_W / 2, y + 34, TAG_W - 12);
  g.fillStyle = '#ffffff';
  g.fillText(name, x + TAG_W / 2, y + 34, TAG_W - 12);
  atlas.tex.needsUpdate = true;
}
function makeTagMaterial(map: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map } },
    transparent: true, depthWrite: false,
    vertexShader: `
      attribute vec3 aTag; // 칸 열, 칸 행, 투명도
      varying vec2 vUv; varying float vA;
      void main() {
        vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        c.xy += position.xy * vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
        gl_Position = projectionMatrix * c;
        vUv = vec2((aTag.x + uv.x) / ${TAG_COLS}.0, 1.0 - (aTag.y + 1.0 - uv.y) / ${TAG_ROWS}.0);
        vA = aTag.z;
      }`,
    fragmentShader: `
      uniform sampler2D map; varying vec2 vUv; varying float vA;
      void main() { vec4 t = texture2D(map, vUv); if (t.a * vA < 0.02) discard; gl_FragColor = vec4(t.rgb, t.a * vA); }`,
  });
}

export function Characters({ nameRange = 22 }: { nameRange?: number }) {
  const quality = useStore((st) => st.quality);
  // 화질별 구 정밀도: 몸통은 보통 16×12(약 350개 삼각형), 작은 부위는 8×6이면 충분하다
  const seg = quality === 'low' ? [12, 8] : quality === 'medium' ? [16, 12] : [24, 16];
  const sphere = useMemo(() => new THREE.SphereGeometry(1, seg[0], seg[1]), [seg[0], seg[1]]);
  const small = useMemo(() => new THREE.SphereGeometry(1, quality === 'high' ? 12 : 8, quality === 'high' ? 9 : 6), [quality]);
  // 테두리는 가장자리 윤곽만 보이므로 몸통보다 거친 구로 충분하다
  const outlineGeo = useMemo(() => new THREE.SphereGeometry(1, quality === 'high' ? 18 : 12, quality === 'high' ? 12 : 8), [quality]);
  // 눈 반짝임·눈동자·볼처럼 아주 작은 부위용
  const tiny = useMemo(() => new THREE.SphereGeometry(1, quality === 'high' ? 10 : 6, quality === 'high' ? 7 : 4), [quality]);
  const disc = useMemo(() => new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2), []);
  // 반원 고리: 그대로 두면 웃는 눈(^), 뒤집으면 웃는 입
  const arc = useMemo(() => new THREE.TorusGeometry(1, 0.26, 5, 10, Math.PI), []);
  const bodies = useRef<THREE.InstancedMesh>(null!);
  const limbs = useRef<THREE.InstancedMesh>(null!);
  const outlines = useRef<THREE.InstancedMesh>(null);
  const whites = useRef<THREE.InstancedMesh>(null!);
  const darks = useRef<THREE.InstancedMesh>(null!);
  const cheeks = useRef<THREE.InstancedMesh>(null!);
  const arcs = useRef<THREE.InstancedMesh>(null!);
  const rings = useRef<THREE.InstancedMesh>(null!);
  const ringGeo = useMemo(() => new THREE.RingGeometry(0.5, 0.72, 24).rotateX(-Math.PI / 2), []);
  const shadows = useRef<THREE.InstancedMesh>(null!);
  const marker = useRef<THREE.Mesh>(null!);
  const tags = useRef<THREE.InstancedMesh>(null!);
  const anims = useRef(new Map<number, Anim>());
  const atlas = useMemo(() => makeTagAtlas(), []);
  const tagMat = useMemo(() => makeTagMaterial(atlas.tex), [atlas]);
  const tagGeo = useMemo(() => { const g = new THREE.PlaneGeometry(1, 1); g.setAttribute('aTag', new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3)); return g; }, []);
  const camera = useThree((st) => st.camera);
  const usedSet = useRef(new Set<number>());
  const infoCache = useRef<{ src: unknown; map: Map<number, { id: number; name: string; color: string; score: number; team?: number | null }> }>({ src: null, map: new Map() });
  const tailCache = useRef<{ src: number[] | undefined; set: Set<number> | null }>({ src: undefined, set: null });

  useEffect(() => () => { atlas.tex.dispose(); tagMat.dispose(); tagGeo.dispose(); }, [atlas, tagMat, tagGeo]);

  useFrame((state, dtRaw) => {
    const dt = Math.min(0.1, dtRaw);
    const time = state.clock.elapsedTime;
    const st = useStore.getState();
    const room = st.room;
    const list = net.renderPlayers();
    // 방 상태가 바뀔 때만 조회용 표를 새로 만든다(매 프레임 새로 만들지 않는다)
    if (infoCache.current.src !== room?.players) infoCache.current = { src: room?.players, map: new Map(room?.players.map((p) => [p.id, p]) ?? []) };
    const info = infoCache.current.map;
    // 시상식에서는 1~3위가 기뻐하고 나머지는 시무룩해한다
    let podium: number[] = [];
    if (room?.phase === 'final') podium = [...room.players].sort((a, b) => b.score - a.score).slice(0, 3).map((p) => p.id);

    const tailIds = st.game?.tails;
    if (tailIds !== tailCache.current.src) tailCache.current = { src: tailIds, set: tailIds ? new Set(tailIds) : null };
    const tails = room?.phase === 'playing' ? tailCache.current.set : null;
    for (const st of slots.values()) { st.n = 0; st.map.clear(); }
    // 화면 밖 캐릭터는 그리지 않는다
    state.camera.updateMatrixWorld();
    projScreen.multiplyMatrices(state.camera.projectionMatrix, state.camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    const camPos = state.camera.position;
    const used = usedSet.current;
    used.clear();
    let n = 0, shadowN = 0, tagN = 0, ringN = 0;
    let meShown = false;
    for (const p of list) {
      if (n >= N) break;
      const pi = info.get(p.id);
      if (!pi || p.flags & FLAG_HIDDEN) continue;
      used.add(p.id);
      let a = anims.current.get(p.id);
      if (!a) { a = { x: p.x, y: p.y, z: p.z, speed: 0, phase: Math.random() * 6, groundY: p.y, yaw: p.yaw, seen: time, air: 0, tilt: 0 }; anims.current.set(p.id, a); }
      const dist = Math.hypot(p.x - a.x, p.z - a.z);
      const sp = dt > 0 ? Math.min(12, dist / dt) : 0;
      a.speed += (sp - a.speed) * Math.min(1, dt * 10);
      a.x = p.x; a.y = p.y; a.z = p.z;
      let dyaw = p.yaw - a.yaw;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2; else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      a.yaw += dyaw * Math.min(1, dt * 14);
      const grounded = (p.flags & FLAG_GROUNDED) !== 0;
      const stun = (p.flags & FLAG_STUN) !== 0;
      if (grounded) { a.groundY = p.y; a.air = 0; } else a.air += dt;
      const run = Math.min(1, a.speed / 5);
      a.phase += a.speed * dt * 2.4;

      const win = podium.length ? podium.includes(p.id) : (p.flags & FLAG_DONE) !== 0 && room?.phase !== 'result';
      const lose = podium.length > 0 && !win;
      const hop = win && grounded && a.speed < 0.5 ? Math.abs(Math.sin(time * 6 + p.id)) * 0.35 : 0;

      bound.center.set(p.x, p.y + 0.9, p.z);
      const visible = frustum.intersectsSphere(bound);
      const camD = camPos.distanceTo(bound.center);
      const far = camD > FACE_DIST; // 멀면 눈·입·볼 같은 작은 부위는 몇 픽셀이라 생략한다
      if (!visible) {
        if (p.isMe) meShown = false;
        n++;
        continue;
      }
      // 몸 전체: 위치 → 방향 → (넘어질 때) 구르기 → 찌그러짐
      const airborne = !grounded && a.air > 0.06;
      const squashY = stun ? 1 : airborne ? 1.08 : 1 - run * 0.04 * Math.sin(a.phase * 2) - (lose ? 0.08 : 0);
      // 밀쳐지면 뒤로 젖혀지고, 밀 때는 몸을 앞으로 내민다
      const shoved = (p.flags & FLAG_SHOVED) !== 0;
      a.tilt += ((shoved ? -0.5 : p.flags & FLAG_ACT ? 0.42 : 0) - a.tilt) * Math.min(1, dt * 16);
      const lean = stun ? time * 13 : run * 0.22 + a.tilt;
      e.set(lean, a.yaw, stun ? Math.sin(time * 9) * 0.5 : Math.sin(a.phase) * run * 0.06, 'YXZ');
      q.setFromEuler(e);
      const py = p.y + hop + (stun ? 0.35 : 0);
      root.compose(v.set(p.x, py, p.z), q, s.set(1 / Math.sqrt(squashY), squashY, 1 / Math.sqrt(squashY)));
      if (stun) { // 몸 중심을 축으로 구른다
        local.makeTranslation(0, -0.55, 0); root.multiply(local);
        local.makeTranslation(0, 0.55, 0); root.premultiply(local);
      }

      // 2등신: 통통한 몸 + 그보다 큰 머리. 테두리는 몸 색을 어둡게 한 색이라 부드러워 보인다.
      const B = n * 2;
      const headBob = Math.sin(a.phase * 2) * 0.025 * run;
      const HY = 0.93 + headBob; // 머리 중심 높이
      part(bodies.current, B, 0, 0.42, 0, 0.4, 0.39, 0.38);
      part(bodies.current, B + 1, 0, HY, 0.02, 0.47, 0.43, 0.44);
      col.set(pi.color);
      colorAt(bodies.current, B, col); colorAt(bodies.current, B + 1, col);
      if (outlines.current) {
        part(outlines.current, B, 0, 0.42, 0, 0.43, 0.42, 0.41);
        part(outlines.current, B + 1, 0, HY, 0.02, 0.5, 0.46, 0.47);
        col2.copy(col).multiplyScalar(0.42);
        colorAt(outlines.current, B, col2); colorAt(outlines.current, B + 1, col2);
      }
      const L = n * LIMBS;
      // 밝은 배
      part(limbs.current, L + 4, 0, 0.38, 0.17, 0.29, 0.27, 0.25);
      colorAt(limbs.current, L + 4, col2.copy(col).lerp(WHITE, 0.62));
      // 팔다리(몸보다 조금 진한 색)
      col2.copy(col).multiplyScalar(0.8);
      const stride = Math.sin(a.phase) * 0.22 * run, lift = Math.max(0, Math.cos(a.phase)) * 0.14 * run;
      const lift2 = Math.max(0, -Math.cos(a.phase)) * 0.14 * run;
      const tuck = airborne ? 0.1 : 0;
      const handUp = win ? 0.5 + Math.sin(time * 10 + p.id) * 0.06 : airborne || stun ? 0.3 : lose ? -0.1 : 0;
      part(limbs.current, L, -0.19, 0.09 + lift + tuck, stride + 0.05, 0.155, 0.105, 0.21);
      part(limbs.current, L + 1, 0.19, 0.09 + lift2 + tuck, -stride + 0.05, 0.155, 0.105, 0.21);
      if (p.flags & (FLAG_ACT | FLAG_GRAB)) {
        // 밀치기·잡기: 두 손을 앞으로 쭉 뻗는다
        part(limbs.current, L + 2, -0.22, 0.5, 0.56, 0.15, 0.15, 0.15);
        part(limbs.current, L + 3, 0.22, 0.5, 0.56, 0.15, 0.15, 0.15);
      } else if (p.flags & FLAG_HELD || shoved) {
        // 잡히거나 밀쳐졌을 때: 팔을 허우적거린다
        const fl = Math.sin(time * 22 + p.id) * 0.16;
        part(limbs.current, L + 2, -0.5, 0.62 + fl, 0, 0.125, 0.125, 0.125);
        part(limbs.current, L + 3, 0.5, 0.62 - fl, 0, 0.125, 0.125, 0.125);
      } else {
        part(limbs.current, L + 2, -0.44, 0.46 + handUp, -stride * 0.9, 0.125, 0.125, 0.125);
        part(limbs.current, L + 3, 0.44, 0.46 + handUp, stride * 0.9, 0.125, 0.125, 0.125);
      }
      for (let k = 0; k < 4; k++) colorAt(limbs.current, L + k, col2);

      // 꼬리 지키기의 큰 꼬리, 아니면 작은 엉덩이 꼬리
      if (tails && tails.has(p.id)) {
        const wag = Math.sin(time * 9 + p.id) * 0.14;
        part(limbs.current, L + 8, wag * 0.4, 0.38, -0.46, 0.16, 0.16, 0.2);
        part(limbs.current, L + 9, wag, 0.52, -0.72, 0.19, 0.19, 0.22);
        part(limbs.current, L + 10, wag * 1.6, 0.7, -0.94, 0.14, 0.14, 0.16);
        colorAt(limbs.current, L + 8, TAIL); colorAt(limbs.current, L + 9, TAIL); colorAt(limbs.current, L + 10, TAIL_TIP);
      } else {
        part(limbs.current, L + 11, Math.sin(a.phase * 2) * 0.03 * run, 0.34, -0.39, 0.1, 0.1, 0.1);
        colorAt(limbs.current, L + 11, col2.copy(col).lerp(WHITE, 0.5));
      }

      // 팀 게임: 팀 색 머리띠
      const team = pi.team ?? -1;
      if (team >= 0) {
        part(limbs.current, L + 12, 0, HY + 0.15, 0.02, 0.495, 0.075, 0.465);
        colorAt(limbs.current, L + 12, TEAM_C[team]);
      }
      // 머리 장식 7종: 번호마다 달라서 같은 색이어도 구별된다
      const bob = headBob + (airborne ? 0.04 : 0);
      const TOP = HY + 0.4;
      const kind = p.id % 7;
      col2.copy(col).multiplyScalar(0.8);
      if (kind === 0) { // 곰 귀
        part(limbs.current, L + 5, -0.3, TOP - 0.06 + bob, 0, 0.15, 0.15, 0.09);
        part(limbs.current, L + 6, 0.3, TOP - 0.06 + bob, 0, 0.15, 0.15, 0.09);
        colorAt(limbs.current, L + 5, col2); colorAt(limbs.current, L + 6, col2);
      } else if (kind === 1) { // 토끼 귀(달릴 때 뒤로 젖혀진다)
        const back = -0.08 - run * 0.14;
        part(limbs.current, L + 5, -0.17, TOP + 0.2 + bob, back, 0.085, 0.3, 0.07);
        part(limbs.current, L + 6, 0.17, TOP + 0.2 + bob, back, 0.085, 0.3, 0.07);
        colorAt(limbs.current, L + 5, col2); colorAt(limbs.current, L + 6, col2);
      } else if (kind === 2) { // 방울
        part(limbs.current, L + 5, 0, TOP + 0.1 + bob * 2, 0, 0.16, 0.16, 0.16);
        colorAt(limbs.current, L + 5, WHITE);
      } else if (kind === 3) { // 볏
        col2.copy(col).offsetHSL(0.5, 0, 0);
        for (let k = 0; k < 3; k++) {
          part(limbs.current, L + 5 + k, 0, TOP + 0.04 - Math.abs(k - 1) * 0.07 + bob, (k - 1) * 0.17, 0.07, 0.13, 0.11);
          colorAt(limbs.current, L + 5 + k, col2);
        }
      } else if (kind === 4) { // 양갈래
        part(limbs.current, L + 5, -0.46, HY + 0.24 + bob, -0.06, 0.17, 0.17, 0.17);
        part(limbs.current, L + 6, 0.46, HY + 0.24 + bob, -0.06, 0.17, 0.17, 0.17);
        colorAt(limbs.current, L + 5, col2); colorAt(limbs.current, L + 6, col2);
      } else if (kind === 5) { // 새싹
        part(limbs.current, L + 5, -0.11, TOP + 0.13 + bob * 2, 0, 0.13, 0.045, 0.08);
        part(limbs.current, L + 6, 0.11, TOP + 0.13 + bob * 2, 0, 0.13, 0.045, 0.08);
        part(limbs.current, L + 7, 0, TOP + 0.05 + bob, 0, 0.035, 0.08, 0.035);
        for (let k = 5; k < 8; k++) colorAt(limbs.current, L + k, LEAF);
      } else { // 리본
        part(limbs.current, L + 5, -0.15, TOP + 0.02 + bob, 0.05, 0.14, 0.1, 0.07);
        part(limbs.current, L + 6, 0.15, TOP + 0.02 + bob, 0.05, 0.14, 0.1, 0.07);
        part(limbs.current, L + 7, 0, TOP + 0.02 + bob, 0.07, 0.06, 0.06, 0.06);
        colorAt(limbs.current, L + 5, BOW); colorAt(limbs.current, L + 6, BOW); colorAt(limbs.current, L + 7, WHITE);
      }

      if (!far) {
        // ---- 얼굴: 까맣고 반짝이는 큰 눈, 볼터치, 상황에 따라 바뀌는 입 ----
        const blink = !stun && !win && (time * 0.5 + p.id * 0.37) % 1 > 0.96;
        const held = (p.flags & FLAG_HELD) !== 0 || shoved;
        const EX = 0.175, EY = HY + 0.02, EZ = 0.415;
        const W = n * 6, D = n * 3, A = n * 3, C = n * 3;
        if (win || blink) {
          // 웃는 눈 ^ ^
          partQ(arcs.current, A + 1, -EX, EY - 0.02, EZ + 0.02, 0.075, 0.07, 0.06, ID_Q);
          partQ(arcs.current, A + 2, EX, EY - 0.02, EZ + 0.02, 0.075, 0.07, 0.06, ID_Q);
        } else if (stun) {
          // 휘둥그레진 눈: 흰자 위에 작은 눈동자가 빙글
          const sx = Math.cos(time * 14) * 0.03, sy = Math.sin(time * 14) * 0.03;
          part(whites.current, W + 4, -EX, EY, EZ - 0.01, 0.12, 0.13, 0.05);
          part(whites.current, W + 5, EX, EY, EZ - 0.01, 0.12, 0.13, 0.05);
          part(darks.current, D, -EX + sx, EY + sy, EZ + 0.035, 0.04, 0.04, 0.02);
          part(darks.current, D + 1, EX - sx, EY - sy, EZ + 0.035, 0.04, 0.04, 0.02);
        } else {
          const big = held || airborne ? 1.12 : 1, down = lose ? -0.03 : 0;
          part(darks.current, D, -EX, EY + down, EZ, 0.088 * big, 0.112 * big, 0.05);
          part(darks.current, D + 1, EX, EY + down, EZ, 0.088 * big, 0.112 * big, 0.05);
          // 반짝임 두 개씩
          part(whites.current, W, -EX - 0.03, EY + 0.045 + down, EZ + 0.045, 0.034, 0.034, 0.012);
          part(whites.current, W + 1, EX - 0.03, EY + 0.045 + down, EZ + 0.045, 0.034, 0.034, 0.012);
          part(whites.current, W + 2, -EX + 0.035, EY - 0.04 + down, EZ + 0.045, 0.016, 0.016, 0.01);
          part(whites.current, W + 3, EX + 0.035, EY - 0.04 + down, EZ + 0.045, 0.016, 0.016, 0.01);
        }
        // 입: 평소엔 미소, 뛰거나 놀라면 동그랗게, 이기면 활짝, 지면 시무룩
        const MY = HY - 0.13, MZ = 0.455;
        if (stun || held || airborne) part(darks.current, D + 2, 0, MY - 0.01, MZ - 0.02, 0.04, 0.05, 0.03);
        else if (lose) partQ(arcs.current, A, 0, MY - 0.04, MZ, 0.05, 0.04, 0.05, ID_Q);
        else partQ(arcs.current, A, 0, MY + 0.02, MZ, win ? 0.085 : 0.06, win ? 0.075 : 0.045, 0.05, FLIP);
        // 볼터치 + 머리의 윤기
        part(cheeks.current, C, -0.31, HY - 0.1, 0.33, 0.085, 0.055, 0.04);
        part(cheeks.current, C + 1, 0.31, HY - 0.1, 0.33, 0.085, 0.055, 0.04);
        part(cheeks.current, C + 2, -0.2, HY + 0.24, 0.3, 0.11, 0.06, 0.05);
        colorAt(cheeks.current, C, PINK); colorAt(cheeks.current, C + 1, PINK); colorAt(cheeks.current, C + 2, WHITE);
      }

      // 바닥 그림자: 높이 뛸수록 작아져서 착지 지점을 가늠하게 해 준다
      const h = Math.max(0, p.y - a.groundY);
      const sh = Math.max(0.15, 0.52 - h * 0.08);
      local.compose(v.set(p.x, a.groundY + 0.03, p.z), ID_Q, s.set(sh, 1, sh));
      if (h <= 6) shadows.current.setMatrixAt(shadowN++, local);
      if (team >= 0) {
        // 팀 색 발밑 고리
        local.compose(v.set(p.x, a.groundY + 0.05, p.z), ID_Q, s.set(1, 1, 1));
        rings.current.setMatrixAt(ringN, local);
        rings.current.setColorAt(ringN, TEAM_C[team]);
        ringN++;
      }

      // 닉네임표: 가까운 캐릭터만 보인다
      const d = camera.position.distanceTo(v.set(p.x, p.y, p.z));
      if (!p.isMe && d < nameRange && tagN < N) {
        const slot = p.id % (TAG_COLS * TAG_ROWS);
        if (atlas.names.get(slot) !== pi.name) { atlas.names.set(slot, pi.name); drawTag(atlas, slot, pi.name); }
        const k = nameRange > 30 ? Math.max(1, d / 16) : 1; // 교사용 원경에서는 글자를 키운다
        local.compose(v.set(p.x, py + 2.0, p.z), ID_Q, s.set(2.2 * k, 0.55 * k, 1));
        tags.current.setMatrixAt(tagN, local);
        const at = tagGeo.getAttribute('aTag') as THREE.InstancedBufferAttribute;
        at.setXYZ(tagN, slot % TAG_COLS, Math.floor(slot / TAG_COLS), Math.min(1, (nameRange - d) / 4));
        tagN++;
      }
      if (p.isMe) {
        meShown = true;
        marker.current.position.set(p.x, py + 2.1 + Math.sin(time * 4) * 0.08, p.z);
        marker.current.rotation.y = time * 2;
      }
      n++;
    }
    marker.current.visible = meShown;
    rings.current.count = ringN;
    rings.current.instanceMatrix.needsUpdate = true;
    if (rings.current.instanceColor) rings.current.instanceColor.needsUpdate = true;
    tags.current.count = tagN;
    tags.current.instanceMatrix.needsUpdate = true;
    (tagGeo.getAttribute('aTag') as THREE.InstancedBufferAttribute).needsUpdate = true;
    for (const id of anims.current.keys()) if (!used.has(id)) anims.current.delete(id);

    const set = (m: THREE.InstancedMesh, count: number) => {
      m.count = count;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    };
    const cnt = (m: THREE.InstancedMesh | null) => (m ? slots.get(m)?.n ?? 0 : 0);
    set(bodies.current, cnt(bodies.current)); set(limbs.current, cnt(limbs.current)); set(whites.current, cnt(whites.current));
    if (outlines.current) set(outlines.current, cnt(outlines.current));
    set(darks.current, cnt(darks.current)); set(cheeks.current, cnt(cheeks.current)); set(arcs.current, cnt(arcs.current)); set(shadows.current, shadowN);
  });

  const shadow = quality === 'high';
  const low = quality === 'low';
  const cheap = quality !== 'high'; // 보통 이하에서는 계산이 가벼운 재질을 쓴다
  return (
    <group>
      <instancedMesh ref={bodies} args={[sphere, undefined, N * 2]} frustumCulled={false} castShadow={shadow}>
        {cheap ? <meshLambertMaterial /> : <meshStandardMaterial roughness={0.42} metalness={0} />}
      </instancedMesh>
      {!low && (
        <instancedMesh ref={outlines} args={[outlineGeo, undefined, N * 2]} frustumCulled={false}>
          <meshBasicMaterial side={THREE.BackSide} />
        </instancedMesh>
      )}
      <instancedMesh ref={limbs} args={[small, undefined, N * LIMBS]} frustumCulled={false} castShadow={shadow}>
        {cheap ? <meshLambertMaterial /> : <meshStandardMaterial roughness={0.5} metalness={0} />}
      </instancedMesh>
      <instancedMesh ref={whites} args={[tiny, undefined, N * 6]} frustumCulled={false}>
        <meshBasicMaterial color="#ffffff" />
      </instancedMesh>
      <instancedMesh ref={darks} args={[tiny, undefined, N * 3]} frustumCulled={false}>
        <meshBasicMaterial color="#2b2145" />
      </instancedMesh>
      <instancedMesh ref={cheeks} args={[tiny, undefined, N * 3]} frustumCulled={false}>
        <meshBasicMaterial transparent opacity={0.62} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={arcs} args={[arc, undefined, N * 3]} frustumCulled={false}>
        <meshBasicMaterial color="#2b2145" />
      </instancedMesh>
      <instancedMesh ref={shadows} args={[disc, undefined, N]} frustumCulled={false} renderOrder={1}>
        <meshBasicMaterial color="#1f1640" transparent opacity={0.3} depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
      </instancedMesh>
      <mesh ref={marker} visible={false}>
        <coneGeometry args={[0.18, 0.34, 4]} />
        <meshBasicMaterial color="#ffd84d" />
      </mesh>
      <instancedMesh ref={tags} args={[tagGeo, tagMat, N]} frustumCulled={false} renderOrder={5} />
      <instancedMesh ref={rings} args={[ringGeo, undefined, N]} frustumCulled={false} renderOrder={2}>
        <meshBasicMaterial transparent opacity={0.9} depthWrite={false} polygonOffset polygonOffsetFactor={-3} />
      </instancedMesh>
    </group>
  );
}
