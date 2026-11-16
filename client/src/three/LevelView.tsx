import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { moverOffset, sweeperAngle, type LevelDef } from '@shared';
import { net } from '../game/net';
import { useStore } from '../game/store';

const dummy = new THREE.Object3D();
const col = new THREE.Color();
const CANDY = ['#ff4f8b', '#ffd43b', '#4dabf7', '#5fe0a8', '#b693ff', '#ff9f43'];

/**
 * 바닥·발판용 재질. 셰이더에서 무늬를 그려 텍스처 없이도 장난감 매트처럼 보이게 한다.
 * 윗면: 2m 체크무늬 + 흰 테두리 / 옆면: 진한 색 + 위쪽 흰 띠
 */
function makeBlockMaterial(low: boolean) {
  const m = low ? new THREE.MeshLambertMaterial() : new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0 });
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
          float e = min(vBScale.x - abs(m.x), vBScale.z - abs(m.z));
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
  for (const b of [...level.statics, ...level.movers]) {
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
    return Array.from({ length: nBalloon }, (_, i) => {
      const side = i % 2 ? 1 : -1;
      return {
        x: (side > 0 ? B.x1 : B.x0) + side * (5 + r() * 22), y: B.y1 + 1 + r() * 14,
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
      dummy.position.set(x, level.killY - (under ? 9 : 7) - r() * 6, z);
      const s = 3.5 + r() * 4.5;
      dummy.scale.set(s * 1.6, s * 0.6, s * 1.3);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      clouds.current.setMatrixAt(i, dummy.matrix);
    }
    clouds.current.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < nRing; i++) {
      const side = i % 2 ? 1 : -1;
      dummy.position.set((side > 0 ? B.x1 : B.x0) + side * (9 + r() * 16), B.y1 + 2 + r() * 10, B.z0 + r() * (B.z1 - B.z0 + 20));
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
        <meshLambertMaterial color="#f3f7ff" emissive="#b9c8ff" emissiveIntensity={0.28} />
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
      if (g) g.rotation.y = -sweeperAngle(s, t);
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
      <instancedMesh ref={statics} args={[box, blockMat, level.statics.length]} receiveShadow={shadow} />
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
