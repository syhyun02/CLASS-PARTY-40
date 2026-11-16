import { COUNTDOWN_SEC } from '../constants';
import { NEVER, type Bomb, type Item, type LevelDef, type Sweeper, type Tile } from '../level';
import { rng } from './race';

const T0 = COUNTDOWN_SEC; // 경기 시작 시각(맵 시간 기준)
const CANDY = ['#ff8fc7', '#5cc8ff', '#ffd04d', '#5fe0a8', '#b693ff', '#ff9f43'];
const base = (id: string, name: string): LevelDef => ({
  id, name, statics: [], movers: [], sweepers: [], pads: [], tiles: [],
  checkpoints: [{ zone: { p: [0, 0, 0], h: [0, 0, 0] }, spawn: [0, 0, 0] }],
  spawnCols: 8, spawnSpacing: 1.5, killY: -6, noRespawn: true,
  sky: ['#3fb0ff', '#ffe3f4'],
});
const disc = (r: number, top: number, color: string, offAt = NEVER): Tile =>
  ({ shape: 'disc', p: [0, top - 0.5, 0], h: [r, 0.5, r], color, warnAt: offAt - 3, offAt });
/** 가운데 기둥: 올라설 수 없게 높다 */
const pillar = (l: LevelDef) => l.statics.push({ p: [0, 2.4, 0], h: [0.7, 2.6, 0.7], color: '#ffffff' });

/**
 * 회전봉 서바이벌 "빙글빙글 원판"
 * 낮은 봉은 점프로, 높은 봉은 점프하지 않고 피한다. 봉은 점점 빨라지고 원판 바깥쪽이 두 번 떨어져 나간다.
 */
export function buildSpinner(seed: number): LevelDef {
  const r = rng(seed);
  const dir = r() < 0.5 ? 1 : -1;
  const l = base('spinner', '빙글빙글 원판');
  l.tiles = [
    disc(12.5, -0.08, '#5cc8ff', T0 + 28),
    disc(9.5, -0.04, '#ffd04d', T0 + 52),
    disc(6.5, 0, '#ff8fc7'),
  ];
  pillar(l);
  l.sweepers = [
    { c: [0, 0.45, 0], len: 12.4, r: 0.3, speed: 1.1 * dir, phase: r() * 6.28, color: '#ff4f8b', startAt: T0 + 1.5, accel: 0.045, maxSpeed: 3.8 },
    { c: [0, 1.85, 0], len: 12.4, r: 0.3, speed: -0.8 * dir, phase: r() * 6.28, color: '#ffa94d', startAt: T0 + 14, accel: 0.03, maxSpeed: 2.8 },
  ];
  l.spawnRing = 8;
  return l;
}

/**
 * 사라지는 발판 "와르르 타일"
 * 발판이 깜빡인 뒤 사라진다. 갈수록 더 많이, 더 빨리 사라지고 마지막에는 한 칸만 남는다.
 */
export function buildTiles(seed: number): LevelDef {
  const r = rng(seed);
  const l = base('tiles', '와르르 타일');
  const N = 8, pitch = 2.75, half = 1.3;
  const tiles: Tile[] = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    tiles.push({
      shape: 'box', p: [(i - (N - 1) / 2) * pitch, -0.4, (j - (N - 1) / 2) * pitch], h: [half, 0.4, half],
      color: CANDY[(i * 2 + j * 3) % CANDY.length], warnAt: NEVER, offAt: NEVER,
    });
  }
  // 무작위 순서로 섞은 뒤 물결처럼 한 번에 여러 칸씩 없앤다
  const order = tiles.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [order[i], order[k]] = [order[k], order[i]]; }
  const waves = [2, 2, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6]; // 합 60 → 4칸 남음
  let t = T0 + 4, n = 0;
  waves.forEach((k, w) => {
    for (let i = 0; i < k; i++) { const tile = tiles[order[n++]]; tile.warnAt = t; tile.offAt = t + 1.8; }
    t += Math.max(2.2, 3.8 - w * 0.12);
  });
  // 남은 4칸은 하나씩, 마지막 한 칸은 끝까지 버티다 사라진다
  for (let i = 0; i < 4; i++) { const tile = tiles[order[n++]]; t += i === 3 ? 6 : 3.5; tile.warnAt = t; tile.offAt = t + 1.8; }
  l.tiles = tiles;
  l.checkpoints[0].spawn = [0, 0, 3.4];
  return l;
}

/**
 * 최후의 생존자 "좁아지는 섬"
 * 바깥 고리부터 한 칸씩 무너지고, 회전봉이 하나씩 늘어나며 빨라진다.
 */
export function buildLast(seed: number): LevelDef {
  const r = rng(seed);
  const dir = r() < 0.5 ? 1 : -1;
  const l = base('last', '좁아지는 섬');
  const N = 7, pitch = 3.0, half = 1.44, c = (N - 1) / 2;
  const rings: Tile[][] = [[], [], [], []];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const ring = Math.max(Math.abs(i - c), Math.abs(j - c));
    const tile: Tile = {
      shape: 'box', p: [(i - c) * pitch, -0.4, (j - c) * pitch], h: [half, 0.4, half],
      color: ['#ff8fc7', '#ffd04d', '#5fe0a8', '#5cc8ff'][ring], warnAt: NEVER, offAt: NEVER,
    };
    rings[ring].push(tile);
  }
  // 고리마다 시계 방향으로 돌아가며 무너진다(시작 지점은 무작위)
  const plan = [
    { ring: 3, from: T0 + 8, step: 0.75 },
    { ring: 2, from: T0 + 32, step: 1.1 },
    { ring: 1, from: T0 + 56, step: 2.0 },
    { ring: 0, from: T0 + 84, step: 1 },
  ];
  for (const pl of plan) {
    const list = rings[pl.ring].sort((a, b) => Math.atan2(a.p[0], a.p[2]) - Math.atan2(b.p[0], b.p[2]));
    const start = Math.floor(r() * list.length);
    list.forEach((_, k) => {
      const tile = list[(start + k * (dir > 0 ? 1 : list.length - 1)) % list.length];
      tile.offAt = pl.from + k * pl.step;
      tile.warnAt = tile.offAt - 2;
    });
  }
  l.tiles = rings.flat();
  pillar(l);
  const bar = (y: number, speed: number, startAt: number, color: string, accel: number, maxSpeed: number): Sweeper =>
    ({ c: [0, y, 0], len: 10.6, r: 0.3, speed, phase: r() * 6.28, color, startAt, accel, maxSpeed });
  l.sweepers = [
    bar(0.45, 1.0 * dir, T0 + 4, '#ff4f8b', 0.03, 3.2),
    bar(1.85, -0.8 * dir, T0 + 30, '#ffa94d', 0.03, 2.6),
  ];
  l.spawnRing = 7.2;
  return l;
}

/**
 * 폭탄 피하기 "펑펑 광장"
 * 폭탄이 나타나 빨간 원을 그린 뒤 터진다. 원 밖으로 나가거나 벽 뒤에 숨으면 안전하다.
 * 뒤로 갈수록 폭탄이 잦아지고, 중간에 광장 바깥 고리가 무너진다.
 */
export function buildBomb(seed: number): LevelDef {
  const r = rng(seed);
  const l = base('bomb', '펑펑 광장');
  const N = 7, pitch = 3.2, half = 1.56, c = (N - 1) / 2;
  const shrink = T0 + 40;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const ring = Math.max(Math.abs(i - c), Math.abs(j - c));
    const off = ring === 3 ? shrink : NEVER;
    l.tiles!.push({
      shape: 'box', p: [(i - c) * pitch, -0.4, (j - c) * pitch], h: [half, 0.4, half],
      color: (i + j) % 2 ? '#b693ff' : '#5cc8ff', warnAt: off - 3, offAt: off,
    });
  }
  // 엄폐용 벽 4개(바람개비 모양으로 배치)
  const wall = (x: number, z: number, alongX: boolean) =>
    l.statics.push({ p: [x, 0.95, z], h: alongX ? [1.7, 0.95, 0.35] : [0.35, 0.95, 1.7], color: '#ffd04d' });
  wall(-4.8, -3.2, true); wall(4.8, 3.2, true); wall(-3.2, 4.8, false); wall(3.2, -4.8, false);
  const bombs: Bomb[] = [];
  let t = T0 + 3, k = 0;
  while (t < T0 + 74) {
    const prog = Math.min(1, (t - T0) / 60);
    const lim = (t + 2.5 > shrink ? 7.4 : 10.4); // 무너진 고리 위에는 놓지 않는다
    const big = k % 5 === 4;
    const count = prog > 0.55 && k % 3 === 0 ? 2 : 1; // 후반에는 두 개씩
    for (let i = 0; i < count; i++) {
      bombs.push({
        p: [(r() * 2 - 1) * lim, 0, (r() * 2 - 1) * lim], at: t + i * 0.25,
        fuse: big ? 3 : 2.3 - prog * 0.7, radius: big ? 6.2 : 4.4,
      });
    }
    t += 2.3 - prog * 1.5;
    k++;
  }
  l.bombs = bombs.sort((a, b) => a.at + a.fuse - (b.at + b.fuse));
  l.checkpoints[0].spawn = [0, 0, 3.4];
  return l;
}

/**
 * 보물 쟁탈전 "반짝 보물섬"
 * 보석을 먼저 집는 사람이 임자. 회전봉 안쪽과 건너편 작은 섬에는 3점짜리 큰 보석이 나온다.
 * 떨어지면 출발 지점에서 다시 시작하고 점수가 깎인다.
 */
export function buildTreasure(seed: number): LevelDef {
  const r = rng(seed);
  const dir = r() < 0.5 ? 1 : -1;
  const l = base('treasure', '반짝 보물섬');
  l.noRespawn = false;
  l.killY = -7;
  const H = 12; // 본섬 절반 크기
  l.statics.push({ p: [0, -0.5, 0], h: [H, 0.5, H], color: '#5fe0a8' });
  const isles: [number, number][] = [[H + 4.2, 0], [-H - 4.2, 0], [0, H + 4.2], [0, -H - 4.2]];
  for (const [x, z] of isles) l.statics.push({ p: [x, -0.5, z], h: [2, 0.5, 2], color: '#ffd04d' });
  pillar(l);
  l.sweepers = [
    { c: [0, 0.45, 0], len: 5.6, r: 0.3, speed: 1.7 * dir, phase: r() * 6.28, color: '#ff4f8b', startAt: T0 + 1.5 },
    { c: [0, 1.85, 0], len: 5.6, r: 0.3, speed: -1.1 * dir, phase: r() * 6.28, color: '#ffa94d', startAt: T0 + 1.5 },
  ];
  const items: Item[] = [];
  for (let t = T0 + 0.5; t < T0 + 58; t += 0.4) {
    const roll = r();
    if (roll < 0.15) {
      const a = r() * 6.28, d = 1.8 + r() * 3.4; // 회전봉 안쪽
      items.push({ p: [Math.sin(a) * d, 0.7, Math.cos(a) * d], at: t, value: 3 });
    } else if (roll < 0.3) {
      const [x, z] = isles[Math.floor(r() * 4)]; // 건너편 섬
      items.push({ p: [x + (r() * 2 - 1) * 1.2, 0.7, z + (r() * 2 - 1) * 1.2], at: t, value: 3 });
    } else {
      let x = 0, z = 0;
      do { x = (r() * 2 - 1) * (H - 1); z = (r() * 2 - 1) * (H - 1); } while (Math.hypot(x, z) < 6.5);
      items.push({ p: [x, 0.7, z], at: t, value: 1 });
    }
  }
  l.items = items;
  l.checkpoints[0].spawn = [0, 0, -7.2];
  l.spawnCols = 10;
  l.spawnSpacing = 1.4;
  return l;
}
