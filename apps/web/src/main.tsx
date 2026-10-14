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
