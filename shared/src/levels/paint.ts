import { COUNTDOWN_SEC } from '../constants';
import type { Box, Item, LevelDef, Sweeper } from '../level';
import { GOAL_DIRS } from './teamball';

const T0 = COUNTDOWN_SEC;

/**
 * 색깔 땅따먹기: 한 변 48m 정사각형(팀 공 넣기 경기장의 2.5배 넓이)을 2m 칸 24×24로 나눈다.
 * 칸을 밟으면 우리 팀 색이 되고, 끝났을 때 칠한 칸이 많은 팀이 이긴다.
 */
export const PAINT = { half: 24, cell: 2, n: 24, wallH: 2.4, bombR: 4.6, pickR: 1.4 };
/** 시간 안에 칠할 칸 상태 문자: '.' 빈 칸, '0'~'3' 팀, '#' 장애물 */
export const PAINT_EMPTY = '.';
export const PAINT_BLOCK = '#';

/** 좌표가 속한 칸 번호(경기장 밖이면 -1) */
export function paintCell(x: number, z: number): number {
  const { half: H, cell: C, n } = PAINT;
  const ix = Math.floor((x + H) / C), iz = Math.floor((z + H) / C);
  if (ix < 0 || iz < 0 || ix >= n || iz >= n) return -1;
  return iz * n + ix;
}
export const paintCellCenter = (i: number): [number, number] => {
  const { half: H, cell: C, n } = PAINT;
  return [-H + (i % n + 0.5) * C, -H + (Math.floor(i / n) + 0.5) * C];
};

/** 기둥 자리(4칸씩 차지, 칠할 수 없음) */
const PILLARS: [number, number][] = [[-12, -12], [12, -12], [-12, 12], [12, 12], [0, -16], [0, 16], [-16, 0], [16, 0]];

/** 빈 판 문자열(장애물 칸은 '#') */
export function paintBlank(): string {
  const { n } = PAINT;
  const a = new Array(n * n).fill(PAINT_EMPTY);
  for (const [px, pz] of PILLARS) {
    for (const dx of [-1, 1]) for (const dz of [-1, 1]) {
      const c = paintCell(px + dx * 0.5, pz + dz * 0.5);
      if (c >= 0) a[c] = PAINT_BLOCK;
    }
  }
  return a.join('');
}

/** 페인트 폭탄이 터질 때 칠해지는 칸들 */
export function paintSplash(x: number, z: number, r = PAINT.bombR): number[] {
  const out: number[] = [];
  const { n } = PAINT;
  for (let i = 0; i < n * n; i++) {
    const [cx, cz] = paintCellCenter(i);
    if ((cx - x) ** 2 + (cz - z) ** 2 <= r * r) out.push(i);
  }
  return out;
}

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export function buildPaint(seed: number): LevelDef {
  const { half: H, wallH } = PAINT;
  const r = seeded(seed * 7 + 3);
  const statics: Box[] = [];
  statics.push({ p: [0, -0.5, 0], h: [H, 0.5, H], color: '#f4f1ff' });
  // 둘레 담(점프로 못 넘는 높이)
  const W = '#b693ff';
  statics.push({ p: [0, wallH / 2, H + 0.5], h: [H + 1, wallH / 2, 0.5], color: W });
  statics.push({ p: [0, wallH / 2, -H - 0.5], h: [H + 1, wallH / 2, 0.5], color: W });
  statics.push({ p: [H + 0.5, wallH / 2, 0], h: [0.5, wallH / 2, H], color: W });
  statics.push({ p: [-H - 0.5, wallH / 2, 0], h: [0.5, wallH / 2, H], color: W });
  // 기둥: 경기장을 나누어 길목을 만든다
  const PC = ['#ff7eb6', '#7ec8ff', '#ffd36e', '#8ee6a6'];
  PILLARS.forEach(([x, z], i) => statics.push({ p: [x, 1.0, z], h: [1.9, 1.0, 1.9], color: PC[i % 4] }));

  // 한가운데 회전봉 두 개(낮은 봉은 점프로 넘는다). 시작하고 조금 뒤부터 돌고 점점 빨라진다.
  const sweepers: Sweeper[] = [
    { c: [0, 0.55, 0], len: 10, r: 0.32, speed: 0.75, phase: 0, color: '#ff4f8b', startAt: T0 + 6, accel: 0.006, maxSpeed: 1.25 },
    { c: [0, 0.55, 0], len: 10, r: 0.32, speed: 0.75, phase: Math.PI / 2, color: '#ff4f8b', startAt: T0 + 6, accel: 0.006, maxSpeed: 1.25 },
  ];
  statics.push({ p: [0, 0.6, 0], h: [0.7, 0.6, 0.7], color: '#ffffff' });

  // 페인트 폭탄: 8초부터 5초마다 두 개씩, 기둥과 가운데를 피해서 떨어진다
  const items: Item[] = [];
  const blank = paintBlank();
  for (let t = T0 + 8; t < T0 + 86; t += 5) {
    for (let k = 0; k < 2; k++) {
      let x = 0, z = 0;
      for (let tries = 0; tries < 30; tries++) {
        x = (r() * 2 - 1) * (H - 3); z = (r() * 2 - 1) * (H - 3);
        const c = paintCell(x, z);
        if (Math.hypot(x, z) > 3 && c >= 0 && blank[c] !== PAINT_BLOCK) break;
      }
      items.push({ p: [x, 0.9, z], at: t + k * 0.5, value: 2 });
    }
  }

  return {
    id: 'paint', name: '색깔 땅따먹기',
    statics, movers: [], sweepers, pads: [], tiles: [], items,
    checkpoints: [{ zone: { p: [0, 0, 0], h: [0, 0, 0] }, spawn: [0, 0, 0] }],
    spawnCols: 8, spawnSpacing: 1.5, spawnRing: 6, killY: -8,
    teamSpawns: GOAL_DIRS.map(([dx, dz]) => ({ x: dx * (H - 6), z: dz * (H - 6), yaw: Math.atan2(-dx, -dz) })),
    sky: ['#56c1ff', '#fff0d9'],
  };
}
