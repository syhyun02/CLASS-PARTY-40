import type RAPIER_NS from '@dimforge/rapier3d-compat';
import {
  AIR_ACCEL, COYOTE_TICKS, DT, GRAVITY, GROUND_ACCEL, JUMP_BUFFER_TICKS, JUMP_VELOCITY,
  MOVE_SPEED, PLAYER_CENTER_Y, PLAYER_HALF_HEIGHT, PLAYER_RADIUS, STUN_TICKS, TICK_RATE,
} from './constants';
import { ballPos, inBox, moverOffset, spawnPoint, sweeperAngle, sweeperSpeed, tileOn, type LevelDef } from './level';

type Rapier = typeof RAPIER_NS;

/** 플레이어 한 명의 물리 상태. y는 발바닥 높이. 전부 숫자라서 그대로 전송·복사한다. */
export interface PlayerState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number;
  grounded: number; // 0/1
  stun: number; // 남은 넘어짐 틱
  coyote: number;
  jumpBuf: number;
  jumpHeld: number; // 직전 틱의 점프 버튼
  mover: number; // 올라탄 발판 인덱스(-1 없음)
  cp: number; // 마지막 체크포인트
  falls: number;
  bomb: number; // 다음에 처리할 폭탄 번호(같은 폭탄에 두 번 맞거나 건너뛰지 않게)
  shove: number; // 밀쳐져서 비틀거리는 남은 틱(넘어지지는 않지만 잠깐 조작이 안 된다)
  ride: number; // 마지막으로 올라탄 탈것(호버보드). 점프 중에도 함께 움직인다. -1 없음
}

export interface PlayerInput {
  mx: number; // 월드 기준 이동 방향(-1~1)
  mz: number;
  jump: boolean;
  action: boolean;
  /** 잡기 버튼(누르고 있는 동안). 물리 예측에는 쓰지 않고 서버가 판정한다. */
  grab?: boolean;
}

export const NO_INPUT: PlayerInput = { mx: 0, mz: 0, jump: false, action: false };

export const STATE_KEYS: (keyof PlayerState)[] = [
  'x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'grounded', 'stun', 'coyote', 'jumpBuf', 'jumpHeld', 'mover', 'cp', 'falls', 'bomb', 'shove', 'ride',
];
export const packState = (s: PlayerState): number[] => STATE_KEYS.map((k) => s[k]);
export function unpackState(a: number[], out: PlayerState): PlayerState {
  for (let i = 0; i < STATE_KEYS.length; i++) out[STATE_KEYS[i]] = a[i];
  return out;
}

export function newPlayerState(level: LevelDef, slot: number, cp = 0): PlayerState {
  const [x, y, z] = spawnPoint(level, cp, slot);
  const yaw = level.spawnRing ? Math.atan2(-x, -z) : 0; // 원형 출발이면 가운데를 바라본다
  return { x, y, z, vx: 0, vy: 0, vz: 0, yaw, grounded: 1, stun: 0, coyote: 0, jumpBuf: 0, jumpHeld: 0, mover: -1, cp, falls: 0, bomb: 0, shove: 0, ride: -1 };
}

const GRAB_SLOW = 0.55;
const REHIT_TICKS = Math.round(0.2 * TICK_RATE); // 회전봉에 맞은 직후 다시 맞지 않는 시간
/** 캐릭터끼리 이 거리보다 가까워지면 서로 밀어낸다(몸통이 살짝 겹치기 시작하는 거리) */
export const BODY_DIST = PLAYER_RADIUS * 2 + 0.08;
/**
 * 겹친 정도에 따라 한 틱에 밀려나는 거리. 겹친 만큼의 일부만 밀어내서 툭 튕기지 않고 스르륵 밀린다.
 * 상한은 달리는 속도보다 커서 마주 달려도 서로 통과하지 않는다. 서버와 클라이언트 예측이 같은 식을 쓴다.
 */
export const bodyPush = (d: number) => Math.min(7.2 / TICK_RATE, (BODY_DIST - d) * 0.3);

const G_LEVEL = 0x0001;
const G_PLAYER = 0x0002;
const LEVEL_GROUPS = (G_LEVEL << 16) | G_PLAYER; // 맵: 플레이어와만 충돌
const PLAYER_GROUPS = (G_PLAYER << 16) | G_LEVEL; // 플레이어: 맵과만 충돌(플레이어끼리는 서버가 따로 밀어낸다)

/**
 * 맵 하나의 물리 세계. 서버는 40명 전원을, 클라이언트는 자기 캐릭터만 여기서 돌린다.
 * 같은 Rapier WASM + 같은 입력이면 같은 결과가 나오므로 클라이언트 예측이 서버와 맞는다.
 */
export class SimWorld {
  readonly world: RAPIER_NS.World;
  private kcc: RAPIER_NS.KinematicCharacterController;
  private probe: RAPIER_NS.Collider; // 모든 플레이어가 공유하는 캡슐(위치만 바꿔 가며 쓴다)
  private moverCols: RAPIER_NS.Collider[] = [];
  private moverHandles = new Map<number, number>();
  /** 현재 틱과 직전 틱의 발판 위치 차이 */
  private moverDelta: [number, number, number][] = [];
  private moverPos: [number, number, number][] = [];
  private tileCols: RAPIER_NS.Collider[] = [];
  private tileOn: boolean[] = [];
  private ray: RAPIER_NS.Ray;
  private time = 0;
  private stepped = false;
  private tick = -1;

  constructor(R: Rapier, readonly level: LevelDef) {
    this.world = new R.World({ x: 0, y: 0, z: 0 });
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    this.world.timestep = DT;
    for (const b of level.statics) {
      this.world.createCollider(
        R.ColliderDesc.cuboid(b.h[0], b.h[1], b.h[2]).setTranslation(b.p[0], b.p[1], b.p[2]).setCollisionGroups(LEVEL_GROUPS),
      );
    }
    level.movers.forEach((m, i) => {
      const c = this.world.createCollider(
        R.ColliderDesc.cuboid(m.h[0], m.h[1], m.h[2]).setTranslation(m.p[0], m.p[1], m.p[2]).setCollisionGroups(LEVEL_GROUPS),
      );
      this.moverCols.push(c);
      this.moverHandles.set(c.handle, i);
      this.moverDelta.push([0, 0, 0]);
      this.moverPos.push([m.p[0], m.p[1], m.p[2]]);
    });
    for (const t of level.tiles ?? []) {
      const desc = t.shape === 'disc' ? R.ColliderDesc.cylinder(t.h[1], t.h[0]) : R.ColliderDesc.cuboid(t.h[0], t.h[1], t.h[2]);
      this.tileCols.push(this.world.createCollider(desc.setTranslation(t.p[0], t.p[1], t.p[2]).setCollisionGroups(LEVEL_GROUPS)));
      this.tileOn.push(true);
    }
    this.probe = this.world.createCollider(
      R.ColliderDesc.capsule(PLAYER_HALF_HEIGHT, PLAYER_RADIUS).setTranslation(0, -1000, 0).setCollisionGroups(PLAYER_GROUPS),
    );
    this.kcc = this.world.createCharacterController(0.02);
    this.kcc.enableAutostep(0.32, 0.2, false);
    this.kcc.enableSnapToGround(0.25);
    this.kcc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.kcc.setSlideEnabled(true);
    this.setTick(0);
  }

  /** 움직이는 발판·벽을 해당 틱 위치로 옮긴다. 플레이어를 움직이기 전에 틱마다 한 번 호출. */
  setTick(tick: number) {
    if (tick === this.tick) return;
    this.tick = tick;
    this.time = tick * DT;
    const movers = this.level.movers;
    let changed = false;
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i];
      const a = moverOffset(m, this.time);
      const b = moverOffset(m, this.time - DT);
      this.moverDelta[i][0] = a[0] - b[0];
      this.moverDelta[i][1] = a[1] - b[1];
      this.moverDelta[i][2] = a[2] - b[2];
      const pos = this.moverPos[i];
      const nx = m.p[0] + a[0], ny = m.p[1] + a[1], nz = m.p[2] + a[2];
      if (nx !== pos[0] || ny !== pos[1] || nz !== pos[2]) changed = true;
      pos[0] = nx; pos[1] = ny; pos[2] = nz;
      this.moverCols[i].setTranslation({ x: pos[0], y: pos[1], z: pos[2] });
    }
    // 사라지는 발판: 시각만으로 켜고 끄므로 예측을 되감아 재생해도 결과가 같다
    const tiles = this.level.tiles;
    if (tiles) {
      for (let i = 0; i < tiles.length; i++) {
        const on = tileOn(tiles[i], this.time);
        if (on !== this.tileOn[i]) { this.tileOn[i] = on; this.tileCols[i].setEnabled(on); changed = true; }
      }
    }
    // 충돌 질의 구조 갱신: 움직인 발판이나 켜지고 꺼진 발판이 있을 때만(처음 한 번은 반드시)
    if (changed || !this.stepped) { this.world.step(); this.stepped = true; }
  }

  /**
   * 플레이어 한 명을 한 틱 전진시킨다. setTick(tick) 이후에 호출할 것.
   * canMove=false면 입력을 무시한다(카운트다운, 결과 화면 등). slow=true면 이동 속도가 줄어든다(잡기).
   */
  stepPlayer(s: PlayerState, inp: PlayerInput, slot: number, canMove: boolean, slow = false) {
    const L = this.level;
    let mx = canMove ? inp.mx : 0;
    let mz = canMove ? inp.mz : 0;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    if (slow) { mx *= GRAB_SLOW; mz *= GRAB_SLOW; } // 잡거나 잡혀 있으면 느려진다
    const stunned = s.stun > 0;
    if (stunned) { s.stun--; mx = 0; mz = 0; }
    const shoved = s.shove > 0;
    if (shoved) { s.shove--; mx = 0; mz = 0; }

    // 수평 가속
    // 넘어졌거나 밀쳐졌을 때는 천천히 미끄러지며 멈춘다
    const accel = (s.grounded ? GROUND_ACCEL : AIR_ACCEL) * (stunned ? 0.25 : shoved ? 0.28 : 1) * DT;
    const tx = mx * MOVE_SPEED, tz = mz * MOVE_SPEED;
    const dvx = tx - s.vx, dvz = tz - s.vz;
    const dv = Math.hypot(dvx, dvz);
    if (dv <= accel || dv === 0) { s.vx = tx; s.vz = tz; } else { s.vx += (dvx / dv) * accel; s.vz += (dvz / dv) * accel; }
    if (!stunned && !shoved && (mx !== 0 || mz !== 0)) s.yaw = Math.atan2(mx, mz);

    // 점프: 코요테 타임 + 입력 버퍼로 모바일에서도 타이밍이 너그럽다
    const jumpDown = canMove && inp.jump;
    if (jumpDown && !s.jumpHeld) s.jumpBuf = JUMP_BUFFER_TICKS; else if (s.jumpBuf > 0) s.jumpBuf--;
    s.jumpHeld = jumpDown ? 1 : 0;
    if (s.grounded) s.coyote = COYOTE_TICKS; else if (s.coyote > 0) s.coyote--;
    if (s.jumpBuf > 0 && s.coyote > 0 && !stunned) {
      s.vy = JUMP_VELOCITY; s.jumpBuf = 0; s.coyote = 0; s.grounded = 0; s.mover = -1;
    }
    s.vy += GRAVITY * DT;
    if (s.vy < -40) s.vy = -40;

    // 올라탄 발판이 움직인 만큼 같이 실려 간다
    let dx = s.vx * DT, dy = s.vy * DT, dz = s.vz * DT;
    const carry = s.mover >= 0 ? s.mover : s.ride; // 탈것에서 점프했으면 공중에서도 함께 간다
    if (carry >= 0 && carry < this.moverDelta.length) {
      const d = this.moverDelta[carry];
      dx += d[0]; dy += s.mover >= 0 ? d[1] : 0; dz += d[2];
    }

    // 움직이는 벽이 플레이어를 밀어낸다
    for (let i = 0; i < L.movers.length; i++) {
      const m = L.movers[i];
      if (m.kind !== 'wall') continue;
      const p = this.moverPos[i];
      const cy = s.y + PLAYER_CENTER_Y;
      if (Math.abs(cy - p[1]) > m.h[1] + PLAYER_CENTER_Y - 0.05) continue;
      const ox = s.x - p[0], oz = s.z - p[2];
      const px = m.h[0] + PLAYER_RADIUS - Math.abs(ox), pz = m.h[2] + PLAYER_RADIUS - Math.abs(oz);
      if (px > 0 && pz > 0) {
        if (px < pz) dx += Math.sign(ox || 1) * px; else dz += Math.sign(oz || 1) * pz;
      }
    }

    this.probe.setTranslation({ x: s.x, y: s.y + PLAYER_CENTER_Y, z: s.z });
    this.kcc.computeColliderMovement(this.probe, { x: dx, y: dy, z: dz }, undefined, PLAYER_GROUPS);
    const mv = this.kcc.computedMovement();
    s.x += mv.x; s.y += mv.y; s.z += mv.z;
    const grounded = this.kcc.computedGrounded();
    if (dy > 0 && mv.y < dy - 1e-4 && s.vy > 0) s.vy = 0; // 천장에 부딪힘
    s.mover = -1;
    if (grounded) {
      if (s.vy < 0) s.vy = 0;
      const n = this.kcc.numComputedCollisions();
      for (let i = 0; i < n; i++) {
        const c = this.kcc.computedCollision(i);
        if (c && c.collider && c.normal1.y > 0.7) {
          const mi = this.moverHandles.get(c.collider.handle);
          if (mi !== undefined) s.mover = mi;
        }
      }
    }
    // 바닥에 서면 탈것 기억을 갱신한다(탈것이 아닌 바닥에 서면 지운다)
    if (grounded) s.ride = s.mover >= 0 && L.movers[s.mover].ride ? s.mover : -1;
    s.grounded = grounded ? 1 : 0;

    // 점프 발판
    if (grounded) {
      for (const pad of L.pads) {
        if (inBox(pad, s.x, s.y, s.z, 0.25)) { s.vy = pad.vy; s.grounded = 0; s.coyote = 0; s.mover = -1; break; }
      }
    }

    // 회전봉: 봉이 움직이는 방향으로 날려 보낸다
    if (s.stun < STUN_TICKS - REHIT_TICKS) {
      for (const sw of L.sweepers) {
        const w = sweeperSpeed(sw, this.time);
        if (w === 0) continue; // 아직 돌기 전
        if (s.y > sw.c[1] + sw.r || s.y + PLAYER_CENTER_Y * 2 < sw.c[1] - sw.r) continue;
        const a = sweeperAngle(sw, this.time);
        const ca = Math.cos(a), sa = Math.sin(a);
        const ox = s.x - sw.c[0], oz = s.z - sw.c[2];
        const along = ox * ca + oz * sa; // 봉 길이 방향
        const side = -ox * sa + oz * ca; // 봉에 수직
        if (Math.abs(along) < sw.len + PLAYER_RADIUS && Math.abs(side) < sw.r + PLAYER_RADIUS) {
          // 봉 표면의 이동 방향 = 각속도 × 반지름 벡터
          const dir = Math.sign(w) * Math.sign(along || 1);
          const kx = -sa * dir, kz = ca * dir;
          const power = 4.5 + Math.min(4, Math.abs(w * along) * 0.5);
          s.vx = kx * power; s.vz = kz * power; s.vy = 6.5;
          s.stun = STUN_TICKS; s.grounded = 0; s.coyote = 0; s.mover = -1;
          break;
        }
      }
    }

    // 굴러오는 공: 몸에 닿으면 공이 굴러가는 방향으로 날려 보낸다. 공 위로 뛰어넘으면 닿지 않는다.
    const balls = L.balls;
    if (balls && s.stun < STUN_TICKS - REHIT_TICKS) {
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (b.at > this.time) break; // 출발 시각 순으로 정렬되어 있다
        if (this.time > b.end) continue;
        // 발이 공 꼭대기보다 높거나, 머리가 공 아래에 있으면 닿지 않는다(공은 바닥 y=0 위를 구른다)
        if (s.y > b.r * 2 - 0.12 || s.y + PLAYER_CENTER_Y * 2 < 0) continue;
        const [bx, bz] = ballPos(b, this.time);
        const ox = s.x - bx, oz = s.z - bz;
        const reach = b.r + PLAYER_RADIUS;
        if (ox * ox + oz * oz > reach * reach) continue;
        // 공의 진행 방향으로 크게, 공 중심에서 벗어나는 방향으로 조금 더 밀린다
        const d = Math.hypot(ox, oz) || 1;
        const side = (ox * b.dz - oz * b.dx) / d; // 공 진행 방향의 옆쪽 성분
        const power = 3.5 + b.speed * 0.3 + b.r * 2; // 작은 공은 2m쯤, 큰 공은 3~4m쯤 날아간다
        s.vx = b.dx * power + -b.dz * side * 1.5;
        s.vz = b.dz * power + b.dx * side * 1.5;
        s.vy = 4.2 + b.r * 1.5;
        s.stun = Math.round(STUN_TICKS * 0.75); s.grounded = 0; s.coyote = 0; s.mover = -1; s.shove = 0;
        break;
      }
    }

    // 폭탄: 터질 시각이 지난 것을 차례로 처리한다. 엄폐물 뒤(폭탄에서 안 보이는 곳)는 안전하다.
    const bombs = L.bombs;
    if (bombs) {
      while (s.bomb < bombs.length && this.time >= bombs[s.bomb].at + bombs[s.bomb].fuse) {
        const b = bombs[s.bomb++];
        if (this.time - (b.at + b.fuse) > 0.5) continue; // 한참 지난 폭탄(늦게 합류)은 무시
        const ox = s.x - b.p[0], oz = s.z - b.p[2], oy = s.y + PLAYER_CENTER_Y - (b.p[1] + 0.6);
        const d = Math.hypot(ox, oz);
        if (d > b.radius || Math.abs(oy) > 3.5) continue;
        if (d > 0.9) {
          const len = Math.hypot(d, oy);
          this.ray.origin.x = b.p[0]; this.ray.origin.y = b.p[1] + 0.6; this.ray.origin.z = b.p[2];
          this.ray.dir.x = ox / len; this.ray.dir.y = oy / len; this.ray.dir.z = oz / len;
          const hit = this.world.castRay(this.ray, len - 0.45, true, undefined, PLAYER_GROUPS);
          if (hit) continue; // 벽에 가려졌다
        }
        const a = d > 0.05 ? Math.atan2(ox, oz) : slot * 2.4;
        const power = 15 * (1 - (d / b.radius) * 0.5);
        s.vx = Math.sin(a) * power; s.vz = Math.cos(a) * power; s.vy = 9;
        s.stun = STUN_TICKS; s.grounded = 0; s.coyote = 0; s.mover = -1;
      }
    }

    // 체크포인트(순서대로만 통과)
    const next = s.cp + 1;
    if (next < L.checkpoints.length && inBox(L.checkpoints[next].zone, s.x, s.y, s.z)) s.cp = next;

    // 낙하 → 마지막 체크포인트에서 부활
    if (s.y < L.killY) {
      if (L.noRespawn) {
        // 생존 게임: 부활 없이 낙하 기록만 남긴다(서버가 이를 보고 탈락 처리)
        if (s.falls === 0) s.falls = 1;
        s.y = L.killY - 1; s.vx = s.vy = s.vz = 0;
      } else this.respawn(s, slot);
    }
  }

  respawn(s: PlayerState, slot: number) {
    const [x, y, z] = this.safeSpawn(s.cp, slot);
    s.x = x; s.y = y + 0.05; s.z = z;
    s.vx = s.vy = s.vz = 0;
    s.stun = 0; s.shove = 0; s.grounded = 0; s.mover = -1; s.ride = -1; s.coyote = 0; s.jumpBuf = 0;
    s.falls++;
  }

  /**
   * 부활 위치 고르기. 체크포인트 주변 격자 가운데
   * (1) 바로 아래에 고정된 바닥이 체크포인트와 같은 높이에 있고(움직이는 발판·허공·벽 위 제외)
   * (2) 회전봉이 지나가는 원, 미는 벽이 오가는 범위, 점프 발판에서 떨어진 자리만 쓴다.
   * 같은 맵·같은 시각이면 같은 결과가 나와서 서버와 클라이언트 예측의 부활 위치가 일치한다.
   */
  private safeSpawn(cp: number, slot: number): [number, number, number] {
    const L = this.level;
    const c = L.checkpoints[Math.min(cp, L.checkpoints.length - 1)];
    const [sx, sy, sz] = c.spawn;
    const safe: [number, number, number][] = [];
    const STEP = 1.4, rows = [0, -1, 1, -2, 2, -3, 3, -4, 4];
    for (const r of rows) {
      for (let k = 0; k < 10; k++) {
        const x = sx + (k - 4.5) * STEP, z = sz + r * STEP;
        if (this.spawnBlocked(x, sy, z)) continue;
        if (!this.groundAt(x, sy, z)) continue;
        safe.push([x, sy, z]);
      }
    }
    if (!safe.length) return spawnPoint(L, cp, slot); // 맞는 자리가 없으면 원래 규칙대로
    return safe[slot % safe.length];
  }

  /** (x, z) 아래에 높이 y 근처의 고정된 바닥이 있나 */
  private groundAt(x: number, y: number, z: number): boolean {
    this.ray.origin.x = x; this.ray.origin.y = y + 2; this.ray.origin.z = z;
    this.ray.dir.x = 0; this.ray.dir.y = -1; this.ray.dir.z = 0;
    // 캐릭터 몸통 정도의 폭이 모두 바닥 위에 있어야 한다(가장자리에 걸치면 미끄러져 떨어진다)
    for (const [ox, oz] of [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]]) {
      this.ray.origin.x = x + ox; this.ray.origin.z = z + oz;
      const hit = this.world.castRay(this.ray, 3.5, true, undefined, PLAYER_GROUPS, this.probe, undefined,
        (col) => !this.moverHandles.has(col.handle));
      if (!hit || Math.abs(2 - hit.timeOfImpact) > 0.6) return false;
    }
    return true;
  }

  /** 회전봉·미는 벽·점프 발판 근처인가 */
  private spawnBlocked(x: number, y: number, z: number): boolean {
    const L = this.level;
    for (const sw of L.sweepers) {
      if (sw.c[1] - sw.r > y + PLAYER_CENTER_Y * 2 || sw.c[1] + sw.r < y) continue;
      if (Math.hypot(x - sw.c[0], z - sw.c[2]) < sw.len + sw.r + 1.0) return true;
    }
    for (const m of L.movers) {
      if (m.kind !== 'wall') continue;
      if (Math.abs(x - m.p[0]) < m.h[0] + Math.abs(m.travel[0]) + 0.8 && Math.abs(z - m.p[2]) < m.h[2] + Math.abs(m.travel[2]) + 0.8) return true;
    }
    for (const pd of L.pads) if (Math.abs(x - pd.p[0]) < pd.h[0] + 0.4 && Math.abs(z - pd.p[2]) < pd.h[2] + 0.4) return true;
    return false;
  }

  /** 수평으로 살짝 민다(플레이어끼리 밀어내기용). 벽과 바닥 충돌은 그대로 지킨다. */
  nudge(s: PlayerState, dx: number, dz: number) {
    this.probe.setTranslation({ x: s.x, y: s.y + PLAYER_CENTER_Y, z: s.z });
    this.kcc.computeColliderMovement(this.probe, { x: dx, y: 0, z: dz }, undefined, PLAYER_GROUPS);
    const mv = this.kcc.computedMovement();
    s.x += mv.x; s.z += mv.z;
  }

  moverPosition(i: number) { return this.moverPos[i]; }

  free() { this.world.free(); }
}
