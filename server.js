'use strict';
// Dempo Learn — entry point.  Run:  node server.js   (Node.js 22.13 or newer, no npm install needed)
// Vercel also detects this file and runs it as-is (see README → Deploy to Vercel).
const path = require('node:path');
const { createApp } = require('./src/app');
const { seed } = require('./src/seed');

const ON_VERCEL = !!process.env.VERCEL;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (ON_VERCEL ? undefined : '127.0.0.1');
// Vercel's filesystem is read-only except /tmp, and /tmp is wiped when the app is recycled.
const DB_PATH = process.env.DB_PATH || (ON_VERCEL ? '/tmp/dempo.db' : path.join(__dirname, 'data', 'dempo.db'));
const DEMO_MODE = process.env.DEMO_MODE ? process.env.DEMO_MODE === '1' : ON_VERCEL;

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Dempo Learn needs Node.js 22.13 or newer (you have ${process.versions.node}).`);
  console.error('It uses the built-in node:sqlite module. Install Node 22 LTS or newer from https://nodejs.org');
  process.exit(1);
}

const { server, db } = createApp({ dbPath: DB_PATH, demoMode: DEMO_MODE });
if (seed(db)) console.log('First run: created demo accounts and courses (see README).');

server.listen(PORT, HOST, () => {
  console.log(`Dempo Learn is running at http://${HOST && HOST !== '0.0.0.0' ? HOST : 'localhost'}:${PORT}${DEMO_MODE ? ' (demo mode: data resets)' : ''}`);
  console.log('Demo logins — admin: admin@dempo.edu / admin123 · faculty: priya.naik@dempo.edu / faculty123 · student: aisha.dsouza@dempo.edu / 23CS001');
});
