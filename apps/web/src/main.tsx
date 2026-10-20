import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { NexaShareApp } from './pages/NexaShareApp';


const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <NexaShareApp />
    </React.StrictMode>
  );
}

// Register PWA Service Worker in production
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        console.log('NexaShare PWA ServiceWorker registered:', reg.scope);
        reg.update();
      })
      .catch((err) => console.warn('NexaShare PWA ServiceWorker failed:', err));
  });
}
