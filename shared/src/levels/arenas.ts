import { COUNTDOWN_SEC } from '../constants';
import { NEVER, type Ball, type Bomb, type Item, type LevelDef, type Sweeper, type Tile } from '../level';
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
  // 바깥 고리가 30초에, 그다음 고리가 55초에 무너져 마지막엔 가운데 3×3칸만 남는다
  const shrink1 = T0 + 30, shrink2 = T0 + 55;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const ring = Math.max(Math.abs(i - c), Math.abs(j - c));
    const off = ring === 3 ? shrink1 : ring === 2 ? shrink2 : NEVER;
    l.tiles!.push({
      shape: 'box', p: [(i - c) * pitch, -0.4, (j - c) * pitch], h: [half, 0.4, half],
      color: ring === 2 ? '#ff8fc7' : (i + j) % 2 ? '#b693ff' : '#5cc8ff', warnAt: off - 3, offAt: off,
    });
  }
  // 엄폐용 벽 4개(바람개비 모양으로 배치)
  const wall = (x: number, z: number, alongX: boolean) =>
    l.statics.push({ p: [x, 0.95, z], h: alongX ? [1.7, 0.95, 0.35] : [0.35, 0.95, 1.7], color: '#ffd04d' });
  wall(-4.8, -3.2, true); wall(4.8, 3.2, true); wall(-3.2, 4.8, false); wall(3.2, -4.8, false);
  const bombs: Bomb[] = [];
  let t = T0 + 2.5, k = 0;
  while (t < T0 + 74) {
    const prog = Math.min(1, (t - T0) / 60); // 0 → 1: 갈수록 어려워진다
    // 무너질 칸 위에는 놓지 않는다
    const lim = t + 2.5 > shrink2 ? 4.2 : t + 2.5 > shrink1 ? 7.4 : 10.4;
    const big = k % 4 === 3;
    // 중반부터 두 개씩, 후반엔 세 개까지 한꺼번에 떨어진다
    const count = prog > 0.7 && k % 3 === 0 ? 3 : prog > 0.3 && k % 2 === 0 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      // 절반은 사람이 모이는 가운데 쪽을 노린다
      const spread = r() < 0.5 ? lim * 0.45 : lim;
      bombs.push({
        p: [(r() * 2 - 1) * spread, 0, (r() * 2 - 1) * spread], at: t + i * 0.2,
        fuse: big ? 2.6 - prog * 0.6 : 2.0 - prog * 0.8, radius: big ? 6.5 : 4.4 + prog * 0.6,
      });
    }
    t += 1.8 - prog * 1.25;
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

/**
 * 밀어내기 "영차영차 씨름판"
 * 밀기 버튼(쿨타임 있음)으로 앞에 있는 친구를 밀어낸다. 판이 두 번 줄어든다.
 */
export function buildSumo(_seed: number): LevelDef {
  const l = base('sumo', '영차영차 씨름판');
  l.tiles = [
    disc(10, -0.08, '#5cc8ff', T0 + 26),
    disc(7.5, -0.04, '#b693ff', T0 + 48),
    disc(5, 0, '#ff8fc7'),
  ];
  l.spawnRing = 6.5;
  return l;
}

/**
 * 꼬리 지키기 "꼬리 지키기"
 * 넓은 마당에 숨을 곳이 될 상자가 놓여 있다. 떨어지면 가운데에서 다시 시작한다.
 */
export function buildTail(seed: number): LevelDef {
  const r = rng(seed);
  const l = base('tail', '꼬리 지키기');
  l.noRespawn = false;
  l.killY = -7;
  l.statics.push({ p: [0, -0.5, 0], h: [13, 0.5, 13], color: '#ffd04d' });
  // 돌아서 도망칠 수 있는 상자 8개(가운데 출발 지점은 비워 둔다)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 6.283 + r() * 0.4, d = 6 + (i % 2) * 3.4;
    const w = 1 + r() * 0.9, dpt = 1 + r() * 0.9;
    l.statics.push({ p: [Math.sin(a) * d, 1.1, Math.cos(a) * d], h: [w, 1.1, dpt], color: ['#ff8fc7', '#5cc8ff', '#5fe0a8', '#b693ff'][i % 4] });
  }
  l.spawnRing = 3.6;
  return l;
}

/**
 * 피구공 피하기
 * 경기장 밖에서 공이 굴러 들어온다. 작은 공은 점프로 넘고, 큰 공은 옆으로 피한다.
 * 맞으면 공이 가는 방향으로 날아가서 경기장 밖으로 떨어질 수 있다.
 * 갈수록 공이 잦아지고 빨라지며, 한쪽에서 여러 개가 나란히 오는 "일제 사격"이 섞인다. 중간에 바깥 고리가 무너진다.
 */
export function buildDodge(seed: number): LevelDef {
  const r = rng(seed);
  const l = base('dodge', '피구공 피하기');
  const R = 11, R2 = 8, shrink = T0 + 48;
  l.tiles = [disc(R, -0.04, '#5cc8ff', shrink), disc(R2, 0, '#ffd04d')];
  l.killY = -7;
  const COLORS = ['#ff6b6b', '#ffa94d', '#9775fa', '#4dabf7', '#51cf66'];
  const balls: Ball[] = [];
  const START = R + 7; // 경기장 가장자리에서 7m 밖에서 출발(굴러오는 게 보이게)
  const add = (at: number, angle: number, aimX: number, aimZ: number, speed: number, big: boolean) => {
    const x = Math.sin(angle) * START, z = Math.cos(angle) * START;
    let dx = aimX - x, dz = aimZ - z;
    const len = Math.hypot(dx, dz); dx /= len; dz /= len;
    // 경기장 원(반지름 R)과 만나는 거리: 들어오는 지점과 나가는 지점
    const b = x * dx + z * dz, c = x * x + z * z - R * R, disc2 = b * b - c;
    if (disc2 <= 0) return;
    const tIn = -b - Math.sqrt(disc2), tOut = -b + Math.sqrt(disc2);
    const rad = big ? 1.15 : 0.55;
    balls.push({
      x, z, dx, dz, speed, r: rad, at,
      enter: at + tIn / speed, end: at + (tOut + 3) / speed,
      color: COLORS[balls.length % COLORS.length],
    });
  };
  let t = T0 + 2;
  while (t < T0 + 78) {
    const p = Math.min(1, (t - T0) / 65); // 0 → 1: 갈수록 어려워진다
    const speed = 6 + p * 6 + r() * 1.5;
    const angle = r() * Math.PI * 2;
    const lim = t + 2 > shrink ? R2 - 1.5 : R - 3;
    if (p > 0.35 && r() < 0.15 + p * 0.15) {
      // 일제 사격: 같은 쪽에서 작은 공 여러 개가 나란히 온다(점프로 넘어야 한다)
      const n = 3 + Math.floor(p * 3);
      for (let k = 0; k < n; k++) {
        // 모두 가운데를 향해 같은 방향으로 출발시킨 뒤, 출발점만 옆으로 벌려 나란히 굴러오게 한다
        const off = (k - (n - 1) / 2) * 2.6;
        const before = balls.length;
        add(t + k * 0.06, angle, 0, 0, speed * 0.9, false);
        if (balls.length > before) {
          const bl = balls[balls.length - 1];
          bl.x += Math.cos(angle) * off; bl.z += -Math.sin(angle) * off;
        }
      }
      t += 2.6 - p * 0.8;
    } else {
      const big = r() < 0.25 + p * 0.25;
      // 아무 데나가 아니라 경기장 안쪽의 한 지점을 노린다(사람이 모인 곳을 지나가게)
      add(t, angle, (r() * 2 - 1) * lim, (r() * 2 - 1) * lim, big ? speed * 0.8 : speed, big);
      t += Math.max(0.45, 2.0 - p * 1.4) * (0.7 + r() * 0.6); // 처음엔 2초에 하나, 끝엔 0.6초에 하나꼴
    }
  }
  balls.sort((a, b) => a.at - b.at);
  // 일제 사격은 출발점을 옮겼으므로 경기장 진입 시각을 다시 계산한다
  for (const b of balls) {
    const bb = b.x * b.dx + b.z * b.dz, c = b.x * b.x + b.z * b.z - R * R, d2 = bb * bb - c;
    if (d2 > 0) { b.enter = b.at + (-bb - Math.sqrt(d2)) / b.speed; b.end = b.at + (-bb + Math.sqrt(d2) + 3) / b.speed; }
  }
  l.balls = balls;
  l.spawnRing = 5.5;
  return l;
}
