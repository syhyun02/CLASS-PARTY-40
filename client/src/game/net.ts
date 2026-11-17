import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { io, type Socket } from 'socket.io-client';
import {
  BODY_DIST, DT, FLAG_GRAB, FLAG_HELD, FLAG_HIDDEN, NO_INPUT, SNAPSHOT_EVERY, SimWorld, TICK_RATE, bodyPush, buildLevel, decodeSelf, decodeSnapshot, fromB64, newPlayerState, unpackState,
  type CollectState, type CreateRes, type HostCmd, type JoinRes, type LevelDef, type PlayerInput, type PlayerState, type RoomConfig,
  type GameStateMsg, type PersonalMsg, type RoomState, type SelfMsg, type SnapPlayer,
} from '@shared';
import { actionHeld, grabHeld, input, jumpHeld, resetCamera, worldMove } from './input';
import { play } from './sound';
import { useStore } from './store';

/** 다른 플레이어를 그릴 때 쓰는 값 */
export interface RenderPlayer {
  id: number; x: number; y: number; z: number; yaw: number; flags: number; isMe: boolean;
}

interface Snap { tick: number; players: Map<number, SnapPlayer> }
interface Pending { seq: number; input: PlayerInput; canMove: boolean; slow: boolean }

// 다른 캐릭터는 조금 과거를 그린다. 그 '조금'을 네트워크 흔들림에 맞춰 자동으로 늘리고 줄인다.
const MIN_DELAY = SNAPSHOT_EVERY + 2; // 틱(약 83ms): 흔들림이 없을 때
const MAX_DELAY = Math.round(0.35 * TICK_RATE); // 틱(350ms): 이보다 오래 끊기면 예측 이동으로 버틴다
const MAX_EXTRAPOLATE = Math.round(0.25 * TICK_RATE); // 새 소식이 없을 때 가던 방향으로 계속 그려 주는 최대 시간
const INPUT_BATCH = 2; // 입력 2개를 한 번에 보낸다(초당 30번). 패킷 수를 절반으로 줄인다
const MAX_PENDING = Math.round(1.5 * TICK_RATE);

// 물리 엔진(약 2MB)은 입장할 때 내려받는다. 첫 화면이 빨리 뜨도록 미리 묶지 않는다.
let RAPIER: typeof RAPIER_NS;
let rapierReady: Promise<void> | null = null;
const initRapier = () => (rapierReady ??= import('@dimforge/rapier3d-compat').then(async (m) => { RAPIER = m.default; await RAPIER.init(); }));

/**
 * 네트워크와 예측을 담당한다(React 바깥).
 * - 내 캐릭터: 입력을 즉시 로컬 물리로 적용(예측)하고, 서버 상태가 오면 어긋난 만큼 되감아 다시 계산(보정)
 * - 다른 캐릭터: 서버 스냅샷 두 개 사이를 보간해서 100ms쯤 과거를 부드럽게 그린다
 */
class GameNet {
  socket: Socket | null = null;
  role: 'player' | 'host' | null = null;
  level: LevelDef | null = null;
  levelKey = '';
  levelTick = 0;
  rtt = 0;

  private sim: SimWorld | null = null;
  private snaps: Snap[] = [];
  private tickOffset = -Infinity; // 서버 틱 - 내 시계(틱 단위)
  private offsetSamples: number[] = [];
  private jitter = 0; // 스냅샷 도착 시각의 흔들림(틱)
  private delay = MIN_DELAY; // 지금 쓰는 보간 지연(틱)
  private smooth = new Map<number, { x: number; y: number; z: number; yaw: number }>();
  private lastRender = 0;
  private outbox: number[] = [];
  serverLate = 0;
  serverTickMs = 0;

  // 예측 상태
  private me: PlayerState | null = null;
  private prev = { x: 0, y: 0, z: 0 };
  private pending: Pending[] = [];
  private history = new Map<number, [number, number, number]>(); // seq → 예측 위치
  private seq = 0;
  private predTick = 0; // 맵 기준 틱
  private acc = 0;
  private lastFrame = 0;
  private err = { x: 0, y: 0, z: 0 }; // 보정 때 화면이 튀지 않게 남겨 두는 오차
  private synced = false;
  private obstacleTick = 0;
  private actionWas = false;
  private grabWas = false;
  stats = { corrections: 0, lastError: 0, pending: 0, errorSum: 0 };
  /** 시험용: 겹침 예측을 끄고 비교해 볼 때 쓴다 */
  debugNoSeparation = false;

  private out: RenderPlayer[] = [];
  private outDirty = true;

  connect(): Socket {
    if (this.socket) return this.socket;
    const s = io({ transports: ['websocket', 'polling'] });
    this.socket = s;
    s.on('connect', () => { useStore.setState({ online: true }); this.rejoin(); });
    s.on('disconnect', () => useStore.setState({ online: false }));
    s.on('room', (r: RoomState) => this.onRoom(r));
    // 위치 스냅샷과 내 상태가 한 메시지로 온다(base64 문자열 두 개)
    s.on('u', (snap: string, self?: string) => { this.onSnapshot(fromB64(snap)); if (self) this.onSelf(decodeSelf(fromB64(self))); });
    s.on('g', (m: GameStateMsg) => { if (m.key === this.levelKey) { this.applyGameState(m.state); useStore.setState({ game: m.state }); } });
    s.on('gp', (m: PersonalMsg) => {
      if (m.key !== this.levelKey) return;
      const cur = useStore.getState().mine;
      if (m.pass) useStore.setState({ mine: { passed: m.pass.q + 1, wrong: cur.wrong, explain: { q: m.pass.q, text: m.pass.explain, first: m.pass.first } } });
      else if (m.wrong) useStore.setState({ mine: { ...cur, wrong: [...cur.wrong, m.wrong] } });
    });
    s.on('notice', (text: string) => { useStore.setState({ notice: text }); setTimeout(() => useStore.setState({ notice: null }), 6000); });
    s.on('closed', () => this.exit(this.role === 'host' ? '방을 닫았어요.' : '선생님이 방을 닫았어요.'));
    s.on('kicked', () => this.exit('선생님이 내보냈어요.'));
    s.on('replaced', () => this.exit('다른 기기에서 같은 이름으로 접속했어요.'));
    setInterval(() => {
      if (!s.connected) return;
      const t0 = performance.now();
      s.emit('pg', t0, (_t: number, _tick: number, late?: number, tickMs?: number) => {
        const r = performance.now() - t0;
        this.rtt = this.rtt ? this.rtt * 0.7 + r * 0.3 : r;
        this.serverLate = late ?? 0;
        this.serverTickMs = tickMs ?? 0;
      });
    }, 1000);
    return s;
  }

  private exit(notice: string) {
    sessionStorage.removeItem('cp40:session');
    this.role = null;
    useStore.setState({ screen: 'home', room: null, myId: null, notice });
  }

  /** 연결이 끊겼다 돌아오면 저장해 둔 토큰으로 같은 자리에 다시 들어간다. */
  private rejoin() {
    const raw = sessionStorage.getItem('cp40:session');
    if (!raw || !this.role) return;
    const sess = JSON.parse(raw);
    if (this.role === 'host') this.socket!.emit('host:resume', sess, () => {});
    else this.socket!.emit('join', sess, (res: JoinRes) => { if (!res.ok) this.exit(res.error); });
  }

  async createRoom(config: RoomConfig): Promise<string | null> {
    await initRapier();
    const s = this.connect();
    const res = await new Promise<CreateRes>((ok) => s.emit('host:create', { config }, ok));
    if (!res.ok) return res.error ?? '방을 만들지 못했어요.';
    this.role = 'host';
    sessionStorage.setItem('cp40:session', JSON.stringify({ role: 'host', code: res.code, hostToken: res.hostToken }));
    this.sendSavedBank();
    useStore.setState({ screen: 'host', myId: null });
    return null;
  }

  async join(code: string, name: string, color: string, token?: string): Promise<string | null> {
    await initRapier();
    const s = this.connect();
    const res = await new Promise<JoinRes>((ok) => s.emit('join', { code, name, color, token }, ok));
    if (!res.ok) return res.error;
    this.role = 'player';
    sessionStorage.setItem('cp40:session', JSON.stringify({ role: 'player', code, name: res.name, color, token: res.token }));
    useStore.setState({ screen: 'play', myId: res.id, myName: res.name });
    this.resetMe(); // 방 상태가 입장 응답보다 먼저 도착하므로, 내 번호를 안 뒤에 캐릭터를 만든다
    return null;
  }

  /** 새로고침했을 때 이전 세션 복구 */
  async restore(): Promise<boolean> {
    const raw = sessionStorage.getItem('cp40:session');
    if (!raw) return false;
    const sess = JSON.parse(raw);
    await initRapier();
    const s = this.connect();
    if (sess.role === 'host') {
      const res = await new Promise<CreateRes>((ok) => s.emit('host:resume', sess, ok));
      if (!res.ok) { sessionStorage.removeItem('cp40:session'); return false; }
      this.role = 'host';
      this.sendSavedBank();
      useStore.setState({ screen: 'host' });
      return true;
    }
    const err = await this.join(sess.code, sess.name, sess.color, sess.token);
    if (err) sessionStorage.removeItem('cp40:session');
    return !err;
  }

  hostCmd(cmd: HostCmd) { this.socket?.emit('host:cmd', cmd); }
  /** 교사 브라우저에 저장해 둔 문제은행이 있으면 방에 적용한다(서버를 다시 켜도 문제가 유지된다). */
  private sendSavedBank() {
    try {
      const raw = localStorage.getItem('cp40:bank');
      if (raw) this.hostCmd({ type: 'bank', bank: JSON.parse(raw) });
    } catch { /* 저장된 값이 깨졌으면 기본 문제를 쓴다 */ }
  }
  setColor(c: string) {
    this.socket?.emit('color', c);
    const raw = sessionStorage.getItem('cp40:session');
    if (raw) sessionStorage.setItem('cp40:session', JSON.stringify({ ...JSON.parse(raw), color: c }));
  }

  // ---------- 수신 ----------

  private onRoom(r: RoomState) {
    if (r.levelKey !== this.levelKey) this.loadLevel(r);
    this.levelTick = r.levelTick;
    useStore.setState({ room: r });
  }

  /**
   * 화학 모드에서는 정답을 서버만 알고 있다가 채점하는 순간에 알려 준다.
   * 그때 맵 데이터에 정답을 써넣어, 오답 발판이 사라지거나 정답 문이 열리게 한다(예측 물리도 같은 데이터를 본다).
   */
  private applyGameState(st: CollectState | null) {
    const lv = this.level;
    if (!st || !lv?.quiz) return;
    if (st.quiz && st.quiz.answer !== undefined) {
      const q = lv.quiz[st.quiz.index];
      if (q && q.answer < 0) {
        q.answer = st.quiz.answer;
        q.explain = st.quiz.explain;
        lv.tiles?.forEach((t, i) => { if (i < 4 && i !== q.answer) (t.gaps ??= []).push([q.revealAt, q.endAt]); });
      }
    }
  }

  private loadLevel(r: RoomState) {
    this.sim?.free();
    this.level = buildLevel(r.levelId, r.levelSeed, r.levelQuiz);
    this.sim = new SimWorld(RAPIER, this.level);
    this.levelKey = r.levelKey;
    this.levelTick = r.levelTick;
    useStore.setState({ game: null, mine: { passed: 0, wrong: [], explain: null } });
    this.snaps = [];
    this.smooth.clear();
    this.outbox = [];
    this.pending = [];
    this.history.clear();
    this.synced = false;
    this.err.x = this.err.y = this.err.z = 0;
    resetCamera();
    this.resetMe();
  }

  private resetMe() {
    const id = useStore.getState().myId;
    this.me = id !== null && this.level ? newPlayerState(this.level, id) : null;
    this.pending = [];
    this.history.clear();
    this.synced = false;
    if (this.me) {
      this.prev.x = this.me.x; this.prev.y = this.me.y; this.prev.z = this.me.z;
      if (this.level?.spawnRing) input.camYaw = this.me.yaw; // 카메라도 경기장 가운데를 향하게
    }
  }

  private onSnapshot(buf: ArrayBuffer) {
    this.outDirty = true;
    const { tick, players } = decodeSnapshot(buf);
    const map = new Map<number, SnapPlayer>();
    for (const p of players) map.set(p.id, p);
    this.snaps.push({ tick, players: map });
    if (this.snaps.length > 30) this.snaps.shift();
    // 시계 동기화: 가장 빨리 도착한 패킷(지연이 가장 작은 것)을 기준으로 삼는다
    const sample = tick - (performance.now() / 1000) * TICK_RATE;
    this.offsetSamples.push(sample);
    if (this.offsetSamples.length > 60) this.offsetSamples.shift();
    const best = Math.max(...this.offsetSamples);
    // 이 패킷이 가장 빨랐던 패킷보다 얼마나 늦게 왔나(틱) → 최근 최댓값을 천천히 잊으며 기억한다
    const late = Math.max(0, best - sample);
    this.jitter = Math.max(this.jitter * 0.985, late);
    const want = Math.max(MIN_DELAY, Math.min(MAX_DELAY, SNAPSHOT_EVERY + 1.5 + this.jitter * 1.15));
    // 늘릴 때는 바로, 줄일 때는 천천히(자주 바꾸면 그 자체가 끊김으로 보인다)
    this.delay += (want - this.delay) * (want > this.delay ? 0.35 : 0.01);
    this.tickOffset = this.tickOffset === -Infinity || Math.abs(best - this.tickOffset) > TICK_RATE / 2 ? best : this.tickOffset + (best - this.tickOffset) * 0.1;
  }

  private onSelf(m: SelfMsg) {
    const me = this.me, sim = this.sim;
    if (!me || !sim) return;
    // 처리된 입력은 버린다
    while (this.pending.length && this.pending[0].seq <= m.q) this.pending.shift();
    const rel = m.t - this.levelTick;
    const predicted = this.history.get(m.q);
    const sx = m.s[0], sy = m.s[1], sz = m.s[2];
    const error = predicted && this.synced ? Math.hypot(predicted[0] - sx, predicted[1] - sy, predicted[2] - sz) : Infinity;
    for (const k of this.history.keys()) { if (k <= m.q) this.history.delete(k); else break; }
    this.stats.lastError = error === Infinity ? 0 : error;
    this.stats.pending = this.pending.length;

    if (error > 0.03) {
      // 예측이 서버와 달랐다 → 서버 상태에서 다시 시작해 아직 처리 안 된 입력을 재생한다
      const bx = me.x, by = me.y, bz = me.z, stunBefore = me.stun, shoveBefore = me.shove;
      unpackState(m.s, me);
      if (this.synced && me.shove > shoveBefore + 5) play('push');
      if (this.synced && me.stun > stunBefore + 5) play('bonk'); // 서버에서만 판정하는 밀치기·오답 문에 맞았다
      let t = rel;
      for (const p of this.pending) {
        sim.setTick(++t);
        sim.stepPlayer(me, p.input, useStore.getState().myId!, p.canMove, p.slow);
        this.separateLocal(me, t);
        this.history.set(p.seq, [me.x, me.y, me.z]);
      }
      const dx = bx - me.x, dy = by - me.y, dz = bz - me.z;
      const jump = Math.hypot(dx, dy, dz);
      if (this.synced && jump < 4) {
        // 작은 차이는 화면에서 서서히 줄인다
        this.err.x += dx; this.err.y += dy; this.err.z += dz;
        this.prev.x -= dx; this.prev.y -= dy; this.prev.z -= dz;
      } else {
        // 부활·순간이동 같은 큰 차이는 바로 맞춘다
        this.err.x = this.err.y = this.err.z = 0;
        this.prev.x = me.x; this.prev.y = me.y; this.prev.z = me.z;
      }
      if (this.synced) { this.stats.corrections++; if (jump < 4) this.stats.errorSum += jump; }
      this.synced = true;
    }
    this.predTick = rel + this.pending.length;
  }

  // ---------- 매 프레임 ----------

  /** 지금 서버 틱의 추정값(소수) */
  serverTick(): number {
    if (this.tickOffset === -Infinity) return 0;
    return (performance.now() / 1000) * TICK_RATE + this.tickOffset;
  }

  private canMoveNow(): boolean {
    const { room, myId } = useStore.getState();
    if (!room || myId === null || room.paused) return false;
    const mine = room.players.find((p) => p.id === myId);
    if (!mine) return false;
    if (room.phase === 'lobby' || room.phase === 'draw' || room.phase === 'final') return true;
    return room.phase === 'playing' && mine.active && !mine.out;
  }

  /** 렌더 프레임마다 호출: 고정 30Hz로 입력을 보내고 내 캐릭터를 예측 이동한다. */
  update(now: number) {
    this.outDirty = true;
    const dt = Math.min(0.25, this.lastFrame ? (now - this.lastFrame) / 1000 : 0);
    this.lastFrame = now;
    const k = Math.min(1, dt * 12);
    this.err.x -= this.err.x * k; this.err.y -= this.err.y * k; this.err.z -= this.err.z * k;

    const st = useStore.getState();
    const mine = st.room?.players.find((p) => p.id === st.myId);
    const playing = this.role === 'player' && this.me && this.sim && this.socket?.connected && mine?.active && !mine.out && !st.room?.paused;
    if (playing) {
      this.acc += dt;
      while (this.acc >= DT) {
        this.acc -= DT;
        if (this.pending.length >= MAX_PENDING) break; // 서버 응답이 없으면 더 앞서 나가지 않는다
        this.fixedStep();
      }
    } else {
      this.acc = 0;
    }
    // 장애물은 예측 시간에 맞춰 그리되, 틱이 흔들려도 떨리지 않게 부드럽게 따라간다
    const target = playing ? this.predTick + this.acc / DT : this.serverTick() - this.levelTick;
    this.obstacleTick += dt * TICK_RATE;
    const d = target - this.obstacleTick;
    if (Math.abs(d) > TICK_RATE / 5) this.obstacleTick = target; else this.obstacleTick += d * Math.min(1, dt * 4);
  }

  private fixedStep() {
    const me = this.me!, sim = this.sim!;
    const mv = worldMove();
    const mxq = Math.round(mv.mx * 127), mzq = Math.round(mv.mz * 127);
    const jump = jumpHeld(), action = actionHeld(), grab = grabHeld();
    // 서버가 받는 값과 정확히 같도록 양자화한 값으로 예측한다
    const inp: PlayerInput = { mx: mxq / 127, mz: mzq / 127, jump, action };
    const canMove = this.canMoveNow();
    const seq = ++this.seq;
    this.outbox.push(seq, mxq, mzq, (jump ? 1 : 0) | (action ? 2 : 0) | (grab ? 4 : 0));
    if (this.outbox.length >= INPUT_BATCH * 4) { this.socket!.emit('in', this.outbox); this.outbox = []; }
    this.prev.x = me.x; this.prev.y = me.y; this.prev.z = me.z;
    const vy0 = me.vy, stun0 = me.stun;
    sim.setTick(++this.predTick);
    // 잡거나 잡혀 있으면 서버와 똑같이 느리게 예측한다(가장 최근 스냅샷의 내 상태로 판단)
    const myId = useStore.getState().myId!;
    const mineFlags = this.snaps[this.snaps.length - 1]?.players.get(myId)?.flags ?? 0;
    const slow = (mineFlags & (FLAG_GRAB | FLAG_HELD)) !== 0;
    sim.stepPlayer(me, inp, myId, canMove, slow);
    this.separateLocal(me, this.predTick);
    if (me.vy > 8 && vy0 <= 0.5) play(me.vy > 12 ? 'reveal' : 'jump', 0.8); // 점프 / 점프 발판
    if (me.stun > stun0 + 5) play('bonk');
    if (action && !this.actionWas && canMove) play('push', 0.8);
    this.actionWas = action;
    if (grab && !this.grabWas && canMove) play('push', 0.5);
    this.grabWas = grab;
    this.pending.push({ seq, input: inp, canMove, slow });
    this.history.set(seq, [me.x, me.y, me.z]);
  }

  /**
   * 다른 캐릭터와 겹치면 서버와 같은 식으로 미리 밀려난다.
   * 서버만 판정하면 내 화면에서는 일단 겹쳤다가 뒤늦게 튕겨 나와 끊겨 보이기 때문이다.
   * 상대 위치는 가장 최근 스냅샷 값을 쓴다(조금 과거지만 밀리는 방향과 세기는 거의 같다).
   */
  private separateLocal(me: PlayerState, simTick: number) {
    const latest = this.snaps[this.snaps.length - 1];
    const prev = this.snaps[this.snaps.length - 2];
    const sim = this.sim;
    if (!latest || !sim || this.debugNoSeparation) return;
    // 이 걸음이 서버에서 처리될 무렵의 상대 위치를 어림한다: 최근 두 스냅샷의 속도로 조금 앞을 내다본다
    const ahead = Math.max(0, Math.min(TICK_RATE / 4, simTick - (latest.tick - this.levelTick)));
    const span = prev ? latest.tick - prev.tick : 0;
    const myId = useStore.getState().myId;
    for (const o of latest.players.values()) {
      if (o.id === myId || o.flags & FLAG_HIDDEN) continue;
      let ox = o.x, oz = o.z;
      const po = span > 0 ? prev!.players.get(o.id) : undefined;
      if (po && Math.abs(o.x - po.x) + Math.abs(o.z - po.z) < 3) { ox += ((o.x - po.x) / span) * ahead; oz += ((o.z - po.z) / span) * ahead; }
      const dx = me.x - ox, dz = me.z - oz;
      if (dx > BODY_DIST || dx < -BODY_DIST || dz > BODY_DIST || dz < -BODY_DIST || Math.abs(me.y - o.y) > 1) continue;
      const d = Math.hypot(dx, dz);
      if (d >= BODY_DIST || d < 1e-4) continue;
      const push = bodyPush(d);
      sim.nudge(me, (dx / d) * push, (dz / d) * push);
    }
  }

  /** 화면의 진단 표시에 쓰는 값: 왕복 지연, 흔들림, 지금 쓰는 보간 지연(ms), 서버가 최근 5초 동안 늦은 틱 수 */
  netStats() {
    const ms = 1000 / TICK_RATE;
    return { rtt: Math.round(this.rtt), jitter: Math.round(this.jitter * ms), delay: Math.round(this.delay * ms), serverLate: this.serverLate, serverTickMs: +this.serverTickMs.toFixed(2) };
  }

  /** 맵의 움직이는 장애물을 그릴 시간(초) */
  levelTime(): number { return Math.max(0, this.obstacleTick) * DT; }

  myState(): PlayerState | null { return this.me; }

  /** 그릴 플레이어 목록. 호출할 때마다 같은 배열을 재사용한다. */
  renderPlayers(): RenderPlayer[] {
    // 한 프레임에 여러 곳(카메라, 캐릭터, HUD)에서 부르므로 처음 한 번만 계산한다
    if (!this.outDirty) return this.out;
    this.outDirty = false;
    const out = this.out;
    let n = 0;
    const myId = useStore.getState().myId;
    const now = performance.now();
    const fdt = Math.min(0.1, this.lastRender ? (now - this.lastRender) / 1000 : 0.016);
    this.lastRender = now;
    const rt = this.serverTick() - this.delay;
    const snaps = this.snaps;
    let a: Snap | undefined, b: Snap | undefined;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].tick <= rt) { a = snaps[i]; b = snaps[i + 1]; break; }
    }
    if (!a) { a = snaps[0]; b = snaps[1]; }
    if (a) {
      // b가 없으면 가장 최근 소식보다 앞을 그려야 하는 상황(패킷이 늦는 중): 직전 속도로 조금 더 가게 한다
      const prev = b ? undefined : snaps[snaps.length - 2];
      const over = b ? 0 : Math.min(MAX_EXTRAPOLATE, Math.max(0, rt - a.tick));
      const t = b ? Math.max(0, Math.min(1, (rt - a.tick) / (b.tick - a.tick))) : 0;
      const latest = snaps[snaps.length - 1];
      const k = Math.min(1, fdt * 22); // 화면 위치를 목표로 부드럽게 끌고 간다(늦게 온 소식으로 튀는 것을 줄인다)
      for (const pa of a.players.values()) {
        const useLocal = pa.id === myId && this.me && this.synced && !((latest.players.get(pa.id)?.flags ?? FLAG_HIDDEN) & FLAG_HIDDEN);
        if (useLocal) continue;
        const pb = b?.players.get(pa.id);
        let x = pa.x, y = pa.y, z = pa.z, yaw = pa.yaw;
        if (pb && Math.abs(pb.x - pa.x) + Math.abs(pb.y - pa.y) + Math.abs(pb.z - pa.z) < 12) {
          x = pa.x + (pb.x - pa.x) * t; y = pa.y + (pb.y - pa.y) * t; z = pa.z + (pb.z - pa.z) * t;
          let dy = pb.yaw - pa.yaw;
          if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
          yaw = pa.yaw + dy * t;
        } else if (pb) {
          x = pb.x; y = pb.y; z = pb.z; yaw = pb.yaw; // 순간이동(부활)은 보간하지 않는다
        } else if (over > 0 && prev) {
          const pp = prev.players.get(pa.id), span = a.tick - prev.tick;
          if (pp && span > 0 && Math.abs(pa.x - pp.x) + Math.abs(pa.z - pp.z) < 4) {
            // 멀리 내다볼수록 덜 믿는다(점점 느려지며 멈춘다)
            const f = (over / span) * (1 - (over / MAX_EXTRAPOLATE) * 0.5);
            x += (pa.x - pp.x) * f; z += (pa.z - pp.z) * f;
          }
        }
        const o = (out[n] ??= { id: 0, x: 0, y: 0, z: 0, yaw: 0, flags: 0, isMe: false });
        n++;
        o.id = pa.id; o.isMe = pa.id === myId; o.flags = pb ? pb.flags : pa.flags;
        let sm = this.smooth.get(pa.id);
        if (!sm || Math.abs(x - sm.x) + Math.abs(y - sm.y) + Math.abs(z - sm.z) > 5) { sm = { x, y, z, yaw }; this.smooth.set(pa.id, sm); }
        else { sm.x += (x - sm.x) * k; sm.y += (y - sm.y) * k; sm.z += (z - sm.z) * k; }
        o.x = sm.x; o.y = sm.y; o.z = sm.z; o.yaw = yaw;
      }
    }
    // 내 캐릭터는 예측값으로 그린다
    const me = this.me;
    if (me && myId !== null && this.synced && this.role === 'player') {
      const latest = snaps[snaps.length - 1]?.players.get(myId);
      if (latest && !(latest.flags & FLAG_HIDDEN)) {
        const al = Math.min(1, this.acc / DT);
        const o = (out[n] ??= { id: 0, x: 0, y: 0, z: 0, yaw: 0, flags: 0, isMe: false });
        n++;
        o.id = myId; o.isMe = true;
        o.x = this.prev.x + (me.x - this.prev.x) * al + this.err.x;
        o.y = this.prev.y + (me.y - this.prev.y) * al + this.err.y;
        o.z = this.prev.z + (me.z - this.prev.z) * al + this.err.z;
        o.yaw = me.yaw;
        o.flags = (latest.flags & ~3) | (me.grounded ? 1 : 0) | (me.stun > 0 ? 2 : 0);
      }
    }
    out.length = n;
    return out;
  }
}

export const net = new GameNet();
export { NO_INPUT };
if (typeof window !== 'undefined') (window as any).__cp40 = net;
