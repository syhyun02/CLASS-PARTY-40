import { COUNTDOWN_SEC } from '../constants';
import type { Ball, Box, LevelDef, Sweeper } from '../level';
import { rng } from './race';

const T0 = COUNTDOWN_SEC;
export const HOVER = { halfW: 6, halfL: 7, speed: 3.2, start: T0 + 1.5, length: 208 };

/**
 * 둥둥 호버보드(생존)
 * 40명이 큰 호버보드에 타고, 보드가 결승선까지 저절로 날아간다. 보드는 장애물 사이를 지나가는데
 * 장애물은 제자리에 있으므로 걸리면 보드 뒤쪽으로 밀려나다가 떨어진다. 결승선까지 버티면 모두 1위.
 * - 낮은 봉: 점프로 넘는다
 * - 구멍 벽: 구멍 자리로 비켜 선다(점프로는 못 넘는 높이)
 * - 회전봉: 낮으면 점프, 높으면 점프 금지
 * - 굴러오는 공: 옆에서 보드를 가로질러 굴러온다(점프로 넘는다)
 * 뒤로 갈수록 장애물이 촘촘해지고, 구멍이 좁아지고, 두 가지가 겹쳐 나온다.
 */
export function buildHover(seed: number): LevelDef {
  const r = rng(seed);
  const { halfW: W, halfL, speed, start, length } = HOVER;
  const statics: Box[] = [];
  const sweepers: Sweeper[] = [];
  const balls: Ball[] = [];
  const obstacles: NonNullable<LevelDef['obstacles']> = [];
  const passAt = (z: number) => start + z / speed; // 보드 가운데가 z를 지나는 시각

  const bar = (z: number) => {
    statics.push({ p: [0, 0.55, z], h: [W + 1.5, 0.2, 0.22], color: '#ffd43b' });
    obstacles.push({ kind: 'bar', z });
  };
  const holes = (z: number, n: number, gw: number) => {
    // 구멍 가운데 x를 겹치지 않게 고른다
    const gaps: number[] = [];
    for (let tries = 0; gaps.length < n && tries < 50; tries++) {
      const x = (r() * 2 - 1) * (W - gw / 2 - 0.3);
      if (gaps.every((g) => Math.abs(g - x) > gw + 1)) gaps.push(x);
    }
    gaps.sort((a, b) => a - b);
    let x0 = -W - 1.5;
    for (const g of [...gaps, Infinity]) {
      const x1 = Math.min(W + 1.5, g - gw / 2);
      if (x1 - x0 > 0.05) statics.push({ p: [(x0 + x1) / 2, 1.7, z], h: [(x1 - x0) / 2, 1.7, 0.3], color: '#ff6b6b' });
      x0 = g + gw / 2;
    }
    // 구멍 위를 막는 띠(점프로 구멍 위를 넘어가지 못하게, 하지만 서서 지나갈 수는 있게)
    for (const g of gaps) statics.push({ p: [g, 2.9, z], h: [gw / 2, 0.5, 0.3], color: '#ff8787' });
    obstacles.push({ kind: 'holes', z, gaps });
  };
  const spin = (z: number, low: boolean, sp: number) => {
    sweepers.push({ c: [0, low ? 0.45 : 1.8, z], len: W + 0.6, r: 0.3, speed: sp * (r() < 0.5 ? 1 : -1), phase: r() * 6.28, color: low ? '#ff4f8b' : '#ffa94d', float: true });
    obstacles.push({ kind: 'sweeper', z, low });
  };
  const rollers = (z: number, n: number) => {
    // 보드 가운데가 z 근처를 지날 때 옆에서 공이 차례로 가로질러 굴러온다
    const side = r() < 0.5 ? 1 : -1, bs = 7 + r() * 2, X = W + 8;
    for (let k = 0; k < n; k++) {
      const zb = z + (k - (n - 1) / 2) * 2.4, from = (k % 2 ? -side : side);
      const at = passAt(zb) - X / bs; // 보드 가운데 줄을 지날 때 보드도 그 자리에 오게
      balls.push({
        x: from * X, z: zb, dx: -from, dz: 0, speed: bs, r: 0.55, at,
        enter: at + (X - W) / bs, end: at + (X + W + 3) / bs, color: ['#ff6b6b', '#4dabf7', '#9775fa', '#51cf66'][k % 4],
      });
    }
    obstacles.push({ kind: 'balls', z });
  };

  let z = 26;
  while (z < length - 6) {
    const p = z / length; // 0 → 1: 갈수록 어려워진다
    const pick = r();
    if (p < 0.25) {
      if (pick < 0.4) bar(z); else if (pick < 0.75) holes(z, 3, 3.4); else spin(z, true, 1.2);
    } else if (p < 0.6) {
      if (pick < 0.25) bar(z);
      else if (pick < 0.5) holes(z, r() < 0.5 ? 3 : 2, 3.0);
      else if (pick < 0.75) spin(z, r() < 0.6, 1.4 + p);
      else rollers(z, 3);
    } else {
      // 후반: 두 가지가 겹쳐 나온다
      if (pick < 0.3) { holes(z, 2, 2.6); bar(z + 4.5); }
      else if (pick < 0.55) { spin(z, true, 2.0); spin(z + 0.01, false, 1.6); }
      else if (pick < 0.8) { rollers(z, 4); }
      else { bar(z); spin(z + 5, false, 1.8); }
    }
    z += 14 - p * 5;
  }

  // 코스 옆 기둥(지나가는 속도가 느껴지게)과 결승 아치. 모두 보드 밖이라 부딪히지 않는다.
  const posts = ['#ff8fc7', '#5cc8ff', '#ffd04d', '#5fe0a8'];
  for (let k = 0, zz = -6; zz < length + 18; zz += 12, k++) {
    for (const sx of [-1, 1]) statics.push({ p: [sx * (W + 3.5), -2.5, zz], h: [0.45, 4, 0.45], color: posts[k % 4] });
  }
  const fz = length + halfL - 4;
  statics.push({ p: [-(W + 2.5), 2, fz], h: [0.5, 3, 0.5], color: '#ffffff' });
  statics.push({ p: [W + 2.5, 2, fz], h: [0.5, 3, 0.5], color: '#ffffff' });
  statics.push({ p: [0, 5.4, fz], h: [W + 3, 0.4, 0.5], color: '#ff4f8b' });

  return {
    id: 'hover', name: '둥둥 호버보드',
    statics, sweepers, pads: [], tiles: [], balls: balls.sort((a, b) => a.at - b.at), obstacles,
    movers: [{
      kind: 'platform', p: [0, -0.3, 0], h: [W, 0.3, halfL], color: '#7c5cff',
      travel: [0, 0, length], period: 1, phase: 0, ride: { start, duration: length / speed },
    }],
    checkpoints: [{ zone: { p: [0, 0, 0], h: [0, 0, 0] }, spawn: [0, 0, 3] }],
    spawnCols: 8, spawnSpacing: 1.4, killY: -8, noRespawn: true,
    track: { z0: 0, z1: length },
    // 경기 시간: 출발 대기 + 이동 시간 + 도착 뒤 2초
    duration: 1.5 + length / speed + 2,
    sky: ['#3fb0ff', '#ffe3f4'],
  };
}
