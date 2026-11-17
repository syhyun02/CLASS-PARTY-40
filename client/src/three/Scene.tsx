import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { PODIUM_Z, buildLevel } from '@shared';
import { input } from '../game/input';
import { net } from '../game/net';
import { setQuality, useStore } from '../game/store';
import { Characters } from './Characters';
import { Confetti, LevelView } from './LevelView';

const target = new THREE.Vector3();
const want = new THREE.Vector3();

/** 화질 단계별 최대 해상도 배율. 실제 배율은 프레임 시간에 따라 이 값 아래에서 자동으로 오르내린다. */
const maxDpr = (q: string) => (q === 'low' ? 1 : q === 'medium' ? Math.min(1.5, window.devicePixelRatio) : Math.min(2, window.devicePixelRatio));

/** 네트워크·예측 갱신, 카메라, 자동 화질 조절을 한 프레임에 처리한다. */
function Driver({ spectator }: { spectator: boolean }) {
  const camera = useThree((s) => s.camera);
  const fps = useRef({ frames: 0, t: 0, low: 0, slow: 0, good: 0, ceil: 9, raised: false });
  const first = useRef(true);
  const levelKey = useStore((s) => s.room?.levelKey);
  useEffect(() => { first.current = true; }, [levelKey]);

  useFrame((state, dt) => {
    net.update(performance.now());
    const list = net.renderPlayers();
    const me = list.find((p) => p.isMe);
    const snap = first.current;

    if (me && !spectator) {
      // 3인칭: 캐릭터 뒤 위쪽에서 따라간다
      const dist = 7.2, cy = input.camYaw, cp = input.camPitch;
      target.set(me.x, me.y + 1.3, me.z);
      want.set(me.x - Math.sin(cy) * Math.cos(cp) * dist, me.y + 1.3 + Math.sin(cp) * dist, me.z - Math.cos(cy) * Math.cos(cp) * dist);
      camera.position.lerp(want, snap ? 1 : Math.min(1, dt * 10));
      camera.lookAt(target);
      first.current = false;
    } else if (list.length > 0) {
      // 관전(교사 화면, 늦게 들어온 학생): 선두 무리를 위에서 비춘다
      const lobby = net.level?.id === 'lobby';
      if (net.level?.track) {
        // 레이스: 선두 무리를 뒤에서 따라간다
        let sx = 0, sz = 0, sy = 0, n = 0;
        const sorted = [...list].sort((a, b) => b.z - a.z).slice(0, Math.max(3, Math.ceil(list.length / 3)));
        for (const p of sorted) { sx += p.x; sy += p.y; sz += p.z; n++; }
        target.set((sx / n) * 0.4, sy / n, sz / n);
        want.set(target.x, target.y + 14, target.z - 17);
      } else {
        if (useStore.getState().room?.phase === 'final') {
          // 시상식: 시상대를 정면에서 비춘다
          target.set(0, 1.4, PODIUM_Z);
          want.set(Math.sin(state.clock.elapsedTime * 0.3) * 2.5, 4.2, PODIUM_Z - 10.5);
          camera.position.lerp(want, snap ? 1 : Math.min(1, dt * 2.5));
          camera.lookAt(target);
          first.current = false;
          return;
        }
        // 대기실·생존 게임: 경기장 전체를 천천히 돌며 내려다본다
        const a = state.clock.elapsedTime * (lobby ? 0.08 : 0.05);
        target.set(0, 0, 0);
        want.set(Math.sin(a) * 23, lobby ? 17 : 19, -Math.cos(a) * 23);
      }
      camera.position.lerp(want, snap ? 1 : Math.min(1, dt * 2.5));
      camera.lookAt(target);
      first.current = false;
    }

    // ---- 60fps 유지: 프레임 시간을 재서 해상도를 조금씩 조절한다 ----
    // 해상도(dpr)는 캔버스를 다시 만들지 않고 바꿀 수 있어 끊김이 없다. 그래도 느리면 화질 단계를 내린다.
    const f = fps.current;
    f.frames++; f.t += dt;
    if (dt > 0.021) f.slow++; // 60fps 기준 한 프레임(16.7ms)을 넘긴 횟수
    if (f.t >= 1) {
      const v = f.frames / f.t, slowRatio = f.slow / f.frames;
      (window as any).__cp40fps = v;
      (window as any).__cp40perf = { fps: v, dpr: state.viewport.dpr, calls: state.gl.info.render.calls, tris: state.gl.info.render.triangles };
      f.frames = 0; f.t = 0; f.slow = 0;
      const st = useStore.getState();
      if (document.visibilityState === 'visible') {
        const dpr = state.viewport.dpr, max = maxDpr(st.quality), min = Math.min(max, 0.75);
        if (v < 54 || slowRatio > 0.3) {
          f.good = 0;
          if (dpr > min + 0.01) {
            // 방금 올렸다가 다시 내려야 한다면 그 높이는 이 기기에 무리다 → 다시는 그만큼 올리지 않는다
            if (f.raised) { f.ceil = Math.min(f.ceil, dpr * 0.93); f.raised = false; }
            state.setDpr(Math.max(min, dpr * (v < 40 ? 0.8 : 0.9)));
          } else if (st.autoQuality && st.quality !== 'low' && ++f.low >= 3) { setQuality(st.quality === 'high' ? 'medium' : 'low', false); f.low = 0; }
        } else {
          f.low = 0; f.raised = false;
          // 해상도를 바꾸면 그 순간 한 번 끊기므로 올리는 일은 드물게 한다: 10초 동안 안정적일 때만, 확인된 한도 안에서
          const top = Math.min(max, f.ceil);
          if (++f.good >= 10 && dpr < top - 0.04) { state.setDpr(Math.min(top, dpr * 1.1)); f.good = 0; f.raised = true; }
        }
      }
    }
  });
  return null;
}

/** 햇빛. 그림자 범위가 좁아도 되도록 카메라가 보는 곳을 따라다닌다. */
function Sun({ shadows }: { shadows: boolean }) {
  const ref = useRef<THREE.DirectionalLight>(null!);
  const camera = useThree((s) => s.camera);
  const fwd = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    camera.getWorldDirection(fwd);
    const l = ref.current;
    l.target.position.set(camera.position.x + fwd.x * 10, camera.position.y - 5, camera.position.z + fwd.z * 10);
    l.position.set(l.target.position.x + 12, l.target.position.y + 26, l.target.position.z - 9);
    l.target.updateMatrixWorld();
  });
  return (
    <directionalLight
      ref={ref} intensity={shadows ? 2.3 : 2.0} color="#fff4e0" castShadow={shadows}
      shadow-mapSize={[1024, 1024]} shadow-camera-left={-22} shadow-camera-right={22}
      shadow-camera-top={22} shadow-camera-bottom={-22} shadow-camera-far={70} shadow-bias={-0.0015}
    />
  );
}

function ContextWatch() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const el = gl.domElement;
    const lost = (e: Event) => { e.preventDefault(); useStore.setState({ contextLost: true }); };
    const back = () => useStore.setState({ contextLost: false });
    el.addEventListener('webglcontextlost', lost);
    el.addEventListener('webglcontextrestored', back);
    return () => { el.removeEventListener('webglcontextlost', lost); el.removeEventListener('webglcontextrestored', back); };
  }, [gl]);
  return null;
}

export function Scene({ spectator = false }: { spectator?: boolean }) {
  const quality = useStore((s) => s.quality);
  const final = useStore((s) => s.room?.phase === 'final');
  const levelKey = useStore((s) => s.room?.levelKey);
  const levelId = useStore((s) => s.room?.levelId);
  const levelSeed = useStore((s) => s.room?.levelSeed);
  // 네트워크 쪽과 같은 맵 객체를 쓴다(화학 모드에서 정답이 밝혀지면 그 객체가 바뀐다)
  const level = useMemo(() => (levelId && net.level?.id === levelId ? net.level : levelId ? buildLevel(levelId, levelSeed ?? 0) : null), [levelKey]);
  const dpr = maxDpr(quality);
  const sky = level?.sky ?? ['#aee6ff', '#ffe6f5'];

  return (
    <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse 70% 45% at 50% 68%, #ffffffcc 0%, transparent 70%), linear-gradient(180deg, ${sky[0]} 0%, #8fd3ff 38%, ${sky[1]} 74%)` }}>
      <Canvas
        key={quality}
        dpr={dpr}
        flat
        shadows={quality === 'high'}
        gl={{ antialias: quality === 'high', alpha: true, powerPreference: 'high-performance', stencil: false }}
        camera={{ fov: 62, near: 0.3, far: 220, position: [0, 8, -12] }}
      >
        <fog attach="fog" args={[sky[1], 70, 210]} />
        <hemisphereLight args={['#ffffff', '#ffb3de', quality === 'high' ? 1.55 : 1.4]} />
        {/* 뒤에서 비추는 푸른 보조광: 캐릭터와 발판 가장자리가 또렷해진다 */}
        <directionalLight position={[-8, 6, 14]} intensity={quality === 'high' ? 1.1 : 0.5} color="#9fd0ff" />
        <Sun shadows={quality === 'high'} />
        <ContextWatch />
        <Driver spectator={spectator} />
        {level && <LevelView key={levelKey} level={level} />}
        <Characters nameRange={spectator ? 60 : 22} />
        {final && <Confetti z={PODIUM_Z} />}
      </Canvas>
    </div>
  );
}
