import { useState } from 'react';
import { PLAYER_COLORS } from '@shared';
import { net } from '../game/net';
import { useStore } from '../game/store';
import { Scene } from '../three/Scene';
import { Controls } from './Controls';
import { usePortrait } from './hooks';
import { Blob, CountdownOverlay, DrawOverlay, FinalOverlay, GameHud, ResultOverlay, SettingsButton, StatusOverlays } from './Overlays';

/** 학생 화면: 3D 경기장 + 조작 + 단계별 안내 */
export function PlayScreen() {
  const room = useStore((s) => s.room);
  const myId = useStore((s) => s.myId);
  const isTouch = useStore((s) => s.isTouch);
  const portrait = usePortrait();
  const [skipRotate, setSkipRotate] = useState(false);
  const [colors, setColors] = useState(false);
  if (!room) return <div className="party-bg flex h-full items-center justify-center font-display text-2xl">불러오는 중…</div>;
  const mine = room.players.find((p) => p.id === myId);
  const late = !!mine && !mine.active; // 경기 도중 입장
  const spectating = late || (!!mine && mine.out && room.phase === 'playing');
  const phase = room.phase;

  return (
    <div className="fixed inset-0 overflow-hidden">
      <Scene spectator={spectating} />
      {!spectating && <Controls />}

      {phase === 'lobby' && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-2 p-3">
          <div className="chip !text-base">대기실 · {room.players.filter((p) => p.connected).length}명 입장 · 선생님이 곧 시작해요</div>
          <button className="chip pointer-events-auto flex items-center gap-2" onClick={() => setColors(!colors)}>
            <Blob color={mine?.color ?? '#fff'} size={18} /> {mine?.name} · 색 바꾸기
          </button>
          {colors && (
            <div className="card pointer-events-auto flex max-w-xs flex-wrap justify-center gap-2 !p-3">
              {PLAYER_COLORS.map((c) => (
                <button key={c} onClick={() => { net.setColor(c); setColors(false); }} aria-label={`색 ${c}`}><Blob color={c} size={28} /></button>
              ))}
            </div>
          )}
        </div>
      )}
      {phase === 'draw' && <DrawOverlay room={room} />}
      {phase === 'countdown' && <CountdownOverlay room={room} />}
      {phase === 'playing' && <GameHud room={room} myId={myId} />}
      {phase === 'result' && <ResultOverlay room={room} myId={myId} />}
      {phase === 'final' && <FinalOverlay room={room} myId={myId} />}
      {late && (phase === 'playing' || phase === 'countdown') && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center">
          <div className="card !py-2 font-display">👀 관전 중 · 다음 라운드부터 함께 뛰어요</div>
        </div>
      )}
      <SettingsButton />
      <StatusOverlays room={room} />
      {isTouch && portrait && !skipRotate && (
        <div className="absolute inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-grape p-6 text-center text-white">
          <div className="animate-wiggle text-7xl">📱</div>
          <div className="font-display text-3xl">휴대폰을 가로로 돌려 주세요</div>
          <div className="opacity-90">가로 화면에서 조이스틱과 점프 버튼이 넓게 보여요.</div>
          <button className="btn-ghost" onClick={() => setSkipRotate(true)}>세로로 계속하기</button>
        </div>
      )}
    </div>
  );
}
