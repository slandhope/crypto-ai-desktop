// ═══════════════════════════════════════════════════════════════════
// 🎬 VIDEO LESSONS — ThetaWise-style rendered lessons, fully local
// Pipeline: topic → Claude fills a scene spec → Manim renders MP4
//           → ElevenLabs narration → ffmpeg mux → ~/AsukaVideos/*.mp4
// Requires once:  pip3 install manim   +   brew install ffmpeg
// Registered from main.js:  require('./video-lessons')(ipcMain, deps)
// ═══════════════════════════════════════════════════════════════════
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const VIDEOS_DIR = path.join(os.homedir(), 'AsukaVideos');
const TEMPLATE_SRC = path.join(__dirname, 'manim_templates.py');

const SPEC_SYSTEM = `You are a lesson director. Produce ONLY valid JSON (no markdown fences) for a short educational video, following this exact schema:
{"title": str, "narration": str, "scenes": [Scene, ...]}
Scene types (use 4-7 scenes total):
{"type":"title","title":str,"subtitle":str,"duration":num}
{"type":"equation","equation":str,"terms":[{"symbol":str,"means":str}],"duration":num}   // plain text equation like "F = m × a", max 4 terms
{"type":"bullets","heading":str,"points":[str,...],"duration":num}                        // max 5 points, each under 70 chars
{"type":"graph","title":str,"x_range":[a,b],"y_range":[a,b],"curves":[{"expr":str,"label":str}],"duration":num}  // expr is python math in x, e.g. "x**2", "sin(x)", max 3 curves
{"type":"diagram","title":str,"nodes":[str,...],"duration":num}                           // flow of max 4 short nodes
{"type":"compare","title":str,"left_title":str,"left":[str],"right_title":str,"right":[str],"duration":num}
Rules:
- durations: 4-10 seconds per scene; total 45-120 seconds.
- narration: a warm spoken script matching the scenes in order, ~2.3 words per second of total duration (e.g. 90s total → ~200 words). Friendly, clear, like a caring tutor named Asuka. No stage directions.
- Keep every string SHORT so it fits on screen. No LaTeX, no special unicode beyond × ÷ ² ³ π Δ.
- Educational accuracy is paramount.`;

function ensureDirs() { if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true }); }

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout || 300000, ...opts },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function findPython() {
  for (const p of ['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
    const r = await run(p, ['-c', 'import manim; print("ok")'], { timeout: 20000 });
    if (!r.err && r.stdout.includes('ok')) return p;
  }
  return null;
}

async function findFfmpeg() {
  for (const p of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    const r = await run(p, ['-version'], { timeout: 10000 });
    if (!r.err) return p;
  }
  return null;
}

function elevenLabsTTS(text, outPath) {
  return new Promise((resolve, reject) => {
    const key = process.env.ELEVENLABS_API_KEY;
    const voice = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    if (!key) return reject(new Error('no ELEVENLABS_API_KEY'));
    const body = JSON.stringify({
      text: text.slice(0, 4800),
      model_id: 'eleven_flash_v2_5',
      voice_settings: { stability: 0.55, similarity_boost: 0.8, speed: 0.98 },
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io', path: `/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('TTS HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { fs.writeFileSync(outPath, Buffer.concat(chunks)); resolve(outPath); });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function generateSpec(anthropic, topic, prevError, prevSpec) {
  const messages = [{ role: 'user', content: `Make a video lesson spec about: ${topic}` }];
  if (prevError && prevSpec) {
    messages.push({ role: 'assistant', content: prevSpec });
    messages.push({ role: 'user', content: `That spec failed to render with this error, fix the spec (output full corrected JSON only):\n${String(prevError).slice(0, 1500)}` });
  }
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 3000, system: SPEC_SYSTEM, messages,
  });
  let txt = res.content?.[0]?.text?.trim() || '';
  txt = txt.replace(/^```(json)?/g, '').replace(/```$/g, '').trim();
  const spec = JSON.parse(txt); // throws if invalid — caught by caller
  if (!Array.isArray(spec.scenes) || !spec.scenes.length || !spec.narration) throw new Error('spec missing scenes/narration');
  return { spec, raw: txt };
}

async function renderLesson({ anthropic, topic, onProgress }) {
  const progress = (m) => { try { onProgress && onProgress(m); } catch (e) {} };
  ensureDirs();

  const python = await findPython();
  if (!python) return { error: 'manim_missing', hint: 'Run in Terminal:  pip3 install manim   (then restart the app)' };
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return { error: 'ffmpeg_missing', hint: 'Run in Terminal:  brew install ffmpeg   (then restart the app)' };
  if (!fs.existsSync(TEMPLATE_SRC)) return { error: 'template_missing', hint: 'manim_templates.py not found next to main.js' };

  const job = path.join(os.tmpdir(), 'asuka-video-' + Date.now());
  fs.mkdirSync(job, { recursive: true });
  fs.copyFileSync(TEMPLATE_SRC, path.join(job, 'manim_templates.py'));

  // ── spec generation + render with retry loop (the hard 20%) ──
  let spec = null, raw = null, lastErr = null, videoPath = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    progress(attempt === 1 ? '🎬 writing the lesson…' : `🔧 fixing and retrying (${attempt}/3)…`);
    try { const g = await generateSpec(anthropic, topic, lastErr, raw); spec = g.spec; raw = g.raw; }
    catch (e) { lastErr = 'spec JSON invalid: ' + e.message; continue; }

    fs.writeFileSync(path.join(job, 'spec.json'), JSON.stringify(spec));
    progress('🎨 rendering scenes… (this takes a minute or two)');
    const r = await run(python, ['-m', 'manim', 'render', '-qm', '--disable_caching',
      '--media_dir', job, '-o', 'lesson.mp4', 'manim_templates.py', 'Lesson'],
      { cwd: job, timeout: 480000 });

    // find output
    const candidates = [];
    const walk = (d) => { try { for (const f of fs.readdirSync(d)) { const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p); else if (f === 'lesson.mp4') candidates.push(p); } } catch (e) {} };
    walk(job);
    if (candidates.length) { videoPath = candidates[0]; break; }
    lastErr = (r.stderr || r.stdout || 'unknown render error').split('\n').filter(l => /error|Error|Traceback|line \d+/.test(l)).slice(-12).join('\n') || 'render produced no file';
  }
  if (!videoPath) { return { error: 'render_failed', detail: String(lastErr).slice(0, 600) }; }

  // ── narration + mux ──
  let finalPath = path.join(VIDEOS_DIR, (spec.title || topic).replace(/[^\w\s-]/g, '').trim().slice(0, 50).replace(/\s+/g, '_') + '_' + Date.now() + '.mp4');
  try {
    progress('🎙️ recording narration…');
    const narr = path.join(job, 'narration.mp3');
    await elevenLabsTTS(spec.narration, narr);
    progress('🎞️ putting it together…');
    const mux = await run(ffmpeg, ['-y', '-i', videoPath, '-i', narr,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', finalPath], { timeout: 120000 });
    if (mux.err || !fs.existsSync(finalPath)) { fs.copyFileSync(videoPath, finalPath); }
  } catch (e) {
    // narration failed — ship silent video rather than nothing
    try { fs.copyFileSync(videoPath, finalPath); } catch (e2) { return { error: 'output_failed', detail: e2.message }; }
  }

  try { fs.rmSync(job, { recursive: true, force: true }); } catch (e) {}
  // remember for chat-alongside-video ("what did the second graph mean?")
  try { global._lastVideoLesson = { title: spec.title || topic, narration: spec.narration || '',
    scenesSummary: (spec.scenes || []).map((s, i) => `${i+1}. ${s.type}: ${s.title || s.heading || s.equation || (s.points||[]).join('; ') || ''}`).join(' | ').slice(0, 900) }; } catch (e) {}
  return { ok: true, path: finalPath, title: spec.title || topic };
}

module.exports = function registerVideoLessons(ipcMain, deps) {
  const { getAnthropicClient, getMainWindow, recordWork } = deps;
  let busy = false;
  ipcMain.handle('make-video-lesson', async (e, { topic }) => {
    if (busy) return { error: 'busy', hint: 'A video is already rendering — one at a time~' };
    if (!topic || !String(topic).trim()) return { error: 'no_topic' };
    busy = true;
    try {
      const result = await renderLesson({
        anthropic: getAnthropicClient(),
        topic: String(topic).trim().slice(0, 200),
        onProgress: (m) => { try { const w = getMainWindow(); if (w && !w.isDestroyed()) w.webContents.send('video-lesson-progress', m); } catch (err) {} },
      });
      if (result.ok && recordWork) {
        try { recordWork({ kind: 'video', title: '🎬 ' + result.title, path: result.path }); } catch (err) {}
        try { require('electron').shell.openPath(result.path); } catch (err) {}
      }
      return result;
    } finally { busy = false; }
  });
  console.log('🎬 Video lessons registered');
};
