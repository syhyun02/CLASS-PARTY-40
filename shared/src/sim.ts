import type RAPIER_NS from '@dimforge/rapier3d-compat';
import {
  AIR_ACCEL, COYOTE_TICKS, DT, GRAVITY, GROUND_ACCEL, JUMP_BUFFER_TICKS, JUMP_VELOCITY,
  MOVE_SPEED, PLAYER_CENTER_Y, PLAYER_HALF_HEIGHT, PLAYER_RADIUS, STUN_TICKS,
} from './constants';
import { inBox, moverOffset, spawnPoint, sweeperAngle, type LevelDef } from './level';

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
}

export interface PlayerInput {
  mx: number; // 월드 기준 이동 방향(-1~1)
  mz: number;
  jump: boolean;
  action: boolean;
}

export const NO_INPUT: PlayerInput = { mx: 0, mz: 0, jump: false, action: false };

export const STATE_KEYS: (keyof PlayerState)[] = [
  'x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'grounded', 'stun', 'coyote', 'jumpBuf', 'jumpHeld', 'mover', 'cp', 'falls',
];
export const packState = (s: PlayerState): number[] => STATE_KEYS.map((k) => s[k]);
export function unpackState(a: number[], out: PlayerState): PlayerState {
  for (let i = 0; i < STATE_KEYS.length; i++) out[STATE_KEYS[i]] = a[i];
  return out;
}

export function newPlayerState(level: LevelDef, slot: number, cp = 0): PlayerState {
  const [x, y, z] = spawnPoint(level, cp, slot);
  return { x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, grounded: 1, stun: 0, coyote: 0, jumpBuf: 0, jumpHeld: 0, mover: -1, cp, falls: 0 };
}

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
  private time = 0;
  private tick = -1;

  constructor(R: Rapier, readonly level: LevelDef) {
    this.world = new R.World({ x: 0, y: 0, z: 0 });
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
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i];
      const a = moverOffset(m, this.time);
      const b = moverOffset(m, this.time - DT);
      this.moverDelta[i][0] = a[0] - b[0];
      this.moverDelta[i][1] = a[1] - b[1];
      this.moverDelta[i][2] = a[2] - b[2];
      const pos = this.moverPos[i];
      pos[0] = m.p[0] + a[0]; pos[1] = m.p[1] + a[1]; pos[2] = m.p[2] + a[2];
      this.moverCols[i].setTranslation({ x: pos[0], y: pos[1], z: pos[2] });
    }
    this.world.step(); // 충돌 질의 구조 갱신(동적 물체가 없어서 가볍다)
  }

  /**
   * 플레이어 한 명을 한 틱 전진시킨다. setTick(tick) 이후에 호출할 것.
   * canMove=false면 입력을 무시한다(카운트다운, 결과 화면 등).
   */
  stepPlayer(s: PlayerState, inp: PlayerInput, slot: number, canMove: boolean) {
    const L = this.level;
    let mx = canMove ? inp.mx : 0;
    let mz = canMove ? inp.mz : 0;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    const stunned = s.stun > 0;
    if (stunned) { s.stun--; mx = 0; mz = 0; }

    // 수평 가속
    const accel = (s.grounded ? GROUND_ACCEL : AIR_ACCEL) * (stunned ? 0.25 : 1) * DT;
    const tx = mx * MOVE_SPEED, tz = mz * MOVE_SPEED;
    const dvx = tx - s.vx, dvz = tz - s.vz;
    const dv = Math.hypot(dvx, dvz);
    if (dv <= accel || dv === 0) { s.vx = tx; s.vz = tz; } else { s.vx += (dvx / dv) * accel; s.vz += (dvz / dv) * accel; }
    if (!stunned && (mx !== 0 || mz !== 0)) s.yaw = Math.atan2(mx, mz);

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
    if (s.mover >= 0 && s.mover < this.moverDelta.length) {
      const d = this.moverDelta[s.mover];
      dx += d[0]; dy += d[1]; dz += d[2];
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
    s.grounded = grounded ? 1 : 0;

    // 점프 발판
    if (grounded) {
      for (const pad of L.pads) {
        if (inBox(pad, s.x, s.y, s.z, 0.25)) { s.vy = pad.vy; s.grounded = 0; s.coyote = 0; s.mover = -1; break; }
      }
    }

    // 회전봉: 봉이 움직이는 방향으로 날려 보낸다
    if (s.stun < STUN_TICKS - 6) {
      for (const sw of L.sweepers) {
        if (s.y > sw.c[1] + sw.r || s.y + PLAYER_CENTER_Y * 2 < sw.c[1] - sw.r) continue;
        const a = sweeperAngle(sw, this.time);
        const ca = Math.cos(a), sa = Math.sin(a);
        const ox = s.x - sw.c[0], oz = s.z - sw.c[2];
        const along = ox * ca + oz * sa; // 봉 길이 방향
        const side = -ox * sa + oz * ca; // 봉에 수직
        if (Math.abs(along) < sw.len + PLAYER_RADIUS && Math.abs(side) < sw.r + PLAYER_RADIUS) {
          // 봉 표면의 이동 방향 = 각속도 × 반지름 벡터
          const dir = Math.sign(sw.speed) * Math.sign(along || 1);
          const kx = -sa * dir, kz = ca * dir;
          const power = 4.5 + Math.min(4, Math.abs(sw.speed * along) * 0.5);
          s.vx = kx * power; s.vz = kz * power; s.vy = 6.5;
          s.stun = STUN_TICKS; s.grounded = 0; s.coyote = 0; s.mover = -1;
          break;
        }
      }
    }

    // 체크포인트(순서대로만 통과)
    const next = s.cp + 1;
    if (next < L.checkpoints.length && inBox(L.checkpoints[next].zone, s.x, s.y, s.z)) s.cp = next;

    // 낙하 → 마지막 체크포인트에서 부활
    if (s.y < L.killY) this.respawn(s, slot);
  }

  respawn(s: PlayerState, slot: number) {
    const [x, y, z] = spawnPoint(this.level, s.cp, slot);
    s.x = x; s.y = y + 0.05; s.z = z;
    s.vx = s.vy = s.vz = 0;
    s.stun = 0; s.grounded = 0; s.mover = -1; s.coyote = 0; s.jumpBuf = 0;
    s.falls++;
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
