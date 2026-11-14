// The two demo pages: index.html (the map fills the page) and embed.html
// (the widget inside an article column).

import { mountDispatchLab } from './index';
import './ui/dispatch-lab.css';

const root = document.getElementById('lab') as HTMLElement;
const embedded = location.pathname.endsWith('embed.html');
const mounted = mountDispatchLab(root, {
  dataUrl: `${import.meta.env.BASE_URL}data/`,
  autostart: !embedded,
  wheelZoom: embedded ? 'modifier' : 'always',
});

document.getElementById('theme')?.addEventListener('click', () => {
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark';
});
document.getElementById('remove')?.addEventListener('click', () => mounted.destroy());
