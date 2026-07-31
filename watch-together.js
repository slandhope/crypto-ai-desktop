// ═══════════════════════════════════════════════════════════════════
// 👀 WATCH TOGETHER — Hakko-style (live screen → Gemini Live VLM)
// No screenshots. Screen is streamed as video frames into Gemini Live,
// same as Hakko's real-time VLM + voice. She sees and talks naturally.
// Say: "watch with me" · "watch this game" · "stop watching my screen"
// ═══════════════════════════════════════════════════════════════════

let deps = null;
let active = false;
let mode = 'general';

const MODE_INSTRUCTIONS = {
  game: `WATCH TOGETHER — GAME MODE (live screen video feed):
You can SEE their game in real time. Be their co-pilot — short voice reactions, hints when stuck, hype on good plays. Like a friend on Discord watch party. Don't narrate every frame. Speak when it matters. Max 1-2 sentences.`,
  movie: `WATCH TOGETHER — MOVIE/SHOW MODE (live screen video feed):
You are on the couch watching WITH them. Warm brief reactions, theories, jokes at plot twists. Like texting a friend during a film. Never long recaps unless they ask.`,
  youtube: `WATCH TOGETHER — YOUTUBE MODE (live screen video feed):
You see the video live. Comment naturally — funny, curious, supportive. React to what's happening on screen.`,
  general: `WATCH TOGETHER (live screen video feed):
You see their screen in real time. Keep them company — helpful or warm comments when something happens. Stay present like Hakko.`,
};

function init(d) { deps = d; }

function isActive() { return active; }

function getModeInstruction(m) {
  return MODE_INSTRUCTIONS[m] || MODE_INSTRUCTIONS.general;
}

function notifyWaifu(event, payload) {
  const win = deps?.getMainWindow?.();
  if (win && !win.isDestroyed()) win.webContents.send(event, payload);
}

function startWatch(newMode = 'general') {
  if (!deps) return { ok: false };
  mode = MODE_INSTRUCTIONS[newMode] ? newMode : 'general';
  active = true;
  const s = deps.loadSettings();
  s.watchTogether = { ...(s.watchTogether || {}), enabled: true, mode };
  deps.saveSettings(s);
  notifyWaifu('watch-together-start', { mode, instruction: getModeInstruction(mode) });
  console.log(`Watch Together ON (${mode})`);
  return { ok: true, mode };
}

function stopWatch() {
  active = false;
  if (deps) {
    const s = deps.loadSettings();
    s.watchTogether = { ...(s.watchTogether || {}), enabled: false };
    deps.saveSettings(s);
  }
  notifyWaifu('watch-together-stop', {});
  console.log('Watch Together OFF');
  return { ok: true };
}

function setMode(m) {
  if (!MODE_INSTRUCTIONS[m]) return { ok: false };
  mode = m;
  if (active) {
    const s = deps.loadSettings();
    s.watchTogether = { ...(s.watchTogether || {}), mode: m };
    deps.saveSettings(s);
    notifyWaifu('watch-together-start', { mode: m, instruction: getModeInstruction(m) });
  }
  return { ok: true, mode };
}

function registerIpc(ipcMain) {
  ipcMain.handle('watch-together-status', () => ({ active, mode }));
  ipcMain.handle('watch-together-start', (e, m) => startWatch(m || 'general'));
  ipcMain.handle('watch-together-stop', () => stopWatch());
  ipcMain.handle('watch-together-set-mode', (e, m) => setMode(m));
  ipcMain.handle('watch-together-mode-prompt', (e, m) => getModeInstruction(m || mode));
}

function restoreOnBoot() {
  setTimeout(() => {
    try {
      const s = deps.loadSettings();
      if (s.watchTogether?.enabled) startWatch(s.watchTogether.mode || 'general');
    } catch (e) {}
  }, 4000);
}

module.exports = { init, registerIpc, startWatch, stopWatch, setMode, isActive, restoreOnBoot, getModeInstruction };
