import { useEffect, useState } from 'react';
import { net } from './game/net';
import { useStore } from './game/store';
import { HostScreen } from './ui/HostScreen';
import { PlayScreen } from './ui/PlayScreen';
import { Home, HostSetup, Join } from './ui/Screens';

export default function App() {
  const screen = useStore((s) => s.screen);
  const [ready, setReady] = useState(false);
  const urlCode = new URLSearchParams(location.search).get('code')?.replace(/\D/g, '').slice(0, 6) ?? '';

  useEffect(() => {
    // 새로고침했으면 원래 자리로 돌아가고, QR로 들어왔으면 입장 화면부터 보여 준다
    net.restore().then((ok) => {
      if (!ok && urlCode) useStore.setState({ screen: 'join' });
      setReady(true);
    });
  }, []);

  if (!ready) return <div className="party-bg flex h-full items-center justify-center font-display text-2xl">CLASS PARTY 40</div>;
  if (screen === 'play') return <PlayScreen />;
  if (screen === 'host') return <HostScreen />;
  if (screen === 'hostSetup') return <HostSetup />;
  if (screen === 'join') return <Join initialCode={urlCode} />;
  return <Home />;
}
