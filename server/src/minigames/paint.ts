import { PAINT, PAINT_BLOCK, PLAYER_CENTER_Y, TEAM_NAMES, TICK_RATE, paintBlank, paintCell, paintSplash, type CollectState } from '@shared';
import { createPusher } from './push';
import type { GameCtx, MinigameRuntime, MinigameServer, RoundOutcome } from './types';

const TEAM_POINTS = [100, 85, 70, 55];
/** 판 전체를 보내는 간격(바뀐 경우만). 학생 화면은 자기 칸을 먼저 칠해 보여 주므로 이 정도면 충분하다. */
const SEND_EVERY = Math.round(TICK_RATE / 5);

/**
 * 색깔 땅따먹기: 땅에 발을 디딘 칸이 그 학생 팀 색이 된다(이미 다른 팀 칸이어도 덮어쓴다).
 * 페인트 폭탄을 먹으면 반지름 PAINT.bombR 안이 한꺼번에 칠해진다. 밀기로 상대를 방해한다.
 * 끝났을 때 칠한 칸이 많은 팀이 이긴다.
 */
export const paintGame = (id: string): MinigameServer => ({
  id,
  create(ctx: GameCtx): MinigameRuntime {
    const grid = paintBlank().split('');
    const total = grid.filter((c) => c !== PAINT_BLOCK).length;
    const counts = [0, 0, 0, 0];
    const mine = new Map<number, number>(); // 학생별로 칠한 칸 수(기여도)
    const items = ctx.level.items ?? [];
    const taken = new Set<number>();
    const live: number[] = [];
    let next = 0;
    let dirty = true;
    const push = createPusher(ctx);

    const paint = (cell: number, team: number, who: number) => {
      const cur = grid[cell];
      if (cell < 0 || cur === PAINT_BLOCK) return;
      const ch = String(team);
      if (cur === ch) return;
      if (cur !== '.') counts[+cur]--;
      grid[cell] = ch; counts[team]++;
      mine.set(who, (mine.get(who) ?? 0) + 1);
      dirty = true;
    };
    const publish = () => {
      ctx.publish({ paint: grid.join(''), teams: [...counts], taken: [...taken] } satisfies CollectState);
      dirty = false;
    };
    publish();

    return {
      onTick() {
        push();
        for (const p of ctx.players) {
          if (!p.connected || p.team < 0 || p.out) continue;
          const s = p.state;
          if (s.grounded && s.y < 0.3) paint(paintCell(s.x, s.z), p.team, p.id);
        }
        // 페인트 폭탄
        const t = ctx.levelTime();
        while (next < items.length && items[next].at <= t) live.push(next++);
        for (let k = live.length - 1; k >= 0; k--) {
          const it = items[live[k]];
          let best: (typeof ctx.players)[number] | null = null, bestD = PAINT.pickR;
          for (const p of ctx.players) {
            if (!p.connected || p.team < 0) continue;
            const s = p.state;
            if (Math.abs(s.y + PLAYER_CENTER_Y - it.p[1]) > 1.4) continue;
            const d = Math.hypot(s.x - it.p[0], s.z - it.p[2]);
            if (d < bestD) { bestD = d; best = p; }
          }
          if (best) {
            taken.add(live[k]);
            live.splice(k, 1);
            for (const c of paintSplash(it.p[0], it.p[2])) paint(c, best.team, best.id);
            dirty = true;
          }
        }
        if (dirty && ctx.tick() % SEND_EVERY === 0) publish();
      },
      canMove: () => true,
      isOver: () => false,
      outcome(): RoundOutcome[] {
        const order = [0, 1, 2, 3].sort((a, b) => counts[b] - counts[a]);
        const teamRank = new Array(4).fill(0);
        order.forEach((t, i) => { teamRank[t] = i > 0 && counts[t] === counts[order[i - 1]] ? teamRank[order[i - 1]] : i + 1; });
        return ctx.players.map((p) => {
          const tm = p.team >= 0 ? p.team : 0, tr = teamRank[tm];
          const pct = Math.round((counts[tm] / total) * 100);
          return { id: p.id, rank: tr, points: TEAM_POINTS[tr - 1], detail: `${TEAM_NAMES[tm]} 팀 ${pct}% · 팀 ${tr}위 · 내가 칠한 칸 ${mine.get(p.id) ?? 0}` };
        });
      },
    };
  },
});
