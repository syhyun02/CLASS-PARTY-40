import type { PublicQ } from '../chem/bank';
import { NEVER, type Box, type LevelDef, type Mover, type QuizQ, type QuizSign } from '../level';
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

export const CHEM_DOOR_X = [6.4, 0, -6.4]; // 화면 왼쪽 → 오른쪽 순서(카메라가 +z를 볼 때 +x가 왼쪽)
export const CHEM_DOOR_HALF = 1.6;
const DOOR_COLORS = ['#ff6b6b', '#ffd43b', '#4dabf7'];
/** 화학 미로에서 i번째 문제의 벽이 있는 z */
export const chemRowZ = (i: number) => 14 + i * 10;

/**
 * 학생마다 문 세 개에 보기가 다른 순서로 걸린다(남이 지나간 문을 따라가도 소용없게).
 * 돌려주는 배열의 d번째 값이 d번 문에 걸린 보기 번호다. 서버와 클라이언트가 같은 계산을 한다.
 */
export function chemDoorOrder(seed: number, playerId: number, row: number): number[] {
  const r = rng((seed ^ (playerId * 7919) ^ (row * 104729)) >>> 0);
  const o = [0, 1, 2];
  for (let i = 2; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [o[i], o[k]] = [o[k], o[i]]; }
  return o;
}

/**
 * 화학 미로 "정답의 문"
 * 가로벽마다 문제가 하나씩 걸려 있고 빛의 문이 셋 있다. 정답 보기가 걸린 문은 그대로 통과하고,
 * 오답 문은 튕겨 내며 잠깐 넘어진다. 문은 눈에만 보이는 막이고 통과 여부는 서버가 학생별로 판정한다.
 */
export function buildChemMaze(_seed: number, ext?: (PublicQ & { answer?: number; explain?: string })[]): LevelDef {
  const qs = ext?.length ? ext : [];
  const rows = Math.max(1, qs.length), z0 = chemRowZ(0), zEnd = chemRowZ(rows - 1) + 8;
  const statics: Box[] = [];
  const curtains: Box[] = [];
  const quiz: QuizQ[] = [];
  const signs: QuizSign[] = [];
  statics.push({ p: [0, -0.5, (zEnd + 4 - 8) / 2], h: [W, 0.5, (zEnd + 4 + 8) / 2], color: '#5fe0a8' });
  statics.push({ p: [-W + 0.3, WALL_H, (z0 + zEnd) / 2 - 3], h: [0.3, WALL_H, (zEnd - z0) / 2 + 3], color: '#7048e8' });
  statics.push({ p: [W - 0.3, WALL_H, (z0 + zEnd) / 2 - 3], h: [0.3, WALL_H, (zEnd - z0) / 2 + 3], color: '#7048e8' });
  for (let i = 0; i < rows; i++) {
    const z = chemRowZ(i);
    // 문 셋 사이와 양 끝을 막는 벽
    const edges = [W - 0.6, ...CHEM_DOOR_X.flatMap((x) => [x + CHEM_DOOR_HALF, x - CHEM_DOOR_HALF]), -W + 0.6];
    for (let k = 0; k < edges.length; k += 2) {
      const a = edges[k], b = edges[k + 1];
      if (a - b > 0.2) statics.push({ p: [(a + b) / 2, WALL_H, z], h: [(a - b) / 2, WALL_H, 0.3], color: '#b693ff' });
    }
    CHEM_DOOR_X.forEach((x, d) => {
      curtains.push({ p: [x, WALL_H, z], h: [CHEM_DOOR_HALF, WALL_H, 0.05], color: DOOR_COLORS[d] });
      signs.push({ p: [x, WALL_H * 2 + 1.3, z], q: i, o: d, color: DOOR_COLORS[d] });
    });
    const e = qs[i];
    quiz.push({ at: 0, revealAt: NEVER, endAt: NEVER, text: e?.text ?? '', options: e?.options ?? ['', '', ''], answer: e?.answer ?? -1, explain: e?.explain });
  }
  const fz = zEnd;
  const finish: Box = { p: [0, 3, fz + 3], h: [W, 6, 3] };
  statics.push({ p: [-W + 0.4, 2, fz], h: [0.4, 2, 0.4], color: '#ffffff' });
  statics.push({ p: [W - 0.4, 2, fz], h: [0.4, 2, 0.4], color: '#ffffff' });
  return {
    id: 'chemmaze', name: '정답의 문',
    statics, movers: [], sweepers: [], pads: [], curtains, quiz, signs,
    checkpoints: [
      { zone: { p: [0, 0, 0], h: [0, 0, 0] }, spawn: [0, 0, 5] },
      { zone: finish, spawn: [0, 0, fz + 4] },
    ],
    spawnCols: 10, spawnSpacing: 1.5, killY: -9,
    finish, track: { z0: 5, z1: fz },
    sky: ['#3fb0ff', '#ffe3f4'],
  };
}
