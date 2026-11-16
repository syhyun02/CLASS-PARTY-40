import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { FLAG_DONE, FLAG_GROUNDED, FLAG_HIDDEN, FLAG_STUN, MAX_PLAYERS } from '@shared';
import { net } from '../game/net';
import { useStore } from '../game/store';

/**
 * 오리지널 캐릭터 "몽글이": 달걀형 몸, 밝은 배, 큰 눈, 짧은 팔다리, 번호마다 다른 머리 장식.
 * 40명을 부위별 InstancedMesh 7개(= 드로우콜 7번)로 그린다. 애니메이션은 전부 계산식이다.
 */
interface Anim { x: number; y: number; z: number; speed: number; phase: number; groundY: number; yaw: number; seen: number; air: number }

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
const LIMBS = 8; // 발 2 + 손 2 + 배 1 + 머리 장식 3
const ID_Q = new THREE.Quaternion();

function part(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
  local.compose(v.set(x, y, z), ID_Q, s.set(sx, sy, sz));
  out.multiplyMatrices(root, local);
  mesh.setMatrixAt(i, out);
}

function makeNameTexture(name: string) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.font = '700 34px Jua, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round'; g.lineWidth = 8; g.strokeStyle = 'rgba(59,47,99,0.9)';
  g.strokeText(name, 128, 34);
  g.fillStyle = '#ffffff';
  g.fillText(name, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function Characters({ nameRange = 22 }: { nameRange?: number }) {
  const quality = useStore((st) => st.quality);
  const seg = quality === 'low' ? [12, 8] : [24, 16];
  const sphere = useMemo(() => new THREE.SphereGeometry(1, seg[0], seg[1]), [seg[0], seg[1]]);
  const small = useMemo(() => new THREE.SphereGeometry(1, quality === 'low' ? 8 : 12, quality === 'low' ? 6 : 9), [quality]);
  const disc = useMemo(() => new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2), []);
  const bodies = useRef<THREE.InstancedMesh>(null!);
  const limbs = useRef<THREE.InstancedMesh>(null!);
  const outlines = useRef<THREE.InstancedMesh>(null);
  const whites = useRef<THREE.InstancedMesh>(null!);
  const darks = useRef<THREE.InstancedMesh>(null!);
  const cheeks = useRef<THREE.InstancedMesh>(null!);
  const shadows = useRef<THREE.InstancedMesh>(null!);
  const marker = useRef<THREE.Mesh>(null!);
  const tags = useRef<THREE.Group>(null!);
  const anims = useRef(new Map<number, Anim>());
  const sprites = useRef(new Map<number, { sprite: THREE.Sprite; name: string }>());
  const camera = useThree((st) => st.camera);

  useEffect(() => () => { for (const t of sprites.current.values()) { t.sprite.material.map?.dispose(); t.sprite.material.dispose(); } }, []);

  useFrame((state, dtRaw) => {
    const dt = Math.min(0.1, dtRaw);
    const time = state.clock.elapsedTime;
    const st = useStore.getState();
    const room = st.room;
    const list = net.renderPlayers();
    const info = new Map(room?.players.map((p) => [p.id, p]) ?? []);
    // 시상식에서는 1~3위가 기뻐하고 나머지는 시무룩해한다
    let podium: number[] = [];
    if (room?.phase === 'final') podium = [...room.players].sort((a, b) => b.score - a.score).slice(0, 3).map((p) => p.id);

    const used = new Set<number>();
    let n = 0;
    let meShown = false;
    for (const p of list) {
      if (n >= N) break;
      const pi = info.get(p.id);
      if (!pi || p.flags & FLAG_HIDDEN) continue;
      used.add(p.id);
      let a = anims.current.get(p.id);
      if (!a) { a = { x: p.x, y: p.y, z: p.z, speed: 0, phase: Math.random() * 6, groundY: p.y, yaw: p.yaw, seen: time, air: 0 }; anims.current.set(p.id, a); }
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

      // 몸 전체: 위치 → 방향 → (넘어질 때) 구르기 → 찌그러짐
      const airborne = !grounded && a.air > 0.06;
      const squashY = stun ? 1 : airborne ? 1.08 : 1 - run * 0.04 * Math.sin(a.phase * 2) - (lose ? 0.08 : 0);
      const lean = stun ? time * 13 : run * 0.22;
      e.set(lean, a.yaw, stun ? Math.sin(time * 9) * 0.5 : Math.sin(a.phase) * run * 0.06, 'YXZ');
      q.setFromEuler(e);
      const py = p.y + hop + (stun ? 0.35 : 0);
      root.compose(v.set(p.x, py, p.z), q, s.set(1 / Math.sqrt(squashY), squashY, 1 / Math.sqrt(squashY)));
      if (stun) { // 몸 중심을 축으로 구른다
        local.makeTranslation(0, -0.55, 0); root.multiply(local);
        local.makeTranslation(0, 0.55, 0); root.premultiply(local);
      }

      // 몸통(달걀형) + 테두리 + 밝은 배
      part(bodies.current, n, 0, 0.64, 0, 0.44, 0.54, 0.42);
      bodies.current.setColorAt(n, col.set(pi.color));
      if (outlines.current) part(outlines.current, n, 0, 0.64, 0, 0.475, 0.575, 0.455);
      const L = n * LIMBS;
      part(limbs.current, L + 4, 0, 0.5, 0.2, 0.34, 0.36, 0.26);
      limbs.current.setColorAt(L + 4, col2.set(pi.color).lerp(WHITE, 0.45));
      // 팔다리(몸보다 조금 진한 색)
      col2.set(pi.color).multiplyScalar(0.8);
      const stride = Math.sin(a.phase) * 0.22 * run, lift = Math.max(0, Math.cos(a.phase)) * 0.14 * run;
      const lift2 = Math.max(0, -Math.cos(a.phase)) * 0.14 * run;
      const tuck = airborne ? 0.1 : 0;
      const handUp = win ? 0.45 + Math.sin(time * 10 + p.id) * 0.06 : airborne || stun ? 0.32 : lose ? -0.12 : 0;
      part(limbs.current, L, -0.19, 0.1 + lift + tuck, stride + 0.04, 0.15, 0.11, 0.2);
      part(limbs.current, L + 1, 0.19, 0.1 + lift2 + tuck, -stride + 0.04, 0.15, 0.11, 0.2);
      part(limbs.current, L + 2, -0.49, 0.56 + handUp, -stride * 0.9, 0.13, 0.13, 0.13);
      part(limbs.current, L + 3, 0.49, 0.56 + handUp, stride * 0.9, 0.13, 0.13, 0.13);
      for (let k = 0; k < 4; k++) limbs.current.setColorAt(L + k, col2);

      // 머리 장식: 번호마다 다른 모양(귀, 방울, 볏, 양갈래, 새싹)이라 멀리서도 구별된다
      const bob = Math.sin(a.phase * 2) * 0.03 * run + (airborne ? 0.05 : 0);
      const kind = p.id % 5;
      for (let k = 5; k < 8; k++) limbs.current.setMatrixAt(L + k, ZERO);
      if (kind === 0) {
        part(limbs.current, L + 5, -0.27, 1.1 + bob, 0, 0.14, 0.14, 0.1);
        part(limbs.current, L + 6, 0.27, 1.1 + bob, 0, 0.14, 0.14, 0.1);
        limbs.current.setColorAt(L + 5, col2); limbs.current.setColorAt(L + 6, col2);
      } else if (kind === 1) {
        part(limbs.current, L + 5, 0, 1.25 + bob * 2, 0, 0.16, 0.16, 0.16);
        limbs.current.setColorAt(L + 5, WHITE);
      } else if (kind === 2) {
        col2.set(pi.color).offsetHSL(0.5, 0, 0);
        for (let k = 0; k < 3; k++) {
          part(limbs.current, L + 5 + k, 0, 1.17 - Math.abs(k - 1) * 0.07 + bob, (k - 1) * 0.17, 0.07, 0.13, 0.11);
          limbs.current.setColorAt(L + 5 + k, col2);
        }
      } else if (kind === 3) {
        part(limbs.current, L + 5, -0.43, 0.98 + bob, -0.06, 0.16, 0.16, 0.16);
        part(limbs.current, L + 6, 0.43, 0.98 + bob, -0.06, 0.16, 0.16, 0.16);
        limbs.current.setColorAt(L + 5, col2); limbs.current.setColorAt(L + 6, col2);
      } else {
        part(limbs.current, L + 5, -0.11, 1.26 + bob * 2, 0, 0.13, 0.045, 0.08);
        part(limbs.current, L + 6, 0.11, 1.26 + bob * 2, 0, 0.13, 0.045, 0.08);
        part(limbs.current, L + 7, 0, 1.19 + bob, 0, 0.035, 0.07, 0.035);
        for (let k = 5; k < 8; k++) limbs.current.setColorAt(L + k, LEAF);
      }

      // 표정: 넘어지면 눈이 휘둥그레, 기쁘면 웃는 눈과 벌린 입, 평소엔 가끔 깜빡임
      const blink = !stun && !win && (time * 0.6 + p.id * 0.37) % 1 > 0.95;
      const eyeY = stun ? 0.16 : win || blink ? 0.03 : lose ? 0.08 : 0.135;
      const eyeX = stun ? 0.15 : 0.115;
      const pup = stun ? 0.035 : win || blink ? 0 : 0.068;
      const look = lose ? -0.04 : 0;
      const W = n * 4;
      part(whites.current, W, -0.16, 0.82, 0.325, eyeX, eyeY, 0.07);
      part(whites.current, W + 1, 0.16, 0.82, 0.325, eyeX, eyeY, 0.07);
      const hl = pup > 0.05 ? 0.024 : 0; // 눈동자 반짝임
      part(whites.current, W + 2, -0.135, 0.862 + look, 0.425, hl, hl, 0.012);
      part(whites.current, W + 3, 0.185, 0.862 + look, 0.425, hl, hl, 0.012);
      const D = n * 3;
      part(darks.current, D, -0.16, 0.825 + look, 0.375, pup, pup * 1.15, 0.035);
      part(darks.current, D + 1, 0.16, 0.825 + look, 0.375, pup, pup * 1.15, 0.035);
      // 입
      const mw = win ? 0.075 : stun ? 0.045 : lose ? 0.05 : 0.04, mh = win ? 0.06 : stun ? 0.055 : 0.018;
      part(darks.current, D + 2, 0, 0.665, 0.405, mw, mh, 0.03);
      part(cheeks.current, n * 2, -0.29, 0.68, 0.275, 0.085, 0.05, 0.04);
      part(cheeks.current, n * 2 + 1, 0.29, 0.68, 0.275, 0.085, 0.05, 0.04);

      // 바닥 그림자: 높이 뛸수록 작아져서 착지 지점을 가늠하게 해 준다
      const h = Math.max(0, p.y - a.groundY);
      const sh = Math.max(0.15, 0.5 - h * 0.08);
      local.compose(v.set(p.x, a.groundY + 0.03, p.z), ID_Q, s.set(sh, 1, sh));
      shadows.current.setMatrixAt(n, h > 6 ? ZERO : local);

      // 닉네임표: 가까운 캐릭터만 보인다
      let tag = sprites.current.get(p.id);
      if (!tag || tag.name !== pi.name) {
        if (tag) { tags.current.remove(tag.sprite); tag.sprite.material.map?.dispose(); tag.sprite.material.dispose(); }
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeNameTexture(pi.name), depthWrite: false, transparent: true }));
        sprite.scale.set(2.2, 0.55, 1);
        sprite.renderOrder = 5;
        tags.current.add(sprite);
        tag = { sprite, name: pi.name };
        sprites.current.set(p.id, tag);
      }
      const d = camera.position.distanceTo(v.set(p.x, p.y, p.z));
      tag.sprite.visible = !p.isMe && d < nameRange;
      if (tag.sprite.visible) {
        tag.sprite.position.set(p.x, py + 1.78, p.z);
        tag.sprite.material.opacity = Math.min(1, (nameRange - d) / 4);
        const k = nameRange > 30 ? Math.max(1, d / 16) : 1; // 교사용 원경에서는 글자를 키운다
        tag.sprite.scale.set(2.2 * k, 0.55 * k, 1);
      }
      if (p.isMe) {
        meShown = true;
        marker.current.position.set(p.x, py + 1.9 + Math.sin(time * 4) * 0.08, p.z);
        marker.current.rotation.y = time * 2;
      }
      n++;
    }
    marker.current.visible = meShown;
    for (const [id, t] of sprites.current) if (!used.has(id)) t.sprite.visible = false;
    for (const id of anims.current.keys()) if (!used.has(id)) anims.current.delete(id);

    const set = (m: THREE.InstancedMesh, count: number) => {
      m.count = count;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    };
    set(bodies.current, n); set(limbs.current, n * LIMBS); set(whites.current, n * 4);
    if (outlines.current) set(outlines.current, n);
    set(darks.current, n * 3); set(cheeks.current, n * 2); set(shadows.current, n);
  });

  const shadow = quality === 'high';
  const low = quality === 'low';
  return (
    <group>
      <instancedMesh ref={bodies} args={[sphere, undefined, N]} frustumCulled={false} castShadow={shadow}>
        {low ? <meshLambertMaterial /> : <meshStandardMaterial roughness={0.42} metalness={0} />}
      </instancedMesh>
      {!low && (
        <instancedMesh ref={outlines} args={[sphere, undefined, N]} frustumCulled={false}>
          <meshBasicMaterial color="#2b2145" side={THREE.BackSide} />
        </instancedMesh>
      )}
      <instancedMesh ref={limbs} args={[small, undefined, N * LIMBS]} frustumCulled={false} castShadow={shadow}>
        {low ? <meshLambertMaterial /> : <meshStandardMaterial roughness={0.5} metalness={0} />}
      </instancedMesh>
      <instancedMesh ref={whites} args={[small, undefined, N * 4]} frustumCulled={false}>
        <meshBasicMaterial color="#ffffff" />
      </instancedMesh>
      <instancedMesh ref={darks} args={[small, undefined, N * 3]} frustumCulled={false}>
        <meshBasicMaterial color="#2b2145" />
      </instancedMesh>
      <instancedMesh ref={cheeks} args={[small, undefined, N * 2]} frustumCulled={false}>
        <meshBasicMaterial color="#ff6f9f" transparent opacity={0.7} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={shadows} args={[disc, undefined, N]} frustumCulled={false} renderOrder={1}>
        <meshBasicMaterial color="#1f1640" transparent opacity={0.3} depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
      </instancedMesh>
      <mesh ref={marker} visible={false}>
        <coneGeometry args={[0.18, 0.34, 4]} />
        <meshBasicMaterial color="#ffd84d" />
      </mesh>
      <group ref={tags} />
    </group>
  );
}
