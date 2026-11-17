/**
 * 부활 위치 검사: 모든 맵·체크포인트·자리 번호(0~39)에 대해, 부활 위치 바로 아래에 고정된 바닥이 있는지 확인한다.
 * 움직이는 발판은 바닥으로 치지 않는다(언제 오느냐에 따라 허공일 수 있다).
 *   npx tsx scripts/spawncheck.ts
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { GAMES, SimWorld, buildLevel, newPlayerState } from '@shared';
await RAPIER.init();
let bad = 0;
for (const id of ['lobby', ...GAMES.filter((g) => g.implemented).map((g) => g.id)]) {
  for (const seed of [1, 7, 42]) {
    const level = buildLevel(id, seed);
    const sim = new SimWorld(RAPIER, level);
    for (let cp = 0; cp < level.checkpoints.length - (level.finish ? 1 : 0); cp++) {
      const misses: number[] = [];
      for (let slot = 0; slot < 40; slot++) {
        const s = newPlayerState(level, slot, cp);
        // 같은 규칙으로 부활시킨 위치에서 2초 동안 가만히 서 있어 본다
        sim.respawn(s, slot);
        const falls0 = s.falls;
        for (let t = 1; t <= 120; t++) { sim.setTick(t); sim.stepPlayer(s, { mx: 0, mz: 0, jump: false, action: false }, slot, false); }
        if (s.falls > falls0 || s.y < level.killY + 1) misses.push(slot);
      }
      if (misses.length) { bad++; console.log(`${id} 시드${seed} 체크포인트${cp}: 자리 ${misses.join(',')} 가 허공에서 부활`); }
    }
    sim.free();
  }
}
console.log(bad ? `문제 ${bad}건` : '모든 부활 위치에 바닥이 있다');
