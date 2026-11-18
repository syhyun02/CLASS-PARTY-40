/**
 * 부하 테스트: 봇 N명이 실제 학생처럼 방에 들어와 30Hz로 입력을 보낸다.
 *   npm run loadtest -- --bots 40 --seconds 30 --url http://localhost:3001
 * 서버 틱 시간, CPU, 메모리, 통신량, 왕복 지연, 스냅샷 수신 주기를 출력한다.
 */
import { io, type Socket } from 'socket.io-client';
import { CHEM_DOOR_X, DT, GOAL_DIRS, HOVER, PROP_ID_BASE, TEAMBALL, QUIZ_PAD_POS, ballPos, buildLevel, moverOffset, chemRowZ, sweeperAngle, sweeperSpeed, TICK_RATE, decodeSnapshot, decodeSelf, fromB64, type CreateRes, type JoinRes, type RoomState, type SelfMsg } from '@shared';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const URL = arg('url', 'http://localhost:3001');
const BOTS = Number(arg('bots', '40'));
const SECONDS = Number(arg('seconds', '30'));
const ROUNDS = Number(arg('rounds', '1'));
const GAME = arg('game', 'race');
const MODE = arg('mode', 'play') as 'play' | 'chem';
const SMART = process.argv.includes('--smart'); // 생존 게임에서 발판과 봉을 보고 피하는 봇
const WAIT = Number(arg('wait', '1.5')); // 시작 전 대기(초): 실제 브라우저가 같은 방에 들어올 시간

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const getMetrics = async () => (await fetch(`${URL}/api/metrics`)).json() as Promise<any>;
const connect = () => new Promise<Socket>((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.once('connect', () => res(s));
  s.once('connect_error', rej);
});

interface Bot { passed: number; wrong: [number, number][]; firstTries: number; x: number; y: number; grounded: number; tick: number; socket: Socket; id: number; seq: number; snaps: number; gaps: number[]; lastSnap: number; rtts: number[]; z: number; cp: number; bytes: number; ackLag: number[] }

const host = await connect();
let room: RoomState | null = null;
host.on('room', (r: RoomState) => { room = r; });
let taken = new Set<number>();
let gameMsgs = 0;
let revealed = 0, explained = 0, wrongTold = 0;
let props: [number, number][] = [];
let lvKey = '', lvCache: ReturnType<typeof buildLevel> | null = null; // 공 위치(0번 봇이 받은 스냅샷에서)
let lastTeams: number[] | undefined;
host.on('g', (m: { state: any }) => { gameMsgs++; if (m.state?.teams) lastTeams = m.state.teams; taken = new Set(m.state?.taken ?? []); if (m.state?.quiz?.answer !== undefined) revealed++; if (m.state?.quiz?.explain) explained++; });
const created = await new Promise<CreateRes>((res) => host.emit('host:create', { config: { mode: MODE, rounds: ROUNDS, games: [GAME], chem: { units: arg('units', '3,4').split(',').map(Number), levels: ['easy', 'normal', 'hard'] } } }, res));
if (!created.ok) throw new Error(created.error);
console.log(`방 ${created.code} 생성, 봇 ${BOTS}명 접속 중...`);

const bots: Bot[] = [];
for (let i = 0; i < BOTS; i++) {
  const socket = await connect();
  const res = await new Promise<JoinRes>((r) => socket.emit('join', { code: created.code, name: `봇${i + 1}`, color: '#ff6b8b' }, r));
  if (!res.ok) throw new Error(res.error);
  const bot: Bot = { passed: 0, wrong: [], firstTries: 0, x: 0, y: 0, grounded: 1, tick: 0, socket, id: res.id, seq: 0, snaps: 0, gaps: [], lastSnap: 0, rtts: [], z: 0, cp: 0, bytes: 0, ackLag: [] };
  socket.on('u', (snapB64: string, selfB64?: string) => {
    const now = performance.now();
    if (bot.lastSnap) bot.gaps.push(now - bot.lastSnap);
    bot.lastSnap = now; bot.snaps++;
    bot.bytes += snapB64.length + (selfB64?.length ?? 0) + 12;
    if (i === 0) { const sn = decodeSnapshot(fromB64(snapB64)); props = sn.players.filter((p) => p.id >= PROP_ID_BASE && !(p.flags & 8)).map((p) => [p.x, p.z]); }
    if (selfB64) { const m = decodeSelf(fromB64(selfB64)); bot.x = m.s[0]; bot.y = m.s[1]; bot.grounded = m.s[7]; bot.tick = m.t; bot.z = m.s[2]; bot.cp = m.s[13]; bot.ackLag.push(bot.seq - m.q); }
  });
  socket.on('gp', (m: { pass?: { q: number; first: boolean; explain: string }; wrong?: [number, number] }) => { if (m.pass) { bot.passed = m.pass.q + 1; if (m.pass.first) bot.firstTries++; if (m.pass.explain) explained++; } if (m.wrong) { bot.wrong.push(m.wrong); wrongTold++; } });
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
      // 맵은 바뀔 때만 만든다(봇마다 초당 30번씩 만들면 측정하는 컴퓨터의 CPU를 잡아먹는다)
      if (lvKey !== room.levelKey) { lvKey = room.levelKey; lvCache = buildLevel(room.levelId, room.levelSeed, room.levelQuiz); }
      const lv = lvCache!;
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
        const lim = lt > 53 ? 3.4 : lt > 30 ? 6.5 : 9.5;
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
        // 화학 모드에서는 정답을 미리 알 수 없으므로(-1) 아무 발판이나 고른다
        const padI = q.answer >= 0 && (i * 7 + k * 3) % 10 < 7 ? q.answer : (i + k) % 4;
        const inWindow = lt >= q.at && lt < q.endAt;
        tx = inWindow ? QUIZ_PAD_POS[padI][0] * 0.9 + Math.sin(i) * 1.5 : Math.sin(i) * 1.2;
        tz = inWindow ? QUIZ_PAD_POS[padI][1] * 0.9 + Math.cos(i) * 1.5 : Math.cos(i) * 1.2;
      }
      // 화학 미로: 지금 풀 문제의 문 가운데 아직 안 틀린 문으로 달려든다(봇은 정답을 모른다)
      if (room.levelId === 'chemmaze' && lv.quiz) {
        const qi = b.passed;
        if (qi >= lv.quiz.length) { tx = b.x; tz = b.z + 5; } else {
          const cand = [0, 1, 2].filter((d) => !b.wrong.some((w) => w[0] === qi && w[1] === d));
          const d = cand[(i + qi) % cand.length];
          tx = CHEM_DOOR_X[d]; tz = Math.abs(b.x - tx) > 1 ? Math.min(b.z + 1, chemRowZ(qi) - 2.5) : chemRowZ(qi) + 2;
        }
      }
      // 씨름판·꼬리: 판 안에서 돌아다니며 밀치기를 누른다
      if (room.levelId === 'sumo' || room.levelId === 'tail') {
        const R = room.levelId === 'sumo' ? (lt > 50 ? 3.4 : lt > 28 ? 5.6 : 7.5) : 10;
        const a = lt * (0.5 + (i % 5) * 0.15) + i * 1.3;
        tx = Math.sin(a) * R * (0.3 + (i % 4) * 0.2); tz = Math.cos(a * 1.3) * R * (0.3 + (i % 3) * 0.25);
      }
      let ballJump = 0;
      // 굴러오는 공: 1초 안에 내 자리를 지나갈 공이 있으면 작은 공은 뛰어넘고 큰 공은 옆으로 비킨다
      if (lv.balls && room.levelId !== 'hover') {
        tx = Math.sin(i * 2.4) * 3; tz = Math.cos(i * 2.4) * 3;
        for (const bl of lv.balls) {
          if (bl.at > lt + 1.2) break;
          if (lt > bl.end) continue;
          const [bx, bz] = ballPos(bl, lt);
          const rx = b.x - bx, rz = b.z - bz;
          const along = rx * bl.dx + rz * bl.dz; // 공 앞쪽으로 얼마나 떨어져 있나
          const side = rx * bl.dz - rz * bl.dx; // 공의 길에서 옆으로 얼마나 떨어져 있나
          if (along < -0.5 || along > bl.speed * 1.0 || Math.abs(side) > bl.r + 1.1) continue;
          if (bl.r < 1 && along < bl.speed * 0.22 && b.grounded) ballJump = 1;
          else if (bl.r >= 1) { const sg = side >= 0 ? 1 : -1; tx = b.x + bl.dz * sg * 3; tz = b.z - bl.dx * sg * 3; }
        }
        const rr = Math.hypot(tx, tz), lim = lt > 50 ? 6 : 9;
        if (rr > lim) { tx *= lim / rr; tz *= lim / rr; }
      }
      // 호버보드: 보드 앞쪽 가운데에 서 있다가, 낮은 봉·공은 점프, 구멍 벽은 가까운 구멍으로 비킨다
      if (room.levelId === 'hover' && lv.movers[0]) {
        const cz = lv.movers[0].p[2] + moverOffset(lv.movers[0], lt)[2];
        tx = Math.sin(i * 1.7) * 3.5; tz = cz + 2 + Math.cos(i * 1.3) * 2;
        for (const ob of lv.obstacles ?? []) {
          const ahead = ob.z - b.z;
          if (ahead < -0.6 || ahead > 9) continue;
          if (ob.kind === 'bar' && ahead < 1.2 && ahead > 0.2 && b.grounded) ballJump = 1;
          if (ob.kind === 'holes' && ob.gaps) {
            const g = ob.gaps.reduce((a, c) => (Math.abs(c - b.x) < Math.abs(a - b.x) ? c : a), ob.gaps[0]);
            tx = g + Math.sin(i) * 0.5;
          }
        }
        for (const bl of lv.balls ?? []) {
          if (bl.at > lt + 1 || lt > bl.end) continue;
          const [bx] = ballPos(bl, lt);
          if (Math.abs(bl.z - b.z) < 1.2 && (b.x - bx) * bl.dx > 0 && Math.abs(b.x - bx) < 1.6 && b.grounded) ballJump = 1;
        }
        tz = Math.max(cz - HOVER.halfL + 1.5, Math.min(cz + HOVER.halfL - 1.5, tz));
      }
      // 팀 공 넣기: 가까운 공 뒤로 돌아가서, 맞은편 팀 골대 쪽으로 밀고 찬다
      let kick = 0;
      if (room.levelId === 'teamball' && props.length) {
        const team = room.players.find((p) => p.id === b.id)?.team ?? 0;
        const [gx, gz] = GOAL_DIRS[(team + 2) % 4];
        const goal = [gx * (TEAMBALL.half + 2), gz * (TEAMBALL.half + 2)];
        const [bx, bz] = props.reduce((a, c) => (Math.hypot(c[0] - b.x, c[1] - b.z) < Math.hypot(a[0] - b.x, a[1] - b.z) ? c : a));
        let dx = goal[0] - bx, dz = goal[1] - bz; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
        const ax = bx - dx * (TEAMBALL.ballR + 1.2), az = bz - dz * (TEAMBALL.ballR + 1.2);
        if (Math.hypot(ax - b.x, az - b.z) > 1.3 && i % 3 !== 0) { tx = ax; tz = az; } else { tx = bx + dx * 3; tz = bz + dz * 3; if (Math.hypot(bx - b.x, bz - b.z) < TEAMBALL.ballR + 1.3 && (i + Math.floor(lt * 2)) % 4 === 0) kick = 2; }
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
      if (ballJump) jmp = 1;
      const dx = tx - b.x, dz = tz - b.z, dl = Math.hypot(dx, dz);
      const sp = dl > 0.3 ? 1 : 0;
      const act = kick || ((room.levelId === 'sumo' || room.levelId === 'tail') && Math.sin(lt * 3 + i) > 0.7 ? 2 : 0);
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
if (room!.levelQuiz) console.log('출제 단원:', [...new Set(room!.levelQuiz.map((q) => q.unit))].join(','), '· 예:', room!.levelQuiz[0].text.slice(0, 40));
console.log('팀 점수:', JSON.stringify(lastTeams));
console.log('게임 상태 메시지 수:', gameMsgs, '· 정답 공개:', revealed, '· 해설 포함:', explained, '· 오답 문 알림:', wrongTold, '· 한 번에 맞힌 문 합계:', bots.reduce((n, b) => n + b.firstTries, 0), '· 정답 없이 받은 문제 수:', room!.levelQuiz?.length ?? 0, '· 정답 노출:', JSON.stringify(room!.levelQuiz ?? []).includes('answer'));
if (room!.lastResult) { const ts = room!.lastResult.map((r) => parseFloat(r.detail)).filter((v) => !isNaN(v)).sort((a, c) => a - c); console.log('탈락 시각 분포(초):', [0, 0.25, 0.5, 0.75, 1].map((q) => ts[Math.min(ts.length - 1, Math.floor(q * ts.length))]).join(' / ')); }
if (room!.lastResult) console.log('결과 상위 5:', room!.lastResult.slice(0, 5).map((r) => `${r.rank}위 ${r.name} +${r.points} (${r.detail})`).join(' | '), '· 하위:', room!.lastResult.slice(-2).map((r) => `${r.rank}위 +${r.points} (${r.detail})`).join(' | '));

const ph = Object.fromEntries(Object.entries(m1.phaseMs ?? {}).map(([k, v]) => [k, +(((v as number) - (m0.phaseMs?.[k] ?? 0)) / ((m1.ticks - m0.ticks) || 1)).toFixed(3)]));
console.log('틱당 단계별 ms:', JSON.stringify(ph));
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
