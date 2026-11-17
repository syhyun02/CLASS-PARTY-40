/** 조이스틱·키보드·카메라 드래그 입력을 한곳에 모은다. 렌더 루프가 매 프레임 읽어 간다. */
export const input = {
  jx: 0, jy: 0, // 조이스틱(오른쪽 +, 위 +)
  jump: false,
  action: false,
  grab: false,
  camYaw: 0, // 0 = +z를 바라봄
  camPitch: 0.42,
  keys: new Set<string>(),
};

export function resetCamera() { input.camYaw = 0; input.camPitch = 0.42; }

export function rotateCamera(dx: number, dy: number) {
  input.camYaw -= dx * 0.006;
  input.camPitch = Math.max(0.12, Math.min(1.1, input.camPitch + dy * 0.004));
}

/** 카메라 기준 입력을 월드 방향으로 바꾼다. */
export function worldMove(): { mx: number; mz: number } {
  let x = input.jx, y = input.jy;
  const k = input.keys;
  if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
  if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
  if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
  if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  const s = Math.sin(input.camYaw), c = Math.cos(input.camYaw);
  // 앞 = (sin, cos), 화면 오른쪽 = (-cos, sin)
  return { mx: s * y - c * x, mz: c * y + s * x };
}

export const jumpHeld = () => input.jump || input.keys.has('Space');
export const actionHeld = () => input.action || input.keys.has('ShiftLeft') || input.keys.has('ShiftRight');
export const grabHeld = () => input.grab || input.keys.has('KeyE') || input.keys.has('KeyF');

export function bindKeyboard() {
  const down = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    input.keys.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  };
  const up = (e: KeyboardEvent) => input.keys.delete(e.code);
  const blur = () => { input.keys.clear(); input.jump = false; input.action = false; input.grab = false; input.jx = 0; input.jy = 0; };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
}
