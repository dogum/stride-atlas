import '@fontsource-variable/overpass';
import '@fontsource-variable/public-sans';
import '@fontsource-variable/overpass-mono';
import './style.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);

// dev-only handle for debugging in the browser console
if (import.meta.env.DEV) import('./store').then(m => { (window as any).__stride = m; });
