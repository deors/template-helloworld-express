'use strict';

const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080;
const APP_NAME = process.env.APP_NAME || 'hello-world';
const APP_ENV = process.env.APP_ENV || 'local';
const IMAGE_TAG = process.env.IMAGE_TAG || 'dev';

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${APP_NAME}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e2e8f0;
    }
    .card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 1.5rem;
      padding: 3rem 4rem;
      text-align: center;
      max-width: 520px;
      width: 90%;
      backdrop-filter: blur(12px);
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
    }
    .logo { font-size: 3.5rem; margin-bottom: 1rem; }
    h1 {
      font-size: 2.2rem;
      font-weight: 700;
      background: linear-gradient(90deg, #60a5fa, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.5rem;
    }
    .tagline {
      color: #94a3b8;
      font-size: 1rem;
      margin-bottom: 2rem;
    }
    .meta {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .badge {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255, 255, 255, 0.07);
      border-radius: 0.75rem;
      padding: 0.6rem 1.2rem;
      font-size: 0.9rem;
    }
    .badge-label { color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.75rem; }
    .badge-value { font-weight: 600; color: #f1f5f9; font-family: 'Cascadia Code', 'Fira Code', monospace; }
    .env-pill {
      display: inline-block;
      padding: 0.2rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .env-dev    { background: #16a34a22; color: #4ade80; border: 1px solid #16a34a55; }
    .env-staging{ background: #ca8a0422; color: #fbbf24; border: 1px solid #ca8a0455; }
    .env-prod   { background: #dc262622; color: #f87171; border: 1px solid #dc262655; }
    .env-local  { background: #7c3aed22; color: #a78bfa; border: 1px solid #7c3aed55; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#128640;</div>
    <h1>Hello, World!</h1>
    <p class="tagline">Your app is running.</p>
    <div class="meta">
      <div class="badge">
        <span class="badge-label">Application</span>
        <span class="badge-value">${APP_NAME}</span>
      </div>
      <div class="badge">
        <span class="badge-label">Environment</span>
        <span class="env-pill env-${APP_ENV}">${APP_ENV}</span>
      </div>
      <div class="badge">
        <span class="badge-label">Image Tag</span>
        <span class="badge-value">${IMAGE_TAG}</span>
      </div>
    </div>
  </div>
</body>
</html>`);
});

app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

app.get('/whois', (_req, res) => {
  res.json({
    app_name: APP_NAME,
    environment: APP_ENV,
    image_tag: IMAGE_TAG,
  });
});

const server = app.listen(PORT, () => {
  console.log(`${APP_NAME} listening on port ${PORT} [env=${APP_ENV} tag=${IMAGE_TAG}]`);
});

module.exports = { app, server };
