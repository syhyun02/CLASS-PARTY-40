import { TICK_RATE, rankPoints, type CollectState } from '@shared';
import { createPusher } from './push';
import type { GameCtx, MinigameRuntime, MinigameServer, RoundOutcome } from './types';

const TOUCH = 1.0; // 꼬리를 빼앗는 거리
const SAFE = Math.round(1.5 * TICK_RATE); // 빼앗은 직후 다시 뺏기지 않는 시간
const END_BONUS = 20;

/**
 * 꼬리 지키기: 세 명 중 한 명꼴로 꼬리를 달고 시작한다.
 * 꼬리 없는 사람이 꼬리 있는 사람에게 닿으면 꼬리가 넘어간다.
 * 꼬리를 달고 있던 시간(초)만큼 점수가 쌓이고, 끝날 때 갖고 있으면 보너스를 받는다.
 */
export const tailGame = (id: string): MinigameServer => ({
  id,
  create(ctx: GameCtx): MinigameRuntime {
    const tails = new Set<number>();
    const safeUntil = new Map<number, number>();
    const held = new Map<number, number>(); // 보유한 틱 수
    const push = createPusher(ctx);
    // 처음 꼬리 주인은 서버에서만 뽑으므로 평범한 난수로 섞어도 된다
    const ids = ctx.players.map((p) => p.id);
    for (let i = ids.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [ids[i], ids[k]] = [ids[k], ids[i]]; }
    ids.slice(0, Math.max(1, Math.round(ids.length / 3))).forEach((i) => tails.add(i));
    let sent = 0;
    const publish = () => {
      const st: CollectState = { tails: [...tails], scores: [...held.entries()].map(([i, t]) => [i, Math.floor(t / TICK_RATE)]) };
      ctx.publish(st);
    };
    publish();

    return {
      onTick() {
        push();
        const tick = ctx.tick();
        let changed = false;
        for (const p of ctx.players) {
          if (!tails.has(p.id)) continue;
          held.set(p.id, (held.get(p.id) ?? 0) + 1);
          if ((safeUntil.get(p.id) ?? 0) > tick) continue;
          // 가장 가까운 꼬리 없는 사람에게 넘어간다
          let best = null as typeof p | null, bestD = TOUCH;
          for (const q of ctx.players) {
            if (q === p || tails.has(q.id) || !q.connected || q.state.stun > 0) continue;
            if (Math.abs(q.state.y - p.state.y) > 1.2) continue;
            const d = Math.hypot(q.state.x - p.state.x, q.state.z - p.state.z);
            if (d < bestD) { bestD = d; best = q; }
          }
          if (best) {
            tails.delete(p.id); tails.add(best.id);
            safeUntil.set(best.id, tick + SAFE);
            changed = true;
          }
        }
        // 접속이 끊긴 사람의 꼬리는 꼬리 없는 아무에게나 넘긴다
        for (const p of ctx.players) {
          if (!p.connected && tails.has(p.id)) {
            const to = ctx.players.find((q) => q.connected && !tails.has(q.id));
            if (to) { tails.delete(p.id); tails.add(to.id); changed = true; }
          }
        }
        if (changed || tick - sent >= TICK_RATE) { sent = tick; publish(); }
      },
      canMove: () => true,
      isOver: () => false,
      outcome(): RoundOutcome[] {
        const score = (i: number) => Math.floor((held.get(i) ?? 0) / TICK_RATE) + (tails.has(i) ? END_BONUS : 0);
        const sorted = [...ctx.players].sort((a, b) => score(b.id) - score(a.id));
        let rank = 0, prev = -1;
        return sorted.map((p, i) => {
          const v = score(p.id);
          if (v !== prev) { rank = i + 1; prev = v; }
          const sec = Math.floor((held.get(p.id) ?? 0) / TICK_RATE);
          return { id: p.id, rank, points: v > 0 ? rankPoints(rank) : 5, detail: `꼬리 ${sec}초${tails.has(p.id) ? ' + 끝까지 지킴' : ''}` };
        });
      },
    };
  },
});
