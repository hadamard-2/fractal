/**
 * This file is automatically loaded by Vite and runs in the "renderer" context.
 * Node.js integration is disabled here; anything needing main-process privileges
 * goes through the `contextBridge` surface defined in `preload.ts`.
 *
 * https://electronjs.org/docs/tutorial/process-model
 */

import { createRoot } from 'react-dom/client';
import App from './App';
import { initThemeSync } from './renderer/theme';
import './index.css';

// Before the first render: puts the `dark` class on <html> from the
// prefers-color-scheme query so first paint is already in the right theme.
initThemeSync();

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root container #root not found in index.html');
}

createRoot(container).render(<App />);
