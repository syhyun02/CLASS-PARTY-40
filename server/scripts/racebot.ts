/**
 * 완주 검증: 장애물을 보고 피하는 봇 1명 + 직진만 하는 봇 3명이 실제 서버에서 레이스를 한다.
 * 코스가 끝까지 갈 수 있는지, 결승 판정·순위·점수가 서버에서 제대로 나오는지 확인한다.
 *   npx tsx scripts/racebot.ts --url http://localhost:3001
 */
import { io, type Socket } from 'socket.io-client';
import { DT, TICK_RATE, buildLevel, moverOffset, sweeperAngle, unpackState, newPlayerState, decodeSelf, fromB64, type CreateRes, type JoinRes, type LevelDef, type PlayerState, type RoomState, type SelfMsg } from '@shared';

const i0 = process.argv.indexOf('--url');
const URL = i0 >= 0 ? process.argv[i0 + 1] : 'http://localhost:3001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const connect = () => new Promise<Socket>((res) => { const s = io(URL, { transports: ['websocket'], forceNew: true }); s.once('connect', () => res(s)); });

const host = await connect();
let room: RoomState | null = null;
host.on('room', (r: RoomState) => { room = r; });
const created = await new Promise<CreateRes>((res) => host.emit('host:create', { config: { mode: 'play', rounds: 1, games: ['race'] } }, res));

interface Bot { socket: Socket; id: number; s: PlayerState | null; tick: number; seq: number; smart: boolean }
const bots: Bot[] = [];
for (let i = 0; i < 4; i++) {
  const socket = await connect();
  const res = await new Promise<JoinRes>((r) => socket.emit('join', { code: created.code, name: i === 0 ? '똑똑봇' : `직진봇${i}`, color: '#4d96ff' }, r));
  if (!res.ok) throw new Error(res.error);
  const b: Bot = { socket, id: res.id, s: null, tick: 0, seq: 0, smart: i === 0 };
  socket.on('u', (_snap: string, self?: string) => { if (!self) return; const m = decodeSelf(fromB64(self)); b.s = unpackState(m.s, b.s ?? newPlayerState(buildLevel('lobby', 0), 0)); b.tick = m.t; });
  bots.push(b);
}

let level: LevelDef | null = null, levelKey = '';
function decide(b: Bot): [number, number, number] {
  const s = b.s!;
  if (!b.smart || !level || !room) return [0, 127, 0];
  const t = (b.tick - room.levelTick) * DT + 0.08;
  let tx = s.x, jump = 0, go = 1;
  // 움직이는 벽: 벽이 없는 쪽 가장자리로
  for (const m of level.movers) {
    if (m.kind !== 'wall') continue;
    const dz = m.p[2] - s.z;
    if (dz > -1.5 && dz < 6) {
      const cx = m.p[0] + moverOffset(m, t)[0];
      tx = cx > 0 ? -6.9 : 6.9;
      if (dz < 1.6 && Math.abs(s.x - cx) < m.h[0] + 0.9) go = 0; // 아직 벽 앞이면 기다린다
    }
  }
  // 흔들다리·움직이는 발판: 가까운 다리 가운데로
  const plats = level.movers.filter((m) => m.kind === 'platform' && m.h[2] > 5);
  for (const m of plats) {
    if (s.z > m.p[2] - m.h[2] - 6 && s.z < m.p[2] + m.h[2]) {
      const best = plats.map((p) => p.p[0] + moverOffset(p, t)[0]).sort((a, c) => Math.abs(a - s.x) - Math.abs(c - s.x))[0];
      tx = best;
      if (s.z < m.p[2] - m.h[2] - 0.6 && Math.abs(s.x - best) > 0.9) go = 0;
    }
  }
  // 징검다리: 다음 줄에서 가장 가까운 돌(마지막에는 건너편 바닥)을 향해 달리다가 끝에서 점프
  const stones = level.statics.filter((b2) => b2.h[0] < 2 && b2.h[2] < 2 && b2.h[1] < 0.5);
  if (stones.length) {
    const zs = stones.map((b2) => b2.p[2]);
    const z0 = Math.min(...zs) - 5, zEnd = Math.max(...zs) + 1.25 + 2;
    if (s.z > z0 && s.z < zEnd) {
      const ahead = stones.filter((b2) => b2.p[2] - b2.h[2] > s.z - 0.1).sort((a, c) => (a.p[2] - c.p[2]) || (Math.abs(a.p[0] - s.x) - Math.abs(c.p[0] - s.x)));
      const rowZ = ahead[0]?.p[2];
      const target = ahead.filter((b2) => b2.p[2] === rowZ).sort((a, c) => Math.abs(a.p[0] - s.x) - Math.abs(c.p[0] - s.x))[0];
      const gap = target ? target.p[2] - target.h[2] - s.z : zEnd - s.z;
      if (target) tx = target.p[0];
      if (gap < 2.9 && s.grounded) jump = 1;
    }
  }
  // 회전봉: 낮은 봉이 다가오면 점프, 높은 봉이 겹치면 기다린다
  for (const sw of level.sweepers) {
    const dzc = sw.c[2] - s.z;
    if (Math.abs(dzc) > sw.len + 2.5) continue;
    const high = sw.c[1] - s.y > 1.2;
    for (const dtt of [0, 0.1, 0.2, 0.3]) {
      const a = sweeperAngle(sw, t + dtt);
      const fx = s.x, fz = s.z + (go ? 6.2 * dtt : 0);
      const ox = fx - sw.c[0], oz = fz - sw.c[2];
      const along = ox * Math.cos(a) + oz * Math.sin(a), side = -ox * Math.sin(a) + oz * Math.cos(a);
      if (Math.abs(along) < sw.len + 0.5 && Math.abs(side) < 1.0) { if (high) { jump = 0; go = Math.min(go, 0); } else if (s.grounded) jump = 1; }
    }
  }
  const mx = Math.max(-1, Math.min(1, (tx - s.x) * 1.6));
  return [Math.round(mx * 127), Math.round(go * 127), jump];
}

const timer = setInterval(() => {
  if (room && room.levelKey !== levelKey) { levelKey = room.levelKey; level = buildLevel(room.levelId, room.levelSeed); }
  for (const b of bots) { if (!b.s) { b.socket.emit('in', [++b.seq, 0, 0, 0]); continue; } const [mx, mz, j] = decide(b); b.socket.emit('in', [++b.seq, mx, mz, j]); }
}, 1000 / TICK_RATE);

await sleep(1000);
host.emit('host:cmd', { type: 'start' });
let lastCp = -1;
const t0 = Date.now();
while (Date.now() - t0 < 150_000) {
  await sleep(500);
  const s = bots[0].s;
  if (room!.phase === 'playing' && s && s.cp !== lastCp) { lastCp = s.cp; console.log(`똑똑봇 체크포인트 ${s.cp} (z=${s.z.toFixed(1)}, 낙하 ${s.falls}회, ${((Date.now() - t0) / 1000 - 10).toFixed(0)}초)`); }
  if (s && s.cp >= 5 && process.env.DBG) console.log(room!.phase, 'place', room!.players.find((p) => p.id === bots[0].id)?.place, s.cp, s.x.toFixed(1), s.y.toFixed(1), s.z.toFixed(1), 'g', s.grounded, 'falls', s.falls, 'd', decide(bots[0]).join(','));
  if (room!.phase === 'result' || room!.phase === 'final') break;
}
console.log('단계:', room!.phase);
console.table(room!.lastResult?.map((r) => ({ 순위: r.rank, 이름: r.name, 점수: r.points, 기록: r.detail, 누적: r.total })));
clearInterval(timer);
host.emit('host:cmd', { type: 'end' });
await sleep(200);
process.exit(0);
