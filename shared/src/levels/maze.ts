import type { Box, LevelDef, Mover } from '../level';
import { rng } from './race';

const W = 11; // 미로 절반 폭
const WALL_H = 1.25; // 벽 절반 높이(2.5m: 뛰어넘을 수 없다)

/**
 * 움직이는 미로 "열렸다 닫혔다 미로"
 * 가로벽 6줄을 차례로 통과한다. 줄마다 틈이 셋인데 하나는 늘 열려 있고(대신 멀리 돌아가야 한다),
 * 둘은 문이 열렸다 닫힌다(양옆은 옆으로 미끄러지고 가운데는 위아래로 오르내린다). 줄 사이에는 막다른 칸막이가 있다.
 */
export function buildMaze(seed: number): LevelDef {
  const r = rng(seed);
  const statics: Box[] = [];
  const movers: Mover[] = [];
  const rows = 6, gap = 6, z0 = 8, zEnd = z0 + rows * gap + 2;
  statics.push({ p: [0, -0.5, (zEnd + 4 - 8) / 2], h: [W, 0.5, (zEnd + 4 + 8) / 2], color: '#5cc8ff' });
  // 바깥 담(미로 구간만): 옆으로 떨어지지 않게
  statics.push({ p: [-W + 0.3, WALL_H, (z0 + zEnd) / 2 - 2], h: [0.3, WALL_H, (zEnd - z0) / 2 + 1], color: '#7048e8' });
  statics.push({ p: [W - 0.3, WALL_H, (z0 + zEnd) / 2 - 2], h: [0.3, WALL_H, (zEnd - z0) / 2 + 1], color: '#7048e8' });
  const colors = ['#ff8fc7', '#ffd04d', '#5fe0a8', '#b693ff'];
  const G = 1.5; // 틈 절반 폭
  for (let i = 0; i < rows; i++) {
    const z = z0 + i * gap;
    // 틈 세 개의 위치: 왼쪽·가운데·오른쪽 구역에서 하나씩
    const xs = [-6.2 + r() * 1.6, -1 + r() * 2, 4.6 + r() * 1.6];
    const open = Math.floor(r() * 3); // 늘 열려 있는 틈
    let x = -W + 0.6;
    for (const gx of [...xs, Infinity]) {
      const x1 = Math.min(W - 0.6, gx - G);
      if (x1 - x > 0.2) statics.push({ p: [(x + x1) / 2, WALL_H, z], h: [(x1 - x) / 2, WALL_H, 0.3], color: colors[i % 4] });
      x = gx + G;
    }
    xs.forEach((gx, k) => {
      if (k === open) return;
      // 문: 양옆 틈의 문은 바깥쪽 벽 앞으로 미끄러지고, 가운데 문은 위아래로 오르내린다.
      // (옆으로 여는 문이 이웃 틈을 가리지 않게 하기 위해서다)
      const travel: [number, number, number] = k === 1 ? [0, 2.7, 0] : [(G * 2 + 0.2) * (k === 0 ? -1 : 1), 0, 0];
      movers.push({
        kind: 'wall', p: [gx, WALL_H - 0.1, z - 0.45], h: [G + 0.05, WALL_H - 0.1, 0.16],
        travel, period: 4.2 + r() * 2.4, phase: r(), color: k === 1 ? '#ffa94d' : '#ff4f8b',
      });
    });
    // 막다른 칸막이: 다음 줄로 가는 길을 살짝 꼬아 놓는다
    if (i < rows - 1) {
      for (let k = 0; k < 2; k++) {
        const sx = (k === 0 ? -1 : 1) * (2.6 + r() * 5);
        statics.push({ p: [sx, WALL_H, z + 2.1 + r() * 1.4], h: [0.3, WALL_H, 1.5], color: colors[(i + 1) % 4] });
      }
    }
  }
  const fz = zEnd;
  const finish: Box = { p: [0, 3, fz + 3], h: [W, 6, 3] };
  statics.push({ p: [-W + 0.4, 2, fz], h: [0.4, 2, 0.4], color: '#ffffff' });
  statics.push({ p: [W - 0.4, 2, fz], h: [0.4, 2, 0.4], color: '#ffffff' });
  const mid = z0 + 3 * gap - 3;
  return {
    id: 'maze', name: '열렸다 닫혔다 미로',
    statics, movers, sweepers: [], pads: [],
    checkpoints: [
      { zone: { p: [0, 0, 0], h: [0, 0, 0] }, spawn: [0, 0, 3] },
      { zone: { p: [0, 3, mid + 1], h: [W + 4, 6, 1.5] }, spawn: [0, 0, mid + 1] },
      { zone: finish, spawn: [0, 0, fz + 4] },
    ],
    spawnCols: 10, spawnSpacing: 1.5, killY: -9,
    finish, track: { z0: 3, z1: fz },
    sky: ['#3fb0ff', '#ffe3f4'],
  };
}
