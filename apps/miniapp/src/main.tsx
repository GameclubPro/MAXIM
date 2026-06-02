import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app';
import { traceMiniappBoot } from './lib/boot-trace';
import './styles.css';

traceMiniappBoot('index_loaded', undefined, { once: true });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
