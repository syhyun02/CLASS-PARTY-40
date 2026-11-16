import { STUN_TICKS, TICK_RATE } from '@shared';
import type { GameCtx, GamePlayer } from './types';

const COOLDOWN = Math.round(1.2 * TICK_RATE);
const RANGE = 1.7; // 밀 수 있는 거리
const POWER = 9.5;

/**
 * 밀치기: 버튼을 누른 순간 앞쪽 부채꼴 안의 상대를 밀어낸다. 쿨타임이 있어 연타는 안 된다.
 * 서버에서만 판정하고, 밀린 쪽 화면은 위치 보정으로 따라온다.
 */
export function createPusher(ctx: GameCtx, canPush: (p: GamePlayer) => boolean = () => true) {
  const held = new Map<number, boolean>();
  return function update() {
    const tick = ctx.tick();
    for (const p of ctx.players) {
      const down = p.input.action && p.connected && canPush(p);
      const was = held.get(p.id) ?? false;
      held.set(p.id, p.input.action);
      if (!down || was || tick - p.pushAt < COOLDOWN || p.state.stun > 0) continue;
      p.pushAt = tick;
      const fx = Math.sin(p.state.yaw), fz = Math.cos(p.state.yaw);
      for (const q of ctx.players) {
        if (q === p || q.out || !q.connected) continue;
        const dx = q.state.x - p.state.x, dz = q.state.z - p.state.z, d = Math.hypot(dx, dz);
        if (d > RANGE || Math.abs(q.state.y - p.state.y) > 1.2) continue;
        if (d > 0.2 && (dx * fx + dz * fz) / d < 0.35) continue; // 앞쪽에 있는 상대만
        const s = q.state;
        s.vx = fx * POWER; s.vz = fz * POWER; s.vy = 5;
        s.stun = Math.round(STUN_TICKS * 0.5); s.grounded = 0; s.coyote = 0; s.mover = -1;
      }
    }
  };
}
