import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { chemDoorOrder, moverOffset, sweeperAngle, type LevelDef, type Tile } from '@shared';
import { net } from '../game/net';
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
function Decor({ level, low }: { level: LevelDef; low: boolean }) {
  const clouds = useRef<THREE.InstancedMesh>(null!);
  const balloons = useRef<THREE.InstancedMesh>(null!);
  const rings = useRef<THREE.InstancedMesh>(null!);
  const posts = useRef<THREE.InstancedMesh>(null!);
  const sphere = useMemo(() => new THREE.SphereGeometry(1, low ? 8 : 14, low ? 6 : 10), [low]);
  const torus = useMemo(() => new THREE.TorusGeometry(1, 0.28, low ? 6 : 10, low ? 14 : 24), [low]);
  const cyl = useMemo(() => new THREE.CylinderGeometry(1, 1, 2, 12), []);
  const postTex = useMemo(() => { const t = stripeTexture('#ffffff', '#ff4f8b', 10); return t; }, []);
  const B = useMemo(() => bounds(level), [level]);
  const nCloud = low ? 60 : 130, nBalloon = low ? 14 : 30, nRing = low ? 5 : 10;
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
        {low ? <meshLambertMaterial /> : <meshStandardMaterial roughness={0.25} />}
      </instancedMesh>
      <instancedMesh ref={rings} args={[torus, undefined, nRing]} frustumCulled={false}>
        {low ? <meshLambertMaterial /> : <meshStandardMaterial roughness={0.35} />}
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
function Tiles({ level, low }: { level: LevelDef; low: boolean }) {
  const all = level.tiles ?? [];
  const boxes = useMemo(() => all.filter((t) => t.shape === 'box'), [level]);
  const discs = useMemo(() => all.filter((t) => t.shape === 'disc'), [level]);
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const discGroup = useRef<THREE.Group>(null!);
  const box = useMemo(() => new THREE.BoxGeometry(2, 2, 2), []);
  const cyl = useMemo(() => new THREE.CylinderGeometry(1, 1, 2, low ? 32 : 56), [low]);
  const mat = useMemo(() => makeBlockMaterial(low), [low]);
  const discMats = useMemo(() => discs.map((d) => { const m = makeBlockMaterial(low, true); m.color.set(d.color ?? '#ffffff'); return m; }), [discs, low]);
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

  useFrame(() => {
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

/** 맵 정의(LevelDef)를 그대로 메시로 옮긴다. 고정 바닥은 InstancedMesh 하나로 그린다. */
export function LevelView({ level }: { level: LevelDef }) {
  const quality = useStore((s) => s.quality);
  const shadow = quality === 'high';
  const low = quality === 'low';
  const statics = useRef<THREE.InstancedMesh>(null!);
  const strips = useRef<THREE.InstancedMesh>(null!);
  const movers = useRef<THREE.Group>(null!);
  const sweepers = useRef<THREE.Group>(null!);
  const pads = useRef<THREE.Group>(null!);
  const box = useMemo(() => new THREE.BoxGeometry(2, 2, 2), []);
  const blockMat = useMemo(() => makeBlockMaterial(low), [low]);
  const banner = useMemo(() => (level.finish ? bannerTexture() : null), [level]);
  const barTex = useMemo(() => new Map<string, THREE.Texture>(), []);
  const barTexture = (c: string) => {
    if (!barTex.has(c)) barTex.set(c, stripeTexture('#ffffff', c, 12, true));
    return barTex.get(c)!;
  };
  const cps = level.checkpoints.slice(1, level.finish ? -1 : undefined);
  const moverMats = useMemo(() => level.movers.map((m) => { const mt = makeBlockMaterial(low); mt.color.set(m.color ?? '#ffc078'); return mt; }), [level, low]);
  useEffect(() => () => { blockMat.dispose(); moverMats.forEach((m) => m.dispose()); }, [blockMat, moverMats]);

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

  useFrame((state) => {
    const t = net.levelTime();
    level.movers.forEach((m, i) => {
      const o = moverOffset(m, t);
      movers.current.children[i]?.position.set(m.p[0] + o[0], m.p[1] + o[1], m.p[2] + o[2]);
    });
    level.sweepers.forEach((s, i) => {
      const g = sweepers.current.children[i];
      if (!g) return;
      g.rotation.y = -sweeperAngle(s, t);
      // 나중에 등장하는 봉은 2.5초 전부터 깜빡이며 예고한다
      const wait = (s.startAt ?? 0) - t;
      g.visible = wait <= 0 || (wait < 2.5 && (t * 5) % 1 < 0.6);
    });
    const beat = state.clock.elapsedTime * 3;
    for (const p of pads.current.children) {
      const ring = p.children[1];
      const k = (beat % 1);
      ring.scale.setScalar(0.5 + k * 0.6);
      ring.position.y = 0.12 + k * 0.9;
      ((ring as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - k;
    }
  });

  return (
    <group>
      <instancedMesh ref={statics} args={[box, blockMat, Math.max(1, level.statics.length)]} count={level.statics.length} receiveShadow={shadow} />
      <Tiles level={level} low={low} />
      <Bombs level={level} />
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
      <group ref={movers}>
        {level.movers.map((m, i) => (
          <group key={i} position={m.p}>
            <mesh geometry={box} material={moverMats[i]} scale={m.h} castShadow={shadow} receiveShadow={shadow} />
            {m.kind === 'wall' && [-1, 1].map((face) => (
              // 미는 벽에는 심술궂은 눈을 달아 "피해야 하는 것"임을 한눈에 알게 한다
              <group key={face} position={[0, m.h[1] * 0.25, face * (m.h[2] + 0.02)]} rotation={[0, face > 0 ? 0 : Math.PI, 0]}>
                {[-1, 1].map((ex) => (
                  <group key={ex} position={[ex * 0.75, 0, 0]}>
                    <mesh scale={[0.5, 0.56, 0.16]}><sphereGeometry args={[1, 14, 10]} /><meshBasicMaterial color="#ffffff" /></mesh>
                    <mesh position={[-ex * 0.12, -0.08, 0.13]} scale={[0.22, 0.26, 0.08]}><sphereGeometry args={[1, 10, 8]} /><meshBasicMaterial color="#2b2145" /></mesh>
                    <mesh position={[0, 0.5, 0.1]} rotation={[0, 0, ex * 0.35]} scale={[0.6, 0.13, 0.1]} geometry={box}><meshBasicMaterial color="#2b2145" /></mesh>
                  </group>
                ))}
              </group>
            ))}
          </group>
        ))}
      </group>
      <group ref={sweepers}>
        {level.sweepers.map((s, i) => (
          <group key={i} position={s.c}>
            <mesh rotation={[0, 0, Math.PI / 2]} castShadow={shadow}>
              <capsuleGeometry args={[s.r, s.len * 2 - s.r * 2, 6, 14]} />
              <meshLambertMaterial map={barTexture(s.color ?? '#ff4f8b')} />
            </mesh>
            {[-1, 1].map((e) => (
              <mesh key={e} position={[e * (s.len - 0.1), 0, 0]}>
                <sphereGeometry args={[s.r * 1.55, 12, 10]} />
                <meshLambertMaterial color="#ffd43b" />
              </mesh>
            ))}
            <mesh>
              <sphereGeometry args={[0.62, 16, 12]} />
              <meshLambertMaterial color="#ffffff" />
            </mesh>
            <mesh position={[0, -0.25 - s.r, 0]}>
              <cylinderGeometry args={[0.42, 0.7, 0.5 + s.r, 16]} />
              <meshLambertMaterial color="#7048e8" />
            </mesh>
            {s.c[1] > s.r + 1 && (
              <mesh position={[0, -1, 0]}>
                <cylinderGeometry args={[0.2, 0.2, 2, 10]} />
                <meshLambertMaterial color="#ffffff" />
              </mesh>
            )}
          </group>
        ))}
      </group>
      <group ref={pads}>
        {level.pads.map((p, i) => (
          <group key={i} position={[p.p[0], p.p[1], p.p[2]]}>
            <mesh scale={[p.h[0], 0.14, p.h[2]]}>
              <cylinderGeometry args={[1, 1.08, 1, 24]} />
              <meshLambertMaterial color="#ffd43b" emissive="#ff8a00" emissiveIntensity={0.5} />
            </mesh>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[Math.min(p.h[0], p.h[2]), 0.09, 6, 24]} />
              <meshBasicMaterial color="#ffffff" transparent />
            </mesh>
            <mesh position={[0, 0.09, 0]} scale={[p.h[0] * 0.55, 0.05, p.h[2] * 0.55]}>
              <cylinderGeometry args={[1, 1, 1, 20]} />
              <meshBasicMaterial color="#ff4f8b" />
            </mesh>
          </group>
        ))}
      </group>
      {level.finish && banner && (
        <mesh position={[0, level.checkpoints[level.checkpoints.length - 1].spawn[1] + 4.7, level.finish.p[2] - level.finish.h[2]]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[level.finish.h[0] * 2, 1.9]} />
          <meshBasicMaterial map={banner} side={THREE.DoubleSide} />
        </mesh>
      )}
      <Decor level={level} low={low} />
    </group>
  );
}
