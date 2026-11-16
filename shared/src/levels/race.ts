import type { Box, Checkpoint, LevelDef, Mover, Pad, Sweeper } from '../level';

/** 시드 고정 난수(mulberry32). 서버와 클라이언트가 같은 맵을 만들기 위해 쓴다. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 8; // 트랙 절반 폭(16m): 40명이 한 줄에 8명씩 선다

/**
 * 장애물 레이스 "교실 탈출 달리기"
 * 출발 → 회전 빗자루 → 움직이는 벽 → 점프 발판 → 흔들다리 → 징검다리(낙하 구간) → 결승
 */
export function buildRace(seed: number): LevelDef {
  const r = rng(seed);
  const flip = () => (r() < 0.5 ? 1 : -1);
  const statics: Box[] = [];
  const movers: Mover[] = [];
  const sweepers: Sweeper[] = [];
  const pads: Pad[] = [];
  const checkpoints: Checkpoint[] = [];
  const floor = (z0: number, z1: number, top: number, color: string, hw = W, x = 0) =>
    statics.push({ p: [x, top - 0.5, (z0 + z1) / 2], h: [hw, 0.5, (z1 - z0) / 2], color });
  const cp = (z: number, top: number) =>
    checkpoints.push({ zone: { p: [0, top + 3, z + 1], h: [W + 4, 6, 1.5] }, spawn: [0, top, z + 1] });

  // 1) 출발대
  floor(-8, 10, 0, '#ffe3f1');
  checkpoints.push({ zone: { p: [0, 0, 0], h: [0, 0, 0] }, spawn: [0, 0, 6] });

  // 2) 회전 빗자루: 낮은 봉은 점프로 넘는다
  floor(10, 40, 0, '#cdeeff');
  for (let i = 0; i < 3; i++) {
    sweepers.push({
      c: [(i - 1) * 3.2 * flip(), 0.45, 15.5 + i * 9.5],
      len: 6.4, r: 0.3, speed: (1.5 + i * 0.3) * flip(), phase: r() * 6.28, color: '#ff8fab',
    });
  }
  cp(40, 0);

  // 3) 움직이는 벽: 좌우로 미는 벽 사이 틈으로 빠져나간다
  floor(40, 66, 0, '#e4dcff');
  for (let i = 0; i < 3; i++) {
    const dir = flip();
    movers.push({
      kind: 'wall', p: [0, 1.1, 46.5 + i * 7], h: [4.6, 1.1, 0.6],
      travel: [3.4 * dir, 0, 0], period: 4.2 - i * 0.5, phase: r(), color: '#b197fc',
    });
  }
  cp(66, 0);

  // 4) 점프 발판: 밟으면 높이 튀어 올라 윗단으로 넘어간다
  floor(66, 73, 0, '#fff3bf');
  for (let i = 0; i < 4; i++) pads.push({ p: [-6 + i * 4, 0.08, 71.2], h: [1.5, 0.08, 1.3], vy: 15.5 });
  const T = 1.5; // 윗단 높이
  floor(75, 84, T, '#d3f9d8');
  statics.push({ p: [0, 0, 75.25], h: [W, 0.5, 0.25], color: '#b2f2bb' }); // 윗단 앞면(밑으로 못 지나가게)
  cp(78, T);

  // 5) 흔들다리: 좌우로 움직이는 좁은 다리 두 개
  for (let i = 0; i < 2; i++) {
    movers.push({
      kind: 'platform', p: [i === 0 ? -3.6 : 3.6, T - 0.25, 91.5], h: [2.1, 0.25, 7.5],
      travel: [1.6 * (i === 0 ? 1 : -1), 0, 0], period: 3.6 + i * 0.6, phase: r(), color: '#ffc078',
    });
  }
  floor(99, 105, T, '#d3f9d8');
  cp(100, T);

  // 6) 징검다리: 떨어지면 체크포인트로 돌아간다
  let z = 108.25; // 발판 사이 간격 2m: 걸어서는 못 건너고 점프(약 4m)로는 여유 있게 건넌다
  for (let row = 0; row < 5; row++) {
    const shift = row % 2 === 0 ? 0 : 2.2;
    for (let col = -1; col <= 1; col++) {
      if (row % 2 === 1 && col === 1) continue;
      statics.push({
        p: [col * 4.4 + shift, T - 0.3, z], h: [1.45, 0.3, 1.25],
        color: ['#ffa8a8', '#ffd43b', '#74c0fc'][(row + col + 3) % 3],
      });
    }
    z += 4.5;
  }
  // 가운데를 왕복하는 발판 하나(지름길이지만 타이밍이 필요)
  movers.push({
    kind: 'platform', p: [-7.1, T - 0.3, 117], h: [1.2, 0.3, 1.2],
    travel: [0, 0, 8], period: 5, phase: r(), color: '#63e6be',
  });
  floor(z - 1.25, z + 20, T, '#cdeeff');
  cp(z - 0.5, T);

  // 7) 결승 직전: 높낮이가 다른 봉 두 개
  sweepers.push({ c: [0, T + 0.45, z + 6], len: 7.2, r: 0.3, speed: 2.3 * flip(), phase: r() * 6.28, color: '#ff8fab' });
  sweepers.push({ c: [0, T + 1.8, z + 6], len: 7.2, r: 0.3, speed: -1.3 * flip(), phase: r() * 6.28, color: '#ffa94d' });
  const fz = z + 14;
  const finish: Box = { p: [0, T + 3, fz + 3], h: [W, 6, 3] };
  // 결승 아치 기둥
  statics.push({ p: [-W + 0.4, T + 2, fz], h: [0.4, 2, 0.4], color: '#ffffff' });
  statics.push({ p: [W - 0.4, T + 2, fz], h: [0.4, 2, 0.4], color: '#ffffff' });
  checkpoints.push({ zone: finish, spawn: [0, T, fz + 4] });

  return {
    id: 'race', name: '교실 탈출 달리기',
    statics, movers, sweepers, pads, checkpoints,
    spawnCols: 8, spawnSpacing: 1.5, killY: -9,
    finish, track: { z0: 6, z1: fz },
    sky: ['#9fd8ff', '#fff0c9'],
  };
}
