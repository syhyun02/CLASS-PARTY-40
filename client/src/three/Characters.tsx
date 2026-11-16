import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { FLAG_DONE, FLAG_GROUNDED, FLAG_HIDDEN, FLAG_STUN, MAX_PLAYERS } from '@shared';
import { net } from '../game/net';
import { useStore } from '../game/store';

/**
 * 오리지널 캐릭터 "몽글이": 둥근 몸, 짧은 팔다리, 머리 위 새싹 방울.
 * 40명을 부위별 InstancedMesh 6개(= 드로우콜 6번)로 그린다. 애니메이션은 전부 계산식이다.
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
  const seg = quality === 'low' ? [10, 7] : [16, 12];
  const sphere = useMemo(() => new THREE.SphereGeometry(1, seg[0], seg[1]), [seg[0], seg[1]]);
  const small = useMemo(() => new THREE.SphereGeometry(1, 8, 6), []);
  const disc = useMemo(() => new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2), []);
  const bodies = useRef<THREE.InstancedMesh>(null!);
  const limbs = useRef<THREE.InstancedMesh>(null!);
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

      part(bodies.current, n, 0, 0.62, 0, 0.42, 0.5, 0.4);
      bodies.current.setColorAt(n, col.set(pi.color));
      col.multiplyScalar(0.78);
      const stride = Math.sin(a.phase) * 0.2 * run, lift = Math.max(0, Math.cos(a.phase)) * 0.12 * run;
      const lift2 = Math.max(0, -Math.cos(a.phase)) * 0.12 * run;
      const tuck = airborne ? 0.1 : 0;
      const handUp = win ? 0.42 + Math.sin(time * 10 + p.id) * 0.06 : airborne || stun ? 0.3 : lose ? -0.12 : 0;
      part(limbs.current, n * 4, -0.17, 0.1 + lift + tuck, stride, 0.13, 0.1, 0.17);
      part(limbs.current, n * 4 + 1, 0.17, 0.1 + lift2 + tuck, -stride, 0.13, 0.1, 0.17);
      part(limbs.current, n * 4 + 2, -0.46, 0.55 + handUp, -stride * 0.9, 0.11, 0.11, 0.11);
      part(limbs.current, n * 4 + 3, 0.46, 0.55 + handUp, stride * 0.9, 0.11, 0.11, 0.11);
      for (let k = 0; k < 4; k++) limbs.current.setColorAt(n * 4 + k, col);

      // 표정: 넘어지면 눈이 휘둥그레, 기쁘면 웃는 눈, 평소엔 가끔 깜빡임
      const blink = !stun && !win && (time * 0.6 + p.id * 0.37) % 1 > 0.95;
      const eyeY = stun ? 0.135 : win || blink ? 0.03 : lose ? 0.07 : 0.11;
      const eyeX = stun ? 0.135 : 0.1;
      const pup = stun ? 0.035 : win || blink ? 0 : 0.055;
      const look = lose ? -0.04 : 0;
      part(whites.current, n * 3, -0.15, 0.78, 0.335, eyeX, eyeY, 0.06);
      part(whites.current, n * 3 + 1, 0.15, 0.78, 0.335, eyeX, eyeY, 0.06);
      // 머리 위 새싹 방울(통통 튄다)
      const bob = Math.sin(a.phase * 2) * 0.03 * run + (airborne ? 0.06 : 0);
      part(whites.current, n * 3 + 2, 0, 1.2 + bob, -0.02, 0.085, 0.085, 0.085);
      part(darks.current, n * 2, -0.15, 0.78 + look, 0.385, pup, pup, 0.03);
      part(darks.current, n * 2 + 1, 0.15, 0.78 + look, 0.385, pup, pup, 0.03);
      part(cheeks.current, n * 2, -0.27, 0.64, 0.27, 0.075, 0.045, 0.04);
      part(cheeks.current, n * 2 + 1, 0.27, 0.64, 0.27, 0.075, 0.045, 0.04);

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
        tag.sprite.position.set(p.x, py + 1.62, p.z);
        tag.sprite.material.opacity = Math.min(1, (nameRange - d) / 4);
        const k = nameRange > 30 ? Math.max(1, d / 16) : 1; // 교사용 원경에서는 글자를 키운다
        tag.sprite.scale.set(2.2 * k, 0.55 * k, 1);
      }
      if (p.isMe) {
        meShown = true;
        marker.current.position.set(p.x, py + 1.75 + Math.sin(time * 4) * 0.08, p.z);
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
    set(bodies.current, n); set(limbs.current, n * 4); set(whites.current, n * 3);
    set(darks.current, n * 2); set(cheeks.current, n * 2); set(shadows.current, n);
  });

  const shadow = quality === 'high';
  return (
    <group>
      <instancedMesh ref={bodies} args={[sphere, undefined, N]} frustumCulled={false} castShadow={shadow}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={limbs} args={[small, undefined, N * 4]} frustumCulled={false} castShadow={shadow}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={whites} args={[small, undefined, N * 3]} frustumCulled={false}>
        <meshLambertMaterial color="#ffffff" emissive="#555555" />
      </instancedMesh>
      <instancedMesh ref={darks} args={[small, undefined, N * 2]} frustumCulled={false}>
        <meshBasicMaterial color="#2b2145" />
      </instancedMesh>
      <instancedMesh ref={cheeks} args={[small, undefined, N * 2]} frustumCulled={false}>
        <meshBasicMaterial color="#ff8fb3" transparent opacity={0.75} />
      </instancedMesh>
      <instancedMesh ref={shadows} args={[disc, undefined, N]} frustumCulled={false} renderOrder={1}>
        <meshBasicMaterial color="#3b2f63" transparent opacity={0.28} depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
      </instancedMesh>
      <mesh ref={marker} visible={false}>
        <coneGeometry args={[0.16, 0.3, 4]} />
        <meshBasicMaterial color="#ffd84d" />
      </mesh>
      <group ref={tags} />
    </group>
  );
}
