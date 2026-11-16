import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { moverOffset, sweeperAngle, type LevelDef } from '@shared';
import { net } from '../game/net';
import { useStore } from '../game/store';

const dummy = new THREE.Object3D();
const col = new THREE.Color();

function bannerTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d')!;
  for (let x = 0; x < 16; x++) for (let y = 0; y < 3; y++) {
    g.fillStyle = (x + y) % 2 ? '#3b2f63' : '#ffffff';
    g.fillRect(x * 32, y * 32, 32, 32);
  }
  g.fillStyle = '#ff7eb6'; g.fillRect(136, 14, 240, 68);
  g.fillStyle = '#fff'; g.font = '700 50px Jua, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('결승!', 256, 50);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 맵 정의(LevelDef)를 그대로 메시로 옮긴다. 고정 바닥은 InstancedMesh 하나로 그린다. */
export function LevelView({ level }: { level: LevelDef }) {
  const shadow = useStore((s) => s.quality === 'high');
  const statics = useRef<THREE.InstancedMesh>(null!);
  const strips = useRef<THREE.InstancedMesh>(null!);
  const movers = useRef<THREE.Group>(null!);
  const sweepers = useRef<THREE.Group>(null!);
  const pads = useRef<THREE.Group>(null!);
  const box = useMemo(() => new THREE.BoxGeometry(2, 2, 2), []);
  const banner = useMemo(() => (level.finish ? bannerTexture() : null), [level]);
  const cps = level.checkpoints.slice(1, level.finish ? -1 : undefined);

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
      dummy.scale.set(c.zone.h[0] - 4, 0.02, 0.35);
      dummy.updateMatrix();
      strips.current.setMatrixAt(i, dummy.matrix);
    });
    strips.current.instanceMatrix.needsUpdate = true;
  }, [level]);

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
    const pulse = 0.6 + Math.sin(state.clock.elapsedTime * 6) * 0.4;
    for (const p of pads.current.children) ((p as THREE.Mesh).material as THREE.MeshLambertMaterial).emissiveIntensity = pulse;
  });

  return (
    <group>
      <instancedMesh ref={statics} args={[box, undefined, level.statics.length]} receiveShadow={shadow}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={strips} args={[box, undefined, Math.max(1, cps.length)]} count={cps.length}>
        <meshBasicMaterial color="#ffffff" transparent opacity={0.7} />
      </instancedMesh>
      <group ref={movers}>
        {level.movers.map((m, i) => (
          <mesh key={i} geometry={box} scale={m.h} position={m.p} castShadow={shadow} receiveShadow={shadow}>
            <meshLambertMaterial color={m.color ?? '#ffc078'} />
          </mesh>
        ))}
      </group>
      <group ref={sweepers}>
        {level.sweepers.map((s, i) => (
          <group key={i} position={s.c}>
            <mesh rotation={[0, 0, Math.PI / 2]} castShadow={shadow}>
              <capsuleGeometry args={[s.r, s.len * 2 - s.r * 2, 4, 10]} />
              <meshLambertMaterial color={s.color ?? '#ff8fab'} />
            </mesh>
            <mesh position={[0, -s.c[1] / 2 + 0.2, 0]}>
              <cylinderGeometry args={[0.45, 0.6, Math.max(0.6, s.r * 2 + 0.6), 12]} />
              <meshLambertMaterial color="#ffffff" />
            </mesh>
          </group>
        ))}
      </group>
      <group ref={pads}>
        {level.pads.map((p, i) => (
          <mesh key={i} position={[p.p[0], p.p[1] + 0.02, p.p[2]]} scale={[p.h[0], p.h[1] + 0.02, p.h[2]]} geometry={box}>
            <meshLambertMaterial color="#ffd84d" emissive="#ff9f1a" />
          </mesh>
        ))}
      </group>
      {level.finish && banner && (
        <mesh position={[0, level.checkpoints[level.checkpoints.length - 1].spawn[1] + 4.6, level.finish.p[2] - level.finish.h[2]]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[level.finish.h[0] * 2, 1.6]} />
          <meshBasicMaterial map={banner} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}
