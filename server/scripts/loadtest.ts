/**
 * 부하 테스트: 봇 N명이 실제 학생처럼 방에 들어와 30Hz로 입력을 보낸다.
 *   npm run loadtest -- --bots 40 --seconds 30 --url http://localhost:3001
 * 서버 틱 시간, CPU, 메모리, 통신량, 왕복 지연, 스냅샷 수신 주기를 출력한다.
 */
import { io, type Socket } from 'socket.io-client';
import { DT, QUIZ_PAD_POS, buildLevel, sweeperAngle, sweeperSpeed, TICK_RATE, decodeSnapshot, type CreateRes, type JoinRes, type RoomState, type SelfMsg } from '@shared';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const URL = arg('url', 'http://localhost:3001');
const BOTS = Number(arg('bots', '40'));
const SECONDS = Number(arg('seconds', '30'));
const ROUNDS = Number(arg('rounds', '1'));
const GAME = arg('game', 'race');
const SMART = process.argv.includes('--smart'); // 생존 게임에서 발판과 봉을 보고 피하는 봇
const WAIT = Number(arg('wait', '1.5')); // 시작 전 대기(초): 실제 브라우저가 같은 방에 들어올 시간

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const getMetrics = async () => (await fetch(`${URL}/api/metrics`)).json() as Promise<any>;
const connect = () => new Promise<Socket>((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.once('connect', () => res(s));
  s.once('connect_error', rej);
});

interface Bot { x: number; y: number; grounded: number; tick: number; socket: Socket; id: number; seq: number; snaps: number; gaps: number[]; lastSnap: number; rtts: number[]; z: number; cp: number; bytes: number; ackLag: number[] }

const host = await connect();
let room: RoomState | null = null;
host.on('room', (r: RoomState) => { room = r; });
let taken = new Set<number>();
let gameMsgs = 0;
host.on('g', (m: { state: { taken: number[]; scores: [number, number][] } | null }) => { gameMsgs++; taken = new Set(m.state?.taken ?? []); });
const created = await new Promise<CreateRes>((res) => host.emit('host:create', { config: { mode: 'play', rounds: ROUNDS, games: [GAME] } }, res));
if (!created.ok) throw new Error(created.error);
console.log(`방 ${created.code} 생성, 봇 ${BOTS}명 접속 중...`);

const bots: Bot[] = [];
for (let i = 0; i < BOTS; i++) {
  const socket = await connect();
  const res = await new Promise<JoinRes>((r) => socket.emit('join', { code: created.code, name: `봇${i + 1}`, color: '#ff6b8b' }, r));
  if (!res.ok) throw new Error(res.error);
  const bot: Bot = { x: 0, y: 0, grounded: 1, tick: 0, socket, id: res.id, seq: 0, snaps: 0, gaps: [], lastSnap: 0, rtts: [], z: 0, cp: 0, bytes: 0, ackLag: [] };
  socket.on('s', (buf: ArrayBuffer | Buffer) => {
    const now = performance.now();
    if (bot.lastSnap) bot.gaps.push(now - bot.lastSnap);
    bot.lastSnap = now; bot.snaps++;
    bot.bytes += (buf as any).byteLength ?? (buf as any).length;
    if (i === 0) decodeSnapshot(buf instanceof ArrayBuffer ? buf : (buf as Buffer).buffer.slice((buf as Buffer).byteOffset, (buf as Buffer).byteOffset + (buf as Buffer).length) as ArrayBuffer);
  });
  socket.on('me', (m: SelfMsg) => { bot.x = m.s[0]; bot.y = m.s[1]; bot.grounded = m.s[7]; bot.tick = m.t; bot.z = m.s[2]; bot.cp = m.s[13]; bot.ackLag.push(bot.seq - m.q); bot.bytes += JSON.stringify(m).length; });
  bots.push(bot);
}

// 실제 클라이언트처럼 30Hz로 입력 전송. 앞으로 달리며 가끔 방향을 틀고 점프한다.
const timer = setInterval(() => {
  const t = performance.now() / 1000;
  for (let i = 0; i < bots.length; i++) {
    const b = bots[i];
    const mx = Math.round(Math.sin(t * 0.7 + i) * 60);
    const jump = Math.sin(t * 2.3 + i * 1.7) > 0.6 ? 1 : 0;
    if (SMART && room && room.levelId !== 'lobby') {
      const lv = buildLevel(room.levelId, room.levelSeed);
      const lt = (b.tick - room.levelTick) * DT + 0.1;
      // 2.5초 넘게 남은 발판 중 가장 가까운 곳의 가운데로 간다(원판은 가장 안쪽 반지름 안으로)
      let tx = b.x, tz = b.z, best = 1e9;
      for (const tl of lv.tiles ?? []) {
        if (tl.offAt - lt < 2.5) continue;
        if (tl.shape === 'disc') { const r = Math.hypot(b.x, b.z), lim = tl.h[0] - 1.5; if (r > lim || best === 1e9) { const k = r > 0.1 ? Math.min(1, lim / r) : 1; const d = Math.max(0, r - lim); if (d < best || best === 1e9) { best = d; tx = b.x * k; tz = b.z * k; } } else { best = 0; tx = b.x; tz = b.z; } continue; }
        const d = Math.hypot(tl.p[0] - b.x, tl.p[2] - b.z) + (Math.hypot(tl.p[0], tl.p[2]) < 1.5 ? 3 : 0) + ((i * 7 + Math.round(tl.p[0] * 3 + tl.p[2])) % 5) * 0.2;
        if (d < best) { best = d; tx = tl.p[0]; tz = tl.p[2]; }
      }
      // 폭탄 범위 안이면 가장 가까운 바깥으로(광장 밖으로는 나가지 않게)
      for (const bm of lv.bombs ?? []) {
        if (lt < bm.at || lt > bm.at + bm.fuse) continue;
        const ox = b.x - bm.p[0], oz = b.z - bm.p[2], d = Math.hypot(ox, oz);
        if (d > bm.radius + 0.8) continue;
        const lim = lt > 40 ? 6.5 : 9.5;
        let a = d > 0.1 ? Math.atan2(ox, oz) : i;
        for (let k = 0; k < 8; k++) {
          const cx = bm.p[0] + Math.sin(a) * (bm.radius + 1.6), cz = bm.p[2] + Math.cos(a) * (bm.radius + 1.6);
          if (Math.abs(cx) < lim && Math.abs(cz) < lim) { tx = cx; tz = cz; break; }
          a += (k % 2 ? -1 : 1) * (k + 1) * 0.5;
        }
      }
      // 보물: 본섬에 있는 가장 가까운 보석으로
      if (lv.items) {
        let bd = 1e9;
        lv.items.forEach((it, k) => {
          if (it.at > lt || taken.has(k) || Math.abs(it.p[0]) > 11 || Math.abs(it.p[2]) > 11 || Math.hypot(it.p[0], it.p[2]) < 6.8) return;
          const d = Math.hypot(it.p[0] - b.x, it.p[2] - b.z);
          if (d < bd) { bd = d; tx = it.p[0]; tz = it.p[2]; }
        });
        // 가는 길이 회전봉 구역을 지나면 돌아간다
        if (Math.hypot(b.x, b.z) < 7.2) { const a = Math.atan2(b.x, b.z); tx = Math.sin(a) * 9; tz = Math.cos(a) * 9; }
      }
      // 정답 발판: 열에 일곱은 정답 발판으로, 나머지는 아무 발판으로
      if (lv.quiz) {
        let q = lv.quiz[0];
        for (const x of lv.quiz) if (x.at <= lt) q = x;
        const k = lv.quiz.indexOf(q);
        const padI = (i * 7 + k * 3) % 10 < 7 ? q.answer : (i + k) % 4;
        const inWindow = lt >= q.at && lt < q.endAt;
        tx = inWindow ? QUIZ_PAD_POS[padI][0] * 0.9 + Math.sin(i) * 1.5 : Math.sin(i) * 1.2;
        tz = inWindow ? QUIZ_PAD_POS[padI][1] * 0.9 + Math.cos(i) * 1.5 : Math.cos(i) * 1.2;
      }
      // 씨름판·꼬리: 판 안에서 돌아다니며 밀치기를 누른다
      if (room.levelId === 'sumo' || room.levelId === 'tail') {
        const R = room.levelId === 'sumo' ? (lt > 50 ? 3.4 : lt > 28 ? 5.6 : 7.5) : 10;
        const a = lt * (0.5 + (i % 5) * 0.15) + i * 1.3;
        tx = Math.sin(a) * R * (0.3 + (i % 4) * 0.2); tz = Math.cos(a * 1.3) * R * (0.3 + (i % 3) * 0.25);
      }
      // 가운데 기둥에서는 떨어져 선다
      if (Math.hypot(tx, tz) < 1.6) { const a = i * 2.4; tx += Math.sin(a) * 1.0; tz += Math.cos(a) * 1.0; }
      let jmp = 0, hold = false;
      for (const sw of lv.sweepers) {
        if (sweeperSpeed(sw, lt) === 0) continue;
        const high = sw.c[1] > 1.2;
        for (const dtt of [0, 0.08, 0.16, 0.24]) {
          const a = sweeperAngle(sw, lt + dtt);
          const along = b.x * Math.cos(a) + b.z * Math.sin(a), side = -b.x * Math.sin(a) + b.z * Math.cos(a);
          if (Math.abs(along) < sw.len + 0.5 && Math.abs(side) < 1.0) { if (high) hold = true; else jmp = 1; }
        }
      }
      if (hold) jmp = 0;
      const dx = tx - b.x, dz = tz - b.z, dl = Math.hypot(dx, dz);
      const sp = dl > 0.3 ? 1 : 0;
      const act = (room.levelId === 'sumo' || room.levelId === 'tail') && Math.sin(lt * 3 + i) > 0.7 ? 2 : 0;
      b.socket.emit('in', [++b.seq, Math.round((dx / (dl || 1)) * 127 * sp), Math.round((dz / (dl || 1)) * 127 * sp), jmp | act]);
      continue;
    }
    const mz = GAME === 'race' ? 127 : Math.round(Math.cos(t * 0.5 + i * 2) * 110);
    b.socket.emit('in', [++b.seq, GAME === 'race' ? mx : Math.round(Math.sin(t * 0.5 + i * 2) * 110), mz, jump]);
  }
}, 1000 / TICK_RATE);
const pinger = setInterval(() => {
  for (const b of bots) b.socket.emit('pg', performance.now(), (t0: number) => b.rtts.push(performance.now() - t0));
}, 1000);

await sleep(WAIT * 1000);
host.emit('host:cmd', { type: 'start' });
await sleep(11_000); // 추첨 + 카운트다운이 끝나고 경기가 시작될 때까지
console.log(`측정 시작(${SECONDS}초, 단계: ${room!.phase})`);
for (const b of bots) { b.snaps = 0; b.gaps = []; b.rtts = []; b.bytes = 0; b.ackLag = []; }
const m0 = await getMetrics();
const t0 = performance.now();
await sleep(SECONDS * 1000);
const m1 = await getMetrics();
const dur = (performance.now() - t0) / 1000;

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const all = (f: (b: Bot) => number[]) => bots.flatMap(f);
const gaps = all((b) => b.gaps), rtts = all((b) => b.rtts), lag = all((b) => b.ackLag);
const finished = room!.players.filter((p) => p.place !== null).length;
console.log('게임 상태 메시지 수:', gameMsgs);
if (room!.lastResult) { const ts = room!.lastResult.map((r) => parseFloat(r.detail)).filter((v) => !isNaN(v)).sort((a, c) => a - c); console.log('탈락 시각 분포(초):', [0, 0.25, 0.5, 0.75, 1].map((q) => ts[Math.min(ts.length - 1, Math.floor(q * ts.length))]).join(' / ')); }
if (room!.lastResult) console.log('결과 상위 5:', room!.lastResult.slice(0, 5).map((r) => `${r.rank}위 ${r.name} +${r.points} (${r.detail})`).join(' | '), '· 하위:', room!.lastResult.slice(-2).map((r) => `${r.rank}위 +${r.points} (${r.detail})`).join(' | '));

console.log(JSON.stringify({
  bots: BOTS, seconds: +dur.toFixed(1),
  server: {
    tickAvgMs: +m1.tick.avg.toFixed(3), tickP99Ms: +m1.tick.p99.toFixed(3), tickMaxMs: +m1.tick.max.toFixed(3),
    tickBudgetMs: +(1000 / TICK_RATE).toFixed(1),
    actualTickHz: +((m1.ticks - m0.ticks) / dur).toFixed(2),
    lateTicks: m1.lateTicks - m0.lateTicks,
    cpuPercentOfOneCore: +(((m1.cpuMs - m0.cpuMs) / (dur * 1000)) * 100).toFixed(1),
    rssMb: +m1.rssMb.toFixed(1), heapMb: +m1.heapMb.toFixed(1),
    outKBps: +((m1.bytesOut - m0.bytesOut) / dur / 1024).toFixed(1),
  },
  perClient: {
    snapshotHz: +(bots.reduce((s, b) => s + b.snaps, 0) / bots.length / dur).toFixed(2),
    snapshotGapP50Ms: +pct(gaps, 0.5).toFixed(1), snapshotGapP99Ms: +pct(gaps, 0.99).toFixed(1), snapshotGapMaxMs: +Math.max(...gaps).toFixed(1),
    rttP50Ms: +pct(rtts, 0.5).toFixed(1), rttP99Ms: +pct(rtts, 0.99).toFixed(1),
    downKBps: +(bots.reduce((s, b) => s + b.bytes, 0) / bots.length / dur / 1024).toFixed(2),
    unackedInputsP50: pct(lag, 0.5), unackedInputsP99: pct(lag, 0.99),
  },
  game: { phase: room!.phase, finished, farthestZ: +Math.max(...bots.map((b) => b.z)).toFixed(1), maxCheckpoint: Math.max(...bots.map((b) => b.cp)) },
}, null, 2));

clearInterval(timer); clearInterval(pinger);
host.emit('host:cmd', { type: 'end' });
await sleep(300);
for (const b of bots) b.socket.close();
host.close();
process.exit(0);
