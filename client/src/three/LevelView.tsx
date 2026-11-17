import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { ballPos, chemDoorOrder, moverOffset, sweeperAngle, type LevelDef, type Tile } from '@shared';
import { net } from '../game/net';
import { play } from '../game/sound';
import { useStore } from '../game/store';

const dummy = new THREE.Object3D();
const col = new THREE.Color();
const CANDY = ['#ff4f8b', '#ffd43b', '#4dabf7', '#5fe0a8', '#b693ff', '#ff9f43'];

/**
 * 바닥·발판용 재질. 셰이더에서 무늬를 그려 텍스처 없이도 장난감 매트처럼 보이게 한다.
 * 윗면: 2m 체크무늬 + 흰 테두리 / 옆면: 진한 색 + 위쪽 흰 띠
 */
function makeBlockMaterial(low: boolean, disc = false) {
  const m = low ? new THREE.MeshLambertMaterial() : new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0 });
  if (disc) m.defines = { ...(m.defines ?? {}), DISC: 1 };
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLPos;\nvarying vec3 vONormal;\nvarying vec3 vBScale;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLPos = position; vONormal = normal;
        #ifdef USE_INSTANCING
          vBScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #else
          vBScale = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLPos;\nvarying vec3 vONormal;\nvarying vec3 vBScale;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 m = vLPos * vBScale;
        if (vONormal.y > 0.5) {
          vec2 t = floor((m.xz + 500.0) / 2.0);
          diffuseColor.rgb *= mix(1.0, 0.88, mod(t.x + t.y, 2.0));
          #ifdef DISC
            float e = vBScale.x * (1.0 - length(vLPos.xz));
          #else
            float e = min(vBScale.x - abs(m.x), vBScale.z - abs(m.z));
          #endif
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), (1.0 - smoothstep(0.2, 0.26, e)) * 0.9);
        } else if (vONormal.y > -0.5) {
          float fromTop = vBScale.y - m.y;
          vec3 side = diffuseColor.rgb * vec3(0.62, 0.56, 0.74);
          float stripe = step(0.5, fract((m.x + m.z) * 0.5 + m.y * 0.5));
          side *= mix(1.0, 0.9, stripe);
          diffuseColor.rgb = mix(side, vec3(1.0), (1.0 - smoothstep(0.16, 0.2, fromTop)) * 0.9);
        } else {
          diffuseColor.rgb *= 0.5;
        }`);
  };
  return m;
}

function stripeTexture(a: string, b: string, bands = 8, alongU = false) {
  const c = document.createElement('canvas');
  c.width = alongU ? 256 : 16; c.height = alongU ? 16 : 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < bands; i++) {
    g.fillStyle = i % 2 ? a : b;
    if (alongU) g.fillRect((i * 256) / bands, 0, 256 / bands + 1, 16); else g.fillRect(0, (i * 256) / bands, 16, 256 / bands + 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function bannerTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d')!;
  for (let x = 0; x < 16; x++) for (let y = 0; y < 3; y++) {
    g.fillStyle = (x + y) % 2 ? '#2b2145' : '#ffffff';
    g.fillRect(x * 32, y * 32, 32, 32);
  }
  g.fillStyle = '#ff4f8b'; g.beginPath(); g.roundRect(126, 10, 260, 76, 24); g.fill();
  g.fillStyle = '#fff'; g.font = '700 54px Jua, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('결승!', 256, 52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 시드 고정 난수: 장식 배치가 매 프레임·매 기기 같도록 */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
}

/** 맵의 범위(장식 배치용) */
function bounds(level: LevelDef) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = -Infinity;
  for (const b of [...level.statics, ...level.movers, ...(level.tiles ?? [])]) {
    x0 = Math.min(x0, b.p[0] - b.h[0]); x1 = Math.max(x1, b.p[0] + b.h[0]);
    z0 = Math.min(z0, b.p[2] - b.h[2]); z1 = Math.max(z1, b.p[2] + b.h[2]);
    y1 = Math.max(y1, b.p[1] + b.h[1]);
  }
  return { x0, x1, z0, z1, y1 };
}

/**
 * 판정과 무관한 꾸밈: 구름 바다, 떠다니는 풍선과 고리, 체크포인트 아치.
 * 전부 걸을 수 있는 영역 바깥에만 놓아서 "밟을 수 있나?" 하는 혼동이 없게 한다.
 */
function Decor({ level, low, hi }: { level: LevelDef; low: boolean; hi: boolean }) {
  const clouds = useRef<THREE.InstancedMesh>(null!);
  const balloons = useRef<THREE.InstancedMesh>(null!);
  const rings = useRef<THREE.InstancedMesh>(null!);
  const posts = useRef<THREE.InstancedMesh>(null!);
  // 구름과 풍선은 멀리 있는 장식이라 거친 구로 충분하다(높음 화질만 매끈하게)
  const sphere = useMemo(() => new THREE.SphereGeometry(1, low ? 8 : hi ? 14 : 10, low ? 6 : hi ? 10 : 7), [low, hi]);
  const torus = useMemo(() => new THREE.TorusGeometry(1, 0.28, low ? 6 : 10, low ? 14 : 24), [low]);
  const cyl = useMemo(() => new THREE.CylinderGeometry(1, 1, 2, 12), []);
  const postTex = useMemo(() => { const t = stripeTexture('#ffffff', '#ff4f8b', 10); return t; }, []);
  const B = useMemo(() => bounds(level), [level]);
  const nCloud = low ? 60 : hi ? 130 : 95, nBalloon = low ? 14 : 30, nRing = low ? 5 : 10;
  const arches = level.checkpoints.slice(1, level.finish ? -1 : undefined);
  const balloonData = useMemo(() => {
    const r = seeded(77);
    const far = level.track ? 5 : 22; // 경기장을 돌며 비추는 관전 카메라에 걸리지 않게 멀리 둔다
    return Array.from({ length: nBalloon }, (_, i) => {
      const side = i % 2 ? 1 : -1;
      return {
        x: (side > 0 ? B.x1 : B.x0) + side * (far + r() * 22), y: B.y1 + 1 + r() * 14,
        z: B.z0 - 10 + r() * (B.z1 - B.z0 + 30), s: 0.9 + r() * 1.5, ph: r() * 6.28, c: CANDY[i % CANDY.length],
      };
    });
  }, [B, nBalloon]);

  useLayoutEffect(() => {
    const r = seeded(11);
    // 구름 바다: 경기장 아래와 옆을 덮어 "하늘 위에 떠 있는" 느낌을 만든다
    for (let i = 0; i < nCloud; i++) {
      const x = B.x0 - 45 + r() * (B.x1 - B.x0 + 90), z = B.z0 - 30 + r() * (B.z1 - B.z0 + 90);
      const under = x > B.x0 - 3 && x < B.x1 + 3;
      dummy.position.set(x, Math.min(level.killY, -9) - (under ? 9 : 7) - r() * 6, z);
      const s = 3.5 + r() * 4.5;
      dummy.scale.set(s * 1.6, s * 0.6, s * 1.3);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      clouds.current.setMatrixAt(i, dummy.matrix);
    }
    clouds.current.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < nRing; i++) {
      const side = i % 2 ? 1 : -1;
      dummy.position.set((side > 0 ? B.x1 : B.x0) + side * ((level.track ? 9 : 24) + r() * 16), B.y1 + 2 + r() * 10, B.z0 + r() * (B.z1 - B.z0 + 20));
      const s = 1.8 + r() * 2.2;
      dummy.scale.set(s, s, s);
      dummy.rotation.set(r() * 1.2 - 0.6, r() * 3, r() * 0.8);
      dummy.updateMatrix();
      rings.current.setMatrixAt(i, dummy.matrix);
      rings.current.setColorAt(i, col.set(CANDY[(i + 2) % CANDY.length]));
    }
    rings.current.instanceMatrix.needsUpdate = true;
    if (rings.current.instanceColor) rings.current.instanceColor.needsUpdate = true;
    balloonData.forEach((b, i) => balloons.current.setColorAt(i, col.set(b.c)));
    if (balloons.current.instanceColor) balloons.current.instanceColor.needsUpdate = true;
    // 체크포인트 아치 기둥(트랙 바깥에서 구름 아래까지 내려간다)
    arches.forEach((c, i) => {
      for (let k = 0; k < 2; k++) {
        const x = (k ? 1 : -1) * (c.zone.h[0] - 4 + 1.1);
        dummy.position.set(x, c.spawn[1] - 5, c.zone.p[2]);
        dummy.scale.set(0.38, 10.2, 0.38);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        posts.current.setMatrixAt(i * 2 + k, dummy.matrix);
      }
    });
    posts.current.instanceMatrix.needsUpdate = true;
  }, [level, B, nCloud, nRing]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    balloonData.forEach((b, i) => {
      dummy.position.set(b.x + Math.sin(t * 0.3 + b.ph) * 0.8, b.y + Math.sin(t * 0.7 + b.ph) * 0.9, b.z);
      dummy.scale.set(b.s, b.s * 1.18, b.s);
      dummy.rotation.set(0, 0, Math.sin(t * 0.5 + b.ph) * 0.12);
      dummy.updateMatrix();
      balloons.current.setMatrixAt(i, dummy.matrix);
    });
    balloons.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={clouds} args={[sphere, undefined, nCloud]} frustumCulled={false}>
        <meshLambertMaterial color="#eef3ff" emissive="#a9b8f5" emissiveIntensity={0.2} />
      </instancedMesh>
      <instancedMesh ref={balloons} args={[sphere, undefined, nBalloon]} frustumCulled={false}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={rings} args={[torus, undefined, nRing]} frustumCulled={false}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={posts} args={[cyl, undefined, Math.max(1, arches.length * 2)]} count={arches.length * 2} frustumCulled={false}>
        <meshLambertMaterial map={postTex} />
      </instancedMesh>
      {arches.map((c, i) => {
        const w = c.zone.h[0] - 4 + 1.1;
        const color = CANDY[(i + 1) % CANDY.length];
        return (
          <group key={i} position={[0, c.spawn[1] + 5.2, c.zone.p[2]]}>
            <mesh rotation={[0, 0, Math.PI / 2]}>
              <capsuleGeometry args={[0.55, w * 2, 4, 12]} />
              <meshLambertMaterial color={color} />
            </mesh>
            {[-1, 1].map((sx) => (
              <mesh key={sx} position={[sx * w, 0.3, 0]}>
                <sphereGeometry args={[0.85, 14, 10]} />
                <meshLambertMaterial color="#ffd43b" />
              </mesh>
            ))}
          </group>
        );
      })}
    </group>
  );
}

const WARN = new THREE.Color('#ffffff');

/** 발판이 지금 얼마나 '사라져' 있는지: 0 = 멀쩡, 1 = 완전히 없음. 사라질 때와 돌아올 때 0.4초에 걸쳐 변한다. */
function goneAmount(b: Tile, t: number): number {
  if (t >= b.offAt) return Math.min(1, (t - b.offAt) / 0.4);
  if (b.gaps) for (const g of b.gaps) {
    if (t >= g[0] && t < g[1]) return Math.min(1, (t - g[0]) / 0.4);
    if (t >= g[1] && t < g[1] + 0.4) return 1 - (t - g[1]) / 0.4;
  }
  return 0;
}

/** 사라지는 발판: 사라지기 전에 깜빡이며 떨다가, 시간이 되면 아래로 떨어진다. */
function Tiles({ level, low, cheap }: { level: LevelDef; low: boolean; cheap: boolean }) {
  const all = level.tiles ?? [];
  const boxes = useMemo(() => all.filter((t) => t.shape === 'box'), [level]);
  const discs = useMemo(() => all.filter((t) => t.shape === 'disc'), [level]);
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const discGroup = useRef<THREE.Group>(null!);
  const box = useMemo(() => new THREE.BoxGeometry(2, 2, 2), []);
  const cyl = useMemo(() => new THREE.CylinderGeometry(1, 1, 2, low ? 32 : 56), [low]);
  const mat = useMemo(() => makeBlockMaterial(cheap), [cheap]);
  const discMats = useMemo(() => discs.map((d) => { const m = makeBlockMaterial(cheap, true); m.color.set(d.color ?? '#ffffff'); return m; }), [discs, cheap]);
  const base = useMemo(() => boxes.map((b) => new THREE.Color(b.color ?? '#ffffff')), [boxes]);
  useEffect(() => () => { mat.dispose(); discMats.forEach((m) => m.dispose()); }, [mat, discMats]);

  useFrame(() => {
    const t = net.levelTime();
    boxes.forEach((b, i) => {
      const k = goneAmount(b, t);
      let y = b.p[1], sc = 1, dx = 0;
      if (k > 0) {
        y -= k * k * 4; sc = 1 - k;
        mesh.current.setColorAt(i, col.copy(base[i]).lerp(WARN, k));
      } else if (t >= b.warnAt) {
        // 남은 시간이 줄수록 더 빨리 깜빡인다
        const left = b.offAt - t;
        const f = 0.5 + 0.5 * Math.sin(t * (left < 0.7 ? 30 : 14));
        mesh.current.setColorAt(i, col.copy(base[i]).lerp(WARN, f * 0.75));
        dx = Math.sin(t * 40 + i) * 0.035;
      } else mesh.current.setColorAt(i, base[i]);
      dummy.position.set(b.p[0] + dx, y, b.p[2]);
      dummy.scale.set(b.h[0] * sc, b.h[1] * sc, b.h[2] * sc);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
    });
    if (boxes.length) {
      mesh.current.instanceMatrix.needsUpdate = true;
      if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    }
    discs.forEach((d, i) => {
      const m = discGroup.current.children[i] as THREE.Mesh;
      const gone = t - d.offAt;
      m.visible = gone < 1.2;
      m.position.y = d.p[1] - (gone > 0 ? gone * gone * 14 : 0);
      const warn = gone < 0 && t >= d.warnAt;
      const f = warn ? 0.5 + 0.5 * Math.sin(t * (d.offAt - t < 1 ? 28 : 12)) : 0;
      discMats[i].emissive.setScalar(f * 0.45);
    });
  });

  return (
    <group>
      <instancedMesh ref={mesh} args={[box, mat, Math.max(1, boxes.length)]} count={boxes.length} frustumCulled={false} />
      <group ref={discGroup}>
        {discs.map((d, i) => (
          <mesh key={i} geometry={cyl} material={discMats[i]} position={d.p} scale={[d.h[0], d.h[1], d.h[2]]} />
        ))}
      </group>
    </group>
  );
}

/** 폭탄: 나타나면 터질 범위를 빨간 원으로 보여 주고, 터지는 순간 불꽃이 퍼진다. */
function Bombs({ level }: { level: LevelDef }) {
  const bombs = level.bombs ?? [];
  const MAX = 10;
  const body = useRef<THREE.InstancedMesh>(null!);
  const zone = useRef<THREE.InstancedMesh>(null!);
  const edge = useRef<THREE.InstancedMesh>(null!);
  const blast = useRef<THREE.InstancedMesh>(null!);
  const sphere = useMemo(() => new THREE.SphereGeometry(1, 14, 10), []);
  const disc = useMemo(() => new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), []);
  const ring = useMemo(() => new THREE.RingGeometry(0.93, 1, 48).rotateX(-Math.PI / 2), []);
  const start = useRef(0);
  const boomed = useRef(-1);

  useFrame((state) => {
    if (!bombs.length) return; // 폭탄이 없는 맵에서는 메시도 없다
    const t = net.levelTime();
    let n = 0, nb = 0;
    // 지나간 폭탄은 건너뛴다(터지는 시각 순으로 정렬되어 있다)
    while (start.current < bombs.length && t > bombs[start.current].at + bombs[start.current].fuse + 0.6) start.current++;
    if (start.current > 0 && t < bombs[start.current - 1].at) start.current = 0;
    for (let i = start.current; i < bombs.length && n < MAX; i++) {
      const b = bombs[i];
      if (t < b.at) continue;
      const left = b.at + b.fuse - t;
      if (left > 0) {
        const k = 1 - left / b.fuse; // 0 → 1
        const pulse = 1 + Math.sin(t * (6 + k * 26)) * 0.09;
        const drop = Math.max(0, 1 - (t - b.at) / 0.25) * 5; // 하늘에서 툭 떨어진다
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(b.p[0], b.p[1] + 0.55 + drop, b.p[2]);
        dummy.scale.setScalar((b.radius > 5 ? 0.8 : 0.55) * pulse);
        dummy.updateMatrix();
        body.current.setMatrixAt(n, dummy.matrix);
        body.current.setColorAt(n, col.set(Math.sin(t * (6 + k * 26)) > 0.3 ? '#ff3b3b' : '#2b2145'));
        dummy.position.set(b.p[0], b.p[1] + 0.04, b.p[2]);
        dummy.scale.set(b.radius * k, 1, b.radius * k); // 안쪽 원이 차오르면 터진다
        dummy.updateMatrix();
        zone.current.setMatrixAt(n, dummy.matrix);
        dummy.position.y = b.p[1] + 0.05;
        dummy.scale.set(b.radius, 1, b.radius);
        dummy.updateMatrix();
        edge.current.setMatrixAt(n, dummy.matrix);
        n++;
      } else if (left > -0.45 && nb < MAX) {
        if (i > boomed.current) {
          // 가까울수록 크게 들린다
          boomed.current = i;
          const d = state.camera.position.distanceTo(dummy.position.set(b.p[0], b.p[1], b.p[2]));
          play('boom', Math.max(0.15, 1 - d / 26));
        }
        const k = -left / 0.45;
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(b.p[0], b.p[1] + 0.3, b.p[2]);
        const sc = b.radius * (0.35 + 0.65 * Math.sqrt(k));
        dummy.scale.set(sc, sc * 0.55 * (1 - k * 0.5), sc);
        dummy.updateMatrix();
        blast.current.setMatrixAt(nb, dummy.matrix);
        blast.current.setColorAt(nb, col.set(k < 0.3 ? '#fff3b0' : k < 0.65 ? '#ffb347' : '#ff6b6b'));
        nb++;
      }
    }
    for (const m of [body.current, zone.current, edge.current]) { m.count = n; m.instanceMatrix.needsUpdate = true; }
    if (body.current.instanceColor) body.current.instanceColor.needsUpdate = true;
    blast.current.count = nb; blast.current.instanceMatrix.needsUpdate = true;
    if (blast.current.instanceColor) blast.current.instanceColor.needsUpdate = true;
  });

  if (!bombs.length) return null;
  return (
    <group>
      <instancedMesh ref={body} args={[sphere, undefined, MAX]} frustumCulled={false}><meshLambertMaterial /></instancedMesh>
      <instancedMesh ref={zone} args={[disc, undefined, MAX]} frustumCulled={false} renderOrder={2}>
        <meshBasicMaterial color="#ff3b3b" transparent opacity={0.3} depthWrite={false} polygonOffset polygonOffsetFactor={-3} />
      </instancedMesh>
      <instancedMesh ref={edge} args={[ring, undefined, MAX]} frustumCulled={false} renderOrder={3}>
        <meshBasicMaterial color="#ff3b3b" transparent opacity={0.9} depthWrite={false} polygonOffset polygonOffsetFactor={-4} />
      </instancedMesh>
      <instancedMesh ref={blast} args={[sphere, undefined, MAX]} frustumCulled={false} renderOrder={4}>
        <meshBasicMaterial transparent opacity={0.7} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}

/** 글자를 폭에 맞춰 여러 줄로 나눠 그린다. 긴 보기는 글자 크기를 줄인다. */
function drawWrapped(g: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, maxH: number) {
  for (const size of [96, 72, 56, 44, 36, 30]) {
    g.font = `700 ${size}px Jua, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/(\s+)/)) {
      if (g.measureText(line + word).width > maxW && line.trim()) { lines.push(line.trim()); line = word.trim() ? word : ''; }
      else line += word;
    }
    if (line.trim()) lines.push(line.trim());
    const lh = size * 1.12;
    if (lines.length * lh <= maxH && lines.every((l) => g.measureText(l).width <= maxW) || size === 30) {
      lines.forEach((l, i) => g.fillText(l, cx, cy + (i - (lines.length - 1) / 2) * lh, maxW));
      return;
    }
  }
}

/**
 * 보기 팻말: 정답 발판 위나 화학 미로의 문 위에 보기 내용을 띄운다.
 * 상태(보임, 정답 공개, 오답 표시)가 바뀔 때만 캔버스를 다시 그린다.
 */
function QuizSigns({ level }: { level: LevelDef }) {
  const quiz = level.quiz ?? [];
  const defs = level.signs ?? [];
  const group = useRef<THREE.Group>(null!);
  const always = level.id === 'chemmaze'; // 미로는 모든 문제의 문이 동시에 보인다
  const signs = useMemo(() => defs.map(() => {
    const c = document.createElement('canvas');
    c.width = 448; c.height = 224;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { c, tex, key: '' };
  }), [level]);
  useEffect(() => () => signs.forEach((s) => s.tex.dispose()), [signs]);

  useFrame((state) => {
    if (!defs.length) return;
    const t = net.levelTime();
    let cur = -1;
    for (let i = 0; i < quiz.length; i++) if (quiz[i].at <= t) cur = i;
    const st = useStore.getState();
    const mine = st.mine;
    const seed = st.room?.levelSeed ?? 0;
    defs.forEach((d, i) => {
      const sp = group.current.children[i] as THREE.Sprite;
      const q = quiz[d.q];
      // 화학 미로: 내 번호로 정해지는 순서대로 보기를 건다. 관전자(교사 화면)에게는 보기를 띄우지 않는다.
      const opt = always ? (st.myId !== null ? chemDoorOrder(seed, st.myId, d.q)[d.o] : -1) : d.o;
      const text = q && opt >= 0 ? q.options[opt] : '';
      const visible = !!q && (always || d.q === cur) && !!text;
      sp.visible = visible;
      if (!visible) return;
      let right: boolean, bad: boolean;
      if (always) {
        right = false;
        bad = mine.wrong.some((w) => w[0] === d.q && w[1] === d.o);
        if (d.q < mine.passed) { sp.visible = false; return; } // 통과한 문제의 팻말은 치운다
      } else {
        const revealed = t >= q.revealAt && q.answer >= 0;
        right = revealed && q.answer === d.o;
        bad = revealed && !right;
      }
      const key = `${right}:${bad}:${text}`;
      const s = signs[i];
      if (s.key !== key) {
        s.key = key;
        const g = s.c.getContext('2d')!;
        g.clearRect(0, 0, 448, 224);
        g.fillStyle = bad ? 'rgba(43,33,69,0.55)' : right ? '#d3f9d8' : '#ffffff';
        g.beginPath(); g.roundRect(12, 12, 424, 200, 44); g.fill();
        g.lineWidth = 14; g.strokeStyle = right ? '#2f9e44' : bad ? '#ff6b6b' : d.color; g.stroke();
        g.fillStyle = bad ? '#ffffff' : '#2b2145';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        drawWrapped(g, (right ? '⭕ ' : bad ? '✕ ' : '') + text, 224, 116, 384, 172);
        s.tex.needsUpdate = true;
      }
      sp.position.y = d.p[1] + Math.sin(state.clock.elapsedTime * 2 + i) * 0.1;
    });
  });

  if (!defs.length) return null;
  return (
    <group ref={group}>
      {defs.map((d, i) => (
        <sprite key={i} position={d.p} scale={[3.6, 1.8, 1]} renderOrder={6} visible={false}>
          <spriteMaterial map={signs[i].tex} transparent depthWrite={false} />
        </sprite>
      ))}
    </group>
  );
}

/** 피구공 무늬: 배구공처럼 곡선 띠가 있는 흰 공에 색 띠를 두른다 */
function ballTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#d9d9d9';
  for (let i = 0; i < 3; i++) { g.beginPath(); g.ellipse(42 + i * 86, 64, 30, 70, 0, 0, Math.PI * 2); g.fill(); }
  g.strokeStyle = '#2b2145'; g.lineWidth = 5;
  for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.bezierCurveTo(i * 64 + 26, 40, i * 64 - 26, 88, i * 64, 128); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const UP = new THREE.Vector3(0, 1, 0);
const AXIS = new THREE.Vector3();
const BQ = new THREE.Quaternion();

/**
 * 굴러오는 공: 들어오기 1.5초 전부터 경기장 가장자리에 빨간 화살표로 예고하고,
 * 공은 가장자리 바로 밖에서 툭 튀어나와 굴러 들어온다.
 */
function Balls({ level }: { level: LevelDef }) {
  const balls = level.balls ?? [];
  const MAX = 24;
  const body = useRef<THREE.InstancedMesh>(null!);
  const shadow = useRef<THREE.InstancedMesh>(null!);
  const warn = useRef<THREE.InstancedMesh>(null!);
  const sphere = useMemo(() => new THREE.SphereGeometry(1, 20, 14), []);
  const disc = useMemo(() => new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2), []);
  // 바닥에 눕힌 화살표(뾰족한 쪽이 +z)
  const arrow = useMemo(() => {
    const sh = new THREE.Shape();
    sh.moveTo(0, 1); sh.lineTo(0.75, 0); sh.lineTo(0.3, 0); sh.lineTo(0.3, -0.9); sh.lineTo(-0.3, -0.9); sh.lineTo(-0.3, 0); sh.lineTo(-0.75, 0); sh.closePath();
    return new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2).rotateY(Math.PI);
  }, []);
  const tex = useMemo(() => ballTexture(), []);
  const first = useRef(0);
  const warned = useRef(-1);

  useFrame((state) => {
    if (!balls.length) return;
    const t = net.levelTime();
    // 이미 지나간 공은 다시 보지 않는다(출발 시각 순으로 정렬되어 있다)
    while (first.current < balls.length && balls[first.current].end < t - 0.5 && balls[first.current].at < t) first.current++;
    if (first.current > 0 && t < balls[first.current - 1].at) first.current = 0;
    let n = 0, w = 0;
    const pulse = 0.75 + Math.sin(state.clock.elapsedTime * 16) * 0.25;
    for (let i = first.current; i < balls.length && (n < MAX || w < MAX); i++) {
      const b = balls[i];
      if (b.enter - 1.5 > t) break;
      if (t > b.end) continue;
      // 내 쪽으로 오는 공이면 경고음을 낸다(뒤에서 오는 공은 화면에 안 보이므로)
      if (i > warned.current && t >= b.enter - 0.9) {
        warned.current = i;
        const me = net.myState();
        if (me) {
          const rx = me.x - b.x, rz = me.z - b.z;
          const side = Math.abs(rx * b.dz - rz * b.dx);
          if (side < b.r + 2.5 && rx * b.dx + rz * b.dz > 0) play('warn', 1.2);
        }
      }
      // 예고 화살표: 공이 들어올 지점에서 안쪽을 가리킨다
      if (t < b.enter && w < MAX) {
        const [ex, ez] = ballPos(b, b.enter);
        const k = 1 - (b.enter - t) / 1.5;
        dummy.position.set(ex - b.dx * 0.6, 0.05, ez - b.dz * 0.6);
        dummy.rotation.set(0, Math.atan2(b.dx, b.dz), 0);
        dummy.scale.setScalar((b.r > 1 ? 1.5 : 1.05) * (0.6 + 0.4 * k) * pulse);
        dummy.updateMatrix();
        warn.current.setMatrixAt(w++, dummy.matrix);
      }
      // 공: 가장자리 조금 밖에서 나타나 굴러간다
      const appear = b.enter - 0.45;
      if (t >= appear && n < MAX) {
        const [x, z] = ballPos(b, t);
        const pop = Math.min(1, (t - appear) / 0.18);
        const dist = (t - b.at) * b.speed;
        AXIS.set(b.dz, 0, -b.dx).normalize();
        BQ.setFromAxisAngle(AXIS, dist / b.r);
        dummy.position.set(x, b.r + Math.max(0, 1 - pop) * 0.8, z);
        dummy.quaternion.copy(BQ);
        dummy.scale.setScalar(b.r * pop);
        dummy.updateMatrix();
        body.current.setMatrixAt(n, dummy.matrix);
        body.current.setColorAt(n, col.set(b.color).lerp(WHITE_C, 0.15));
        dummy.quaternion.identity();
        dummy.position.set(x, 0.04, z);
        dummy.scale.set(b.r * 0.95 * pop, 1, b.r * 0.95 * pop);
        dummy.updateMatrix();
        shadow.current.setMatrixAt(n, dummy.matrix);
        n++;
      }
    }
    body.current.count = n; shadow.current.count = n; warn.current.count = w;
    body.current.instanceMatrix.needsUpdate = true; shadow.current.instanceMatrix.needsUpdate = true; warn.current.instanceMatrix.needsUpdate = true;
    if (body.current.instanceColor) body.current.instanceColor.needsUpdate = true;
  });

  if (!balls.length) return null;
  return (
    <group>
      <instancedMesh ref={body} args={[sphere, undefined, MAX]} frustumCulled={false}>
        <meshLambertMaterial map={tex} />
      </instancedMesh>
      <instancedMesh ref={shadow} args={[disc, undefined, MAX]} frustumCulled={false} renderOrder={1}>
        <meshBasicMaterial color="#1f1640" transparent opacity={0.3} depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
      </instancedMesh>
      <instancedMesh ref={warn} args={[arrow, undefined, MAX]} frustumCulled={false} renderOrder={2}>
        <meshBasicMaterial color="#ff3b3b" transparent opacity={0.85} depthWrite={false} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-3} />
      </instancedMesh>
    </group>
  );
}
const WHITE_C = new THREE.Color('#ffffff');

const GEM1 = new THREE.Color('#00a8ff');
const GEM3 = new THREE.Color('#ffb700');

/** 보물: 일정대로 나타나 빙글빙글 돌고, 누가 가져가면(서버 통보) 사라진다. */
function Items({ level }: { level: LevelDef }) {
  const items = level.items ?? [];
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const geo = useMemo(() => new THREE.OctahedronGeometry(1, 0), []);
  const cache = useRef<{ src: number[] | null; set: Set<number> }>({ src: null, set: new Set() });
  const first = useRef(0);

  useFrame(() => {
    if (!items.length) return;
    const t = net.levelTime();
    const taken = useStore.getState().game?.taken ?? null;
    if (taken !== cache.current.src) cache.current = { src: taken, set: new Set(taken ?? []) };
    const set = cache.current.set;
    // 앞쪽의 이미 가져간 보물은 다시 보지 않는다
    while (first.current < items.length && set.has(first.current)) first.current++;
    let n = 0;
    for (let i = first.current; i < items.length; i++) {
      const it = items[i];
      if (it.at > t) break;
      if (set.has(i)) continue;
      const age = t - it.at;
      const pop = Math.min(1, age / 0.3);
      const sc = (it.value > 1 ? 0.5 : 0.34) * (pop + Math.sin(pop * Math.PI) * 0.35);
      dummy.position.set(it.p[0], it.p[1] + Math.sin(t * 3 + i) * 0.12, it.p[2]);
      dummy.rotation.set(0, t * 2.5 + i, 0);
      dummy.scale.set(sc, sc * 1.35, sc);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(n, dummy.matrix);
      mesh.current.setColorAt(n, it.value > 1 ? GEM3 : GEM1);
      n++;
    }
    mesh.current.count = n;
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
  });

  if (!items.length) return null;
  return (
    <instancedMesh ref={mesh} args={[geo, undefined, items.length]} frustumCulled={false}>
      <meshLambertMaterial flatShading />
    </instancedMesh>
  );
}

/** 시상식 색종이: 시상대 위에서 팔랑팔랑 떨어진다. */
export function Confetti({ z }: { z: number }) {
  const low = useStore((s) => s.quality === 'low');
  const n = low ? 60 : 160;
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const geo = useMemo(() => new THREE.PlaneGeometry(0.22, 0.12), []);
  const bits = useMemo(() => Array.from({ length: n }, (_, i) => ({
    x: (Math.random() * 2 - 1) * 9, z: z + (Math.random() * 2 - 1) * 5 - 2, y: Math.random() * 12,
    v: 1.4 + Math.random() * 1.6, s: Math.random() * 6.28, c: CANDY[i % CANDY.length],
  })), [n, z]);
  useLayoutEffect(() => {
    bits.forEach((b, i) => mesh.current.setColorAt(i, col.set(b.c)));
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
  }, [bits]);
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    bits.forEach((b, i) => {
      b.y -= b.v * Math.min(0.05, dt);
      if (b.y < 0) b.y = 11 + Math.random() * 2;
      dummy.position.set(b.x + Math.sin(t * 1.5 + b.s) * 0.5, b.y, b.z);
      dummy.rotation.set(t * 3 + b.s, t * 2 + b.s * 2, b.s);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[geo, undefined, n]} frustumCulled={false}>
      <meshBasicMaterial side={THREE.DoubleSide} />
    </instancedMesh>
  );
}


const M4 = new THREE.Matrix4();
const M4b = new THREE.Matrix4();
const QY = new THREE.Quaternion();
const QZ = new THREE.Quaternion();
const V3 = new THREE.Vector3();
const S3 = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * 움직이는 벽·발판을 종류별로 한 번에 그린다(문이 12개인 미로도 그리기 명령 4번).
 * 미는 벽에는 심술궂은 눈(흰자, 눈동자, 눈썹)을 단다.
 */
function MoversView({ level, mat, shadow }: { level: LevelDef; mat: THREE.Material; shadow: boolean }) {
  const movers = level.movers;
  const walls = useMemo(() => movers.map((m, i) => ({ m, i })).filter((x) => x.m.kind === 'wall'), [level]);
  const body = useRef<THREE.InstancedMesh>(null!);
  const whites = useRef<THREE.InstancedMesh>(null!);
  const pupils = useRef<THREE.InstancedMesh>(null!);
  const brows = useRef<THREE.InstancedMesh>(null!);
  const box = useMemo(() => new THREE.BoxGeometry(2, 2, 2), []);
  const ball = useMemo(() => new THREE.SphereGeometry(1, 12, 8), []);
  const eyes = walls.length * 4; // 벽 하나에 앞뒤 두 면, 면마다 눈 두 개

  useLayoutEffect(() => {
    if (!movers.length) return; // 움직이는 벽·발판이 없는 맵
    movers.forEach((m, i) => body.current.setColorAt(i, col.set(m.color ?? '#ffc078')));
    if (body.current.instanceColor) body.current.instanceColor.needsUpdate = true;
  }, [level]);

  useFrame(() => {
    if (!movers.length) return;
    const t = net.levelTime();
    movers.forEach((m, i) => {
      const o = moverOffset(m, t);
      M4.compose(V3.set(m.p[0] + o[0], m.p[1] + o[1], m.p[2] + o[2]), ID_Q4, S3.set(m.h[0], m.h[1], m.h[2]));
      body.current.setMatrixAt(i, M4);
    });
    body.current.instanceMatrix.needsUpdate = true;
    let k = 0;
    for (const { m } of walls) {
      const o = moverOffset(m, t);
      for (const face of [-1, 1]) {
        QY.setFromAxisAngle(Y_AXIS, face > 0 ? 0 : Math.PI);
        for (const ex of [-1, 1]) {
          // 눈 하나의 기준점: 벽 앞면(또는 뒷면) 위쪽, 좌우로 0.75m
          const lx = ex * 0.75 * face;
          const cx = m.p[0] + o[0] + lx, cy = m.p[1] + o[1] + m.h[1] * 0.25, cz = m.p[2] + o[2] + face * (m.h[2] + 0.02);
          const f = face; // 면이 바라보는 쪽(+z 또는 −z)
          M4.compose(V3.set(cx, cy, cz), QY, S3.set(0.5, 0.56, 0.16));
          whites.current.setMatrixAt(k, M4);
          M4.compose(V3.set(cx - ex * 0.12 * f, cy - 0.08, cz + 0.13 * f), QY, S3.set(0.22, 0.26, 0.08));
          pupils.current.setMatrixAt(k, M4);
          QZ.setFromAxisAngle(Z_AXIS, ex * 0.35);
          M4b.makeRotationFromQuaternion(QY).multiply(M4.makeRotationFromQuaternion(QZ));
          M4b.scale(S3.set(0.6, 0.13, 0.1));
          M4b.setPosition(cx, cy + 0.5, cz + 0.1 * f);
          brows.current.setMatrixAt(k, M4b);
          k++;
        }
      }
    }
    if (eyes) { whites.current.instanceMatrix.needsUpdate = true; pupils.current.instanceMatrix.needsUpdate = true; brows.current.instanceMatrix.needsUpdate = true; }
  });

  if (!movers.length) return null;
  return (
    <group>
      <instancedMesh ref={body} args={[box, mat, movers.length]} frustumCulled={false} castShadow={shadow} receiveShadow={shadow} />
      {eyes > 0 && <>
        <instancedMesh ref={whites} args={[ball, undefined, eyes]} frustumCulled={false}><meshBasicMaterial color="#ffffff" /></instancedMesh>
        <instancedMesh ref={pupils} args={[ball, undefined, eyes]} frustumCulled={false}><meshBasicMaterial color="#2b2145" /></instancedMesh>
        <instancedMesh ref={brows} args={[box, undefined, eyes]} frustumCulled={false}><meshBasicMaterial color="#2b2145" /></instancedMesh>
      </>}
    </group>
  );
}
const ID_Q4 = new THREE.Quaternion();

/** 줄무늬 봉 재질: 흰 줄과 봉마다 다른 색 줄을 번갈아 칠한다(색은 인스턴스마다 다르다) */
function makeBarMaterial(tex: THREE.Texture) {
  const m = new THREE.MeshLambertMaterial({ map: tex });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', 'float stripeMask = texture2D( map, vMapUv ).r;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = mix( vec3( 1.0 ), diffuseColor.rgb, stripeMask );');
  };
  return m;
}

/**
 * 회전봉을 부위별로 한 번에 그린다: 봉, 끝 방울, 가운데 축, 받침, 기둥(봉이 몇 개든 그리기 명령 5번).
 * 나중에 등장하는 봉은 2.5초 전부터 깜빡이며 예고한다.
 */
function SweepersView({ level, shadow }: { level: LevelDef; shadow: boolean }) {
  const list = level.sweepers;
  const n = list.length;
  const bars = useRef<THREE.InstancedMesh>(null!);
  const ends = useRef<THREE.InstancedMesh>(null!);
  const hubs = useRef<THREE.InstancedMesh>(null!);
  const bases = useRef<THREE.InstancedMesh>(null!);
  const poles = useRef<THREE.InstancedMesh>(null!);
  const cyl = useMemo(() => new THREE.CylinderGeometry(1, 1, 2, 14, 1, true).rotateZ(Math.PI / 2), []);
  const ball = useMemo(() => new THREE.SphereGeometry(1, 12, 9), []);
  const base = useMemo(() => new THREE.CylinderGeometry(0.42, 0.7, 1, 16), []);
  const pole = useMemo(() => new THREE.CylinderGeometry(1, 1, 1, 10), []);
  const tex = useMemo(() => { const t = stripeTexture('#000000', '#ffffff', 2); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 6); return t; }, []);
  const barMat = useMemo(() => makeBarMaterial(tex), [tex]);
  const hasPole = list.filter((s) => s.c[1] > s.r + 1);

  useLayoutEffect(() => {
    if (!n) return;
    list.forEach((s, i) => {
      bars.current.setColorAt(i, col.set(s.color ?? '#ff4f8b'));
      M4.compose(V3.set(s.c[0], s.c[1] - 0.25 - s.r, s.c[2]), ID_Q4, S3.set(1, 0.5 + s.r, 1));
      bases.current.setMatrixAt(i, M4);
    });
    hasPole.forEach((s, i) => { M4.compose(V3.set(s.c[0], s.c[1] - 1, s.c[2]), ID_Q4, S3.set(0.2, 2, 0.2)); poles.current.setMatrixAt(i, M4); });
    if (bars.current.instanceColor) bars.current.instanceColor.needsUpdate = true;
    bases.current.instanceMatrix.needsUpdate = true;
    if (hasPole.length) poles.current.instanceMatrix.needsUpdate = true;
  }, [level]);

  useFrame(() => {
    if (!n) return;
    const t = net.levelTime();
    list.forEach((s, i) => {
      const wait = (s.startAt ?? 0) - t;
      const show = wait <= 0 || (wait < 2.5 && (t * 5) % 1 < 0.6);
      const a = -sweeperAngle(s, t);
      QY.setFromAxisAngle(Y_AXIS, a);
      const k = show ? 1 : 0;
      M4.compose(V3.set(s.c[0], s.c[1], s.c[2]), QY, S3.set(s.len * k, s.r * k, s.r * k));
      bars.current.setMatrixAt(i, M4);
      const ca = Math.cos(a), sa = Math.sin(a);
      for (const e of [-1, 1]) {
        const d = e * (s.len - 0.1);
        M4.compose(V3.set(s.c[0] + ca * d, s.c[1], s.c[2] - sa * d), ID_Q4, S3.setScalar(s.r * 1.55 * k));
        ends.current.setMatrixAt(i * 2 + (e > 0 ? 1 : 0), M4);
      }
      M4.compose(V3.set(s.c[0], s.c[1], s.c[2]), ID_Q4, S3.setScalar(0.62 * k));
      hubs.current.setMatrixAt(i, M4);
    });
    bars.current.instanceMatrix.needsUpdate = true; ends.current.instanceMatrix.needsUpdate = true; hubs.current.instanceMatrix.needsUpdate = true;
  });

  if (!n) return null;
  return (
    <group>
      <instancedMesh ref={bars} args={[cyl, barMat, n]} frustumCulled={false} castShadow={shadow} />
      <instancedMesh ref={ends} args={[ball, undefined, n * 2]} frustumCulled={false}><meshLambertMaterial color="#ffd43b" /></instancedMesh>
      <instancedMesh ref={hubs} args={[ball, undefined, n]} frustumCulled={false}><meshLambertMaterial color="#ffffff" /></instancedMesh>
      <instancedMesh ref={bases} args={[base, undefined, n]} frustumCulled={false}><meshLambertMaterial color="#7048e8" /></instancedMesh>
      {hasPole.length > 0 && <instancedMesh ref={poles} args={[pole, undefined, hasPole.length]} frustumCulled={false}><meshLambertMaterial color="#ffffff" /></instancedMesh>}
    </group>
  );
}

/** 점프 발판: 노란 받침, 분홍 가운데, 위로 퍼지는 고리를 종류별로 한 번에 그린다 */
function PadsView({ level }: { level: LevelDef }) {
  const pads = level.pads;
  const n = pads.length;
  const plates = useRef<THREE.InstancedMesh>(null!);
  const cores = useRef<THREE.InstancedMesh>(null!);
  const rings = useRef<THREE.InstancedMesh>(null!);
  const plate = useMemo(() => new THREE.CylinderGeometry(1, 1.08, 1, 24), []);
  const core = useMemo(() => new THREE.CylinderGeometry(1, 1, 1, 20), []);
  const ring = useMemo(() => new THREE.TorusGeometry(1, 0.09, 6, 24).rotateX(Math.PI / 2), []);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true }), []);

  useLayoutEffect(() => {
    if (!n) return;
    pads.forEach((p, i) => {
      M4.compose(V3.set(p.p[0], p.p[1], p.p[2]), ID_Q4, S3.set(p.h[0], 0.14, p.h[2])); plates.current.setMatrixAt(i, M4);
      M4.compose(V3.set(p.p[0], p.p[1] + 0.09, p.p[2]), ID_Q4, S3.set(p.h[0] * 0.55, 0.05, p.h[2] * 0.55)); cores.current.setMatrixAt(i, M4);
    });
    plates.current.instanceMatrix.needsUpdate = true; cores.current.instanceMatrix.needsUpdate = true;
  }, [level]);

  useFrame((state) => {
    if (!n) return;
    const k = (state.clock.elapsedTime * 3) % 1;
    pads.forEach((p, i) => {
      const r = Math.min(p.h[0], p.h[2]) * (0.5 + k * 0.6);
      M4.compose(V3.set(p.p[0], p.p[1] + 0.12 + k * 0.9, p.p[2]), ID_Q4, S3.set(r, r, r)); rings.current.setMatrixAt(i, M4);
    });
    rings.current.instanceMatrix.needsUpdate = true;
    ringMat.opacity = 1 - k;
  });

  if (!n) return null;
  return (
    <group>
      <instancedMesh ref={plates} args={[plate, undefined, n]} frustumCulled={false}><meshLambertMaterial color="#ffd43b" emissive="#ff8a00" emissiveIntensity={0.5} /></instancedMesh>
      <instancedMesh ref={cores} args={[core, undefined, n]} frustumCulled={false}><meshBasicMaterial color="#ff4f8b" /></instancedMesh>
      <instancedMesh ref={rings} args={[ring, ringMat, n]} frustumCulled={false} />
    </group>
  );
}

/** 맵 정의(LevelDef)를 그대로 메시로 옮긴다. 고정 바닥은 InstancedMesh 하나로 그린다. */
export function LevelView({ level }: { level: LevelDef }) {
  const quality = useStore((s) => s.quality);
  const shadow = quality === 'high';
  const low = quality === 'low';
  const cheap = quality !== 'high';
  const statics = useRef<THREE.InstancedMesh>(null!);
  const strips = useRef<THREE.InstancedMesh>(null!);
  const box = useMemo(() => new THREE.BoxGeometry(2, 2, 2), []);
  const blockMat = useMemo(() => makeBlockMaterial(cheap), [cheap]);
  const banner = useMemo(() => (level.finish ? bannerTexture() : null), [level]);
  const cps = level.checkpoints.slice(1, level.finish ? -1 : undefined);
  useEffect(() => () => { blockMat.dispose(); }, [blockMat]);

  useLayoutEffect(() => {
    level.statics.forEach((b, i) => {
      dummy.position.set(b.p[0], b.p[1], b.p[2]);
      dummy.scale.set(b.h[0], b.h[1], b.h[2]);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      statics.current.setMatrixAt(i, dummy.matrix);
      statics.current.setColorAt(i, col.set(b.color ?? '#ffffff'));
    });
    statics.current.instanceMatrix.needsUpdate = true;
    if (statics.current.instanceColor) statics.current.instanceColor.needsUpdate = true;
    statics.current.computeBoundingSphere();
    cps.forEach((c, i) => {
      dummy.position.set(c.spawn[0], c.spawn[1] + 0.02, c.zone.p[2]);
      dummy.scale.set(c.zone.h[0] - 4, 0.02, 0.4);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      strips.current.setMatrixAt(i, dummy.matrix);
    });
    strips.current.instanceMatrix.needsUpdate = true;
  }, [level, low]);

  return (
    <group>
      <instancedMesh ref={statics} args={[box, blockMat, Math.max(1, level.statics.length)]} count={level.statics.length} receiveShadow={shadow} />
      <Tiles level={level} low={low} cheap={cheap} />
      <Bombs level={level} />
      <Balls level={level} />
      <QuizSigns level={level} />
      {(level.curtains ?? []).map((c, i) => (
        <mesh key={i} position={c.p} scale={[c.h[0], c.h[1], 1]}>
          <planeGeometry args={[2, 2]} />
          <meshBasicMaterial color={c.color} transparent opacity={0.42} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ))}
      <Items level={level} />
      <instancedMesh ref={strips} args={[box, undefined, Math.max(1, cps.length)]} count={cps.length}>
        <meshBasicMaterial color="#ffffff" transparent opacity={0.85} />
      </instancedMesh>
      <MoversView level={level} mat={blockMat} shadow={shadow} />
      <SweepersView level={level} shadow={shadow} />
      <PadsView level={level} />
      {level.finish && banner && (
        <mesh position={[0, level.checkpoints[level.checkpoints.length - 1].spawn[1] + 4.7, level.finish.p[2] - level.finish.h[2]]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[level.finish.h[0] * 2, 1.9]} />
          <meshBasicMaterial map={banner} side={THREE.DoubleSide} />
        </mesh>
      )}
      <Decor level={level} low={low} hi={quality === 'high'} />
    </group>
  );
}
