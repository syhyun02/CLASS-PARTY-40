import { useEffect, useRef, useState } from 'react';
import { bindKeyboard, input, rotateCamera } from '../game/input';
import { useStore } from '../game/store';

const R = 56; // 조이스틱 반지름(px)

/**
 * 조작 레이어.
 * 터치: 화면 왼쪽 = 누른 자리에 생기는 조이스틱, 오른쪽 = 점프 버튼, 빈 곳을 끌면 카메라 회전
 * PC: WASD 이동, Space 점프, 마우스 끌기로 카메라 회전
 */
export function Controls({ action }: { action?: string }) {
  const isTouch = useStore((s) => s.isTouch);
  const [stick, setStick] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const stickId = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const camId = useRef<number | null>(null);
  const last = useRef({ x: 0, y: 0 });

  useEffect(() => bindKeyboard(), []);
  useEffect(() => () => { input.jx = 0; input.jy = 0; input.jump = false; input.action = false; input.grab = false; }, []);

  const down = (e: React.PointerEvent) => {
    const left = e.clientX < window.innerWidth * 0.45;
    if (isTouch && left && stickId.current === null) {
      stickId.current = e.pointerId;
      origin.current = { x: e.clientX, y: e.clientY };
      setStick({ x: e.clientX, y: e.clientY, dx: 0, dy: 0 });
    } else if (camId.current === null) {
      camId.current = e.pointerId;
      last.current = { x: e.clientX, y: e.clientY };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (e.pointerId === stickId.current) {
      let dx = e.clientX - origin.current.x, dy = e.clientY - origin.current.y;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      const dead = len < 8;
      input.jx = dead ? 0 : dx / R;
      input.jy = dead ? 0 : -dy / R;
      setStick({ ...origin.current, dx, dy });
    } else if (e.pointerId === camId.current) {
      rotateCamera(e.clientX - last.current.x, e.clientY - last.current.y);
      last.current = { x: e.clientX, y: e.clientY };
    }
  };
  const up = (e: React.PointerEvent) => {
    if (e.pointerId === stickId.current) { stickId.current = null; input.jx = 0; input.jy = 0; setStick(null); }
    if (e.pointerId === camId.current) camId.current = null;
  };

  const hold = (key: 'jump' | 'action' | 'grab') => ({
    onPointerDown: (e: React.PointerEvent) => { e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); input[key] = true; },
    onPointerUp: (e: React.PointerEvent) => { e.stopPropagation(); input[key] = false; },
    onPointerCancel: () => { input[key] = false; },
  });

  return (
    <div
      className="absolute inset-0 touch-none"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onContextMenu={(e) => e.preventDefault()}
    >
      {isTouch && !stick && (
        <div className="pointer-events-none absolute bottom-10 left-10 flex h-28 w-28 items-center justify-center rounded-full border-4 border-white/50 bg-white/15">
          <div className="h-12 w-12 rounded-full bg-white/50" />
        </div>
      )}
      {stick && (
        <div className="pointer-events-none absolute h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white/70 bg-white/20" style={{ left: stick.x, top: stick.y }}>
          <div className="absolute left-1/2 top-1/2 h-12 w-12 rounded-full bg-white shadow-popsm" style={{ transform: `translate(calc(-50% + ${stick.dx}px), calc(-50% + ${stick.dy}px))` }} />
        </div>
      )}
      {isTouch ? (
        <div className="absolute bottom-6 right-6 flex items-end gap-3" style={{ paddingRight: 'env(safe-area-inset-right)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="flex flex-col items-center gap-3">
            {action && (
              <button {...hold('action')} className="h-16 w-16 rounded-full bg-lemon font-display text-lg text-ink shadow-pop active:translate-y-1 active:shadow-none">{action}</button>
            )}
            {/* 잡기: 누르고 있는 동안 앞의 친구를 붙잡는다 */}
            <button {...hold('grab')} className="h-[4.5rem] w-[4.5rem] rounded-full bg-mint font-display text-xl text-ink shadow-pop active:translate-y-1 active:shadow-none">잡기</button>
          </div>
          <button {...hold('jump')} className="h-24 w-24 rounded-full bg-bubble font-display text-2xl text-white shadow-pop active:translate-y-1 active:shadow-none">점프</button>
        </div>
      ) : (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 chip opacity-80">
          WASD 이동 · Space 점프 · E 잡기{action ? ` · Shift ${action}` : ''} · 마우스 끌기 = 카메라
        </div>
      )}
    </div>
  );
}
