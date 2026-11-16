import { CHEM_DOOR_HALF, CHEM_DOOR_X, STUN_TICKS, chemDoorOrder, chemRowZ } from '@shared';
import { raceGame } from './race';
import type { GameCtx, MinigameRuntime, MinigameServer } from './types';

/**
 * 화학 미로: 레이스 규칙 + 문제의 문.
 * 문은 충돌이 없는 빛의 막이라 화면에서는 누구나 지나갈 수 있어 보이지만, 서버가 학생별로 판정한다.
 * 정답 보기가 걸린 문이면 통과, 아니면 뒤로 튕겨 내고 잠깐 넘어뜨린다.
 * 보기 순서는 학생마다 달라서(chemDoorOrder) 앞사람이 지나간 문을 따라가도 소용없다.
 */
export const chemMazeGame = (id: string): MinigameServer => ({
  id,
  create(ctx: GameCtx): MinigameRuntime {
    const race = raceGame(id).create(ctx);
    const quiz = ctx.level.quiz ?? [];
    const passed = new Map<number, number>(); // 학생별로 통과한 문제 수
    const tried = new Map<number, Set<number>>(); // 지금 문제에서 틀린 문
    const firstTry = new Map<number, number>();

    return {
      onTick() {
        for (const p of ctx.players) {
          if (!p.connected || p.done) continue;
          const qi = passed.get(p.id) ?? 0;
          if (qi >= quiz.length) continue;
          const s = p.state, z = chemRowZ(qi);
          if (s.z < z - 0.75) continue; // 아직 문 앞에 닿지 않았다
          const d = CHEM_DOOR_X.findIndex((x) => Math.abs(s.x - x) <= CHEM_DOOR_HALF);
          if (d < 0) continue; // 문 사이 벽(맵의 충돌이 막는다)
          const wrongs = tried.get(p.id) ?? new Set<number>();
          if (chemDoorOrder(ctx.seed, p.id, qi)[d] === quiz[qi].answer) {
            const first = wrongs.size === 0;
            if (first) firstTry.set(p.id, (firstTry.get(p.id) ?? 0) + 1);
            passed.set(p.id, qi + 1);
            tried.delete(p.id);
            ctx.tell(p.id, { pass: { q: qi, explain: quiz[qi].explain ?? '', first } });
          } else {
            // 오답: 문 앞으로 되돌려 튕겨 내고 1.2초쯤 넘어뜨린다
            s.z = Math.min(s.z, z - 0.8);
            s.vz = -8; s.vx *= 0.3; s.vy = 5;
            s.stun = Math.round(STUN_TICKS * 1.5); s.grounded = 0; s.coyote = 0;
            if (!wrongs.has(d)) { wrongs.add(d); tried.set(p.id, wrongs); ctx.tell(p.id, { wrong: [qi, d] }); }
          }
        }
        race.onTick();
      },
      canMove: race.canMove,
      isOver: race.isOver,
      outcome() {
        // 레이스 순위에, 한 번에 맞힌 문제 수를 덧붙인다
        return race.outcome().map((o) => ({ ...o, detail: `${o.detail} · 한 번에 정답 ${firstTry.get(o.id) ?? 0}/${quiz.length}` }));
      },
    };
  },
});
