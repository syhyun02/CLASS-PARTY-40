import { DT, GOAL_DIRS, PLAYER_RADIUS, PROP_ID_BASE, TEAMBALL, TEAM_NAMES, TICK_RATE, type CollectState, type SnapPlayer } from '@shared';
import { createPusher } from './push';
import type { GameCtx, MinigameRuntime, MinigameServer, RoundOutcome } from './types';

const TEAM_POINTS = [100, 85, 70, 55];
const FRICTION = Math.pow(0.6, DT); // 1초에 속도가 60%로 줄어든다
const BOUNCE = 0.75;
const KICK = 13;
const KICK_RANGE = TEAMBALL.ballR + 1.4;
const KICK_COOLDOWN = Math.round(0.5 * TICK_RATE);
const RESET_TICKS = Math.round(1.5 * TICK_RATE);

interface Ball { x: number; z: number; vx: number; vz: number; last: number; reset: number; spin: number }

/**
 * 팀 공 넣기: 공은 서버가 움직인다(마찰, 벽 튕김, 공끼리 부딪힘).
 * 몸으로 밀면 달리는 속도만큼 굴러가고, 차기 버튼을 누르면 바라보는 쪽으로 세게 찬다.
 * 공이 골대 안으로 들어가면 마지막으로 건드린 팀이 1점(자책골은 점수 없음), 공은 가운데에서 다시 나온다.
 */
export const teamBallGame = (id: string): MinigameServer => ({
  id,
  create(ctx: GameCtx): MinigameRuntime {
    const { half: H, goalHalf: G, goalDepth: D, ballR: R } = TEAMBALL;
    const start = (k: number) => [[0, 0], [5, 0], [-5, 0]][k % 3];
    const balls: Ball[] = Array.from({ length: TEAMBALL.balls }, (_, k) => ({ x: start(k)[0], z: start(k)[1], vx: 0, vz: 0, last: -1, reset: 0, spin: 0 }));
    const score = [0, 0, 0, 0];
    const kickAt = new Map<number, number>();
    const held = new Map<number, boolean>();
    const push = createPusher(ctx);
    let goalSeq = 0;
    let lastGoal: CollectState['goal'];
    const publish = () => ctx.publish({ teams: [...score], goal: lastGoal } satisfies CollectState);
    publish();

    const props = (): SnapPlayer[] => balls.map((b, k) => ({
      id: PROP_ID_BASE + k, x: b.x, y: R, z: b.z, yaw: b.spin, flags: b.reset > 0 ? 8 : 0, // 8: 잠깐 숨김(골 뒤 다시 나오는 중)
    }));

    return {
      onTick() {
        push(); // 차기 버튼은 사람도 밀어낸다
        const tick = ctx.tick();
        // 1) 사람과 공: 겹치면 공을 밀어내고, 사람이 달려오던 속도를 공에 준다
        for (const p of ctx.players) {
          if (!p.connected || p.team < 0) continue;
          const s = p.state;
          const kickDown = p.input.action && !(held.get(p.id) ?? false);
          held.set(p.id, p.input.action);
          for (const b of balls) {
            if (b.reset > 0) continue;
            const dx = b.x - s.x, dz = b.z - s.z, d = Math.hypot(dx, dz) || 0.001;
            if (s.y > R * 2 - 0.2) continue; // 공 위로 뛰어넘는 중
            const nx = dx / d, nz = dz / d;
            const reach = R + PLAYER_RADIUS;
            if (d < reach) {
              const over = reach - d;
              b.x += nx * over * 0.85; b.z += nz * over * 0.85;
              ctx.nudge(s, -nx * over * 0.15, -nz * over * 0.15);
              const rel = (s.vx * nx + s.vz * nz) - (b.vx * nx + b.vz * nz);
              if (rel > 0) { b.vx += nx * rel * 1.15; b.vz += nz * rel * 1.15; }
              b.last = p.team;
            }
            // 차기: 바라보는 쪽 앞에 공이 있으면 세게 찬다
            if (kickDown && d < KICK_RANGE && tick - (kickAt.get(p.id) ?? -999) > KICK_COOLDOWN) {
              const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
              if ((dx * fx + dz * fz) / d > 0.1) {
                b.vx = fx * KICK + s.vx * 0.3; b.vz = fz * KICK + s.vz * 0.3; b.last = p.team;
                kickAt.set(p.id, tick);
              }
            }
          }
        }
        // 2) 공끼리 부딪힘
        for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
          const a = balls[i], b = balls[j];
          if (a.reset > 0 || b.reset > 0) continue;
          const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 0.001;
          if (d >= R * 2) continue;
          const nx = dx / d, nz = dz / d, over = R * 2 - d;
          a.x -= nx * over / 2; a.z -= nz * over / 2; b.x += nx * over / 2; b.z += nz * over / 2;
          const rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
          if (rel > 0) { a.vx -= nx * rel; a.vz -= nz * rel; b.vx += nx * rel; b.vz += nz * rel; }
        }
        // 3) 움직임, 벽, 골
        let changed = false;
        for (let k = 0; k < balls.length; k++) {
          const b = balls[k];
          if (b.reset > 0) {
            if (--b.reset === 0) { [b.x, b.z] = start(k); b.vx = b.vz = 0; b.last = -1; changed = true; }
            continue;
          }
          const sp = Math.hypot(b.vx, b.vz);
          if (sp > 18) { b.vx *= 18 / sp; b.vz *= 18 / sp; }
          b.x += b.vx * DT; b.z += b.vz * DT;
          b.vx *= FRICTION; b.vz *= FRICTION;
          b.spin += Math.hypot(b.vx, b.vz) * DT / R;
          // 골: 골대 입구(가로 폭 안)를 지나 골대 안쪽까지 들어갔다
          for (let t = 0; t < 4; t++) {
            const [gx, gz] = GOAL_DIRS[t];
            const depth = b.x * gx + b.z * gz, across = Math.abs(gx !== 0 ? b.z : b.x);
            if (depth > H + R * 0.6 && across < G) {
              const scorer = b.last >= 0 && b.last !== t ? b.last : -1;
              if (scorer >= 0) score[scorer]++;
              lastGoal = { seq: ++goalSeq, scorer, into: t };
              b.reset = RESET_TICKS; changed = true;
              break;
            }
          }
          if (b.reset > 0) continue;
          // 벽: 골대 입구가 아니면 튕긴다. 골대 안에서는 옆벽·뒷벽에 튕긴다.
          for (const axis of ['x', 'z'] as const) {
            const other = axis === 'x' ? b.z : b.x;
            const v = axis === 'x' ? 'vx' : 'vz';
            const inMouth = Math.abs(other) < G - R * 0.4;
            const lim = inMouth ? H + D - R : H - R;
            if (b[axis] > lim) { b[axis] = lim; b[v] = -Math.abs(b[v]) * BOUNCE; }
            if (b[axis] < -lim) { b[axis] = -lim; b[v] = Math.abs(b[v]) * BOUNCE; }
          }
        }
        ctx.setProps(props());
        if (changed) publish();
      },
      canMove: () => true,
      isOver: () => false,
      outcome(): RoundOutcome[] {
        // 팀 순위(같은 점수는 같은 순위) → 팀원 모두 같은 점수
        const order = [0, 1, 2, 3].sort((a, b) => score[b] - score[a]);
        const teamRank = new Array(4).fill(0);
        order.forEach((t, i) => { teamRank[t] = i > 0 && score[t] === score[order[i - 1]] ? teamRank[order[i - 1]] : i + 1; });
        return ctx.players.map((p) => {
          const t = p.team >= 0 ? p.team : 0, tr = teamRank[t];
          return { id: p.id, rank: tr, points: TEAM_POINTS[tr - 1], detail: `${TEAM_NAMES[t]} 팀 ${score[t]}골 · 팀 ${tr}위` };
        });
      },
    };
  },
});
