import { createRoot } from 'react-dom/client';
import App from './App';
import { initSoundEvents } from './game/sound';
import './index.css';

initSoundEvents();

createRoot(document.getElementById('root')!).render(<App />);
