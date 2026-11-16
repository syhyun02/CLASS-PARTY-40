/**
 * 부하 테스트: 봇 N명이 실제 학생처럼 방에 들어와 30Hz로 입력을 보낸다.
 *   npm run loadtest -- --bots 40 --seconds 30 --url http://localhost:3001
 * 서버 틱 시간, CPU, 메모리, 통신량, 왕복 지연, 스냅샷 수신 주기를 출력한다.
 */
import { io, type Socket } from 'socket.io-client';
import { TICK_RATE, decodeSnapshot, type CreateRes, type JoinRes, type RoomState, type SelfMsg } from '@shared';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const URL = arg('url', 'http://localhost:3001');
const BOTS = Number(arg('bots', '40'));
const SECONDS = Number(arg('seconds', '30'));
const ROUNDS = Number(arg('rounds', '1'));
const WAIT = Number(arg('wait', '1.5')); // 시작 전 대기(초): 실제 브라우저가 같은 방에 들어올 시간

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const getMetrics = async () => (await fetch(`${URL}/api/metrics`)).json() as Promise<any>;
const connect = () => new Promise<Socket>((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.once('connect', () => res(s));
  s.once('connect_error', rej);
});

interface Bot { socket: Socket; id: number; seq: number; snaps: number; gaps: number[]; lastSnap: number; rtts: number[]; z: number; cp: number; bytes: number; ackLag: number[] }

const host = await connect();
let room: RoomState | null = null;
host.on('room', (r: RoomState) => { room = r; });
const created = await new Promise<CreateRes>((res) => host.emit('host:create', { config: { mode: 'play', rounds: ROUNDS, games: ['race'] } }, res));
if (!created.ok) throw new Error(created.error);
console.log(`방 ${created.code} 생성, 봇 ${BOTS}명 접속 중...`);

const bots: Bot[] = [];
for (let i = 0; i < BOTS; i++) {
  const socket = await connect();
  const res = await new Promise<JoinRes>((r) => socket.emit('join', { code: created.code, name: `봇${i + 1}`, color: '#ff6b8b' }, r));
  if (!res.ok) throw new Error(res.error);
  const bot: Bot = { socket, id: res.id, seq: 0, snaps: 0, gaps: [], lastSnap: 0, rtts: [], z: 0, cp: 0, bytes: 0, ackLag: [] };
  socket.on('s', (buf: ArrayBuffer | Buffer) => {
    const now = performance.now();
    if (bot.lastSnap) bot.gaps.push(now - bot.lastSnap);
    bot.lastSnap = now; bot.snaps++;
    bot.bytes += (buf as any).byteLength ?? (buf as any).length;
    if (i === 0) decodeSnapshot(buf instanceof ArrayBuffer ? buf : (buf as Buffer).buffer.slice((buf as Buffer).byteOffset, (buf as Buffer).byteOffset + (buf as Buffer).length) as ArrayBuffer);
  });
  socket.on('me', (m: SelfMsg) => { bot.z = m.s[2]; bot.cp = m.s[13]; bot.ackLag.push(bot.seq - m.q); bot.bytes += JSON.stringify(m).length; });
  bots.push(bot);
}

// 실제 클라이언트처럼 30Hz로 입력 전송. 앞으로 달리며 가끔 방향을 틀고 점프한다.
const timer = setInterval(() => {
  const t = performance.now() / 1000;
  for (let i = 0; i < bots.length; i++) {
    const b = bots[i];
    const mx = Math.round(Math.sin(t * 0.7 + i) * 60);
    const jump = Math.sin(t * 2.3 + i * 1.7) > 0.6 ? 1 : 0;
    b.socket.emit('in', [++b.seq, mx, 127, jump]);
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
