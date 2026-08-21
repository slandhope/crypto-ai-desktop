/**
 * xAI Grok Agent — web / X / code tools via Responses API.
 * Keys stay server-side; called from /ai/grok-agent after credits check.
 */
const GROK_AGENT_MODEL = process.env.GROK_AGENT_MODEL || 'grok-4-3';
const GROK_API_URL = 'https://api.x.ai/v1/responses';

const TASK_PROMPTS = {
  research: `You are a research agent for Asuka (waifu.ai). Gather fresh facts from web and/or X.
Write in Asuka's warm, concise voice. 2-5 sentences for simple asks; bullets only if complex. Keep facts accurate.`,
  trading: `You are a crypto research agent for Asuka. Use web + X search for live narrative, news, CT sentiment.
Be honest, no hype. Asuka voice: brief, sharp, caring. Include catalysts and risks.`,
  study: `You are a study research agent. Find accurate, citable facts for the student's topic.
Return structured notes in plain language — definitions, steps, examples.`,
  general: `You are Asuka's research arm. Use tools as needed. Accurate, concise, warm tone.`,
};

function extractResponseText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text.trim();
  const chunks = [];
  for (const item of data.output || []) {
    if (typeof item === 'string') chunks.push(item);
    for (const block of item.content || []) {
      if (block.text) chunks.push(block.text);
      else if (block.type === 'output_text' && block.output_text) chunks.push(block.output_text);
    }
  }
  if (chunks.length) return chunks.join('\n').trim();
  const legacy = data.choices?.[0]?.message?.content;
  if (legacy) return String(legacy).trim();
  return '';
}

async function runGrokAgent({ apiKey, query, task = 'research', context = '' }) {
  if (!apiKey) throw new Error('grok_unavailable');
  const system = TASK_PROMPTS[task] || TASK_PROMPTS.general;
  const userContent = context
    ? `${system}\n\nContext:\n${String(context).slice(0, 8000)}\n\nTask:\n${query}`
    : `${system}\n\nTask:\n${query}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);

  try {
    const res = await fetch(GROK_API_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROK_AGENT_MODEL,
        input: [{ role: 'user', content: userContent }],
        tools: [
          { type: 'web_search' },
          { type: 'x_search' },
          { type: 'code_interpreter' },
        ],
      }),
      signal: controller.signal,
    });

    const raw = await res.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch {
      throw new Error('grok_bad_response');
    }

    if (!res.ok) {
      const msg = data?.error?.message || data?.error || data?.detail || ('HTTP ' + res.status);
      throw new Error(msg);
    }

    const text = extractResponseText(data);
    if (!text) throw new Error('grok_empty_response');

    return {
      text,
      model: GROK_AGENT_MODEL,
      citations: data.citations || [],
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Heuristic — should this user message use Grok research before/alongside Claude? */
function shouldUseGrokResearch(text = '') {
  const low = String(text).toLowerCase();
  if (low.length < 8) return false;

  const patterns = [
    /\b(ct|crypto twitter|on x\b|x\.com|twitter|tweet)\b/,
    /\b(what(?:'s| is) (?:ct|twitter|x) saying)\b/,
    /\b(people saying|sentiment|narrative|buzz|hype|fud)\b/,
    /\b(latest news|breaking|look up|search (?:the )?web|research|dig into)\b/,
    /\b(summarize .{0,40}(online|on the web|from x|from twitter))\b/,
    /\b(why is (?:everyone|ct|twitter).{0,30}(talking|pumping|dumping))\b/,
    /\b(investigate|find out|what happened with)\b/,
    /\b(compare .{0,30}(online|competitors|market))\b/,
    /\b(study research|research (?:this|topic|before))\b/,
    /\b(run the numbers|calculate|spreadsheet|csv)\b/,
  ];

  return patterns.some((re) => re.test(low));
}

function detectGrokTask(text = '') {
  const low = String(text).toLowerCase();
  if (/\b(study|homework|learn|teach me|lesson)\b/.test(low) && /\b(research|look up|find)\b/.test(low)) {
    return 'study';
  }
  if (/\b(btc|eth|sol|crypto|coin|token|pump|dump|trade|funding|liquidat)\b/.test(low)) {
    return 'trading';
  }
  return 'research';
}

module.exports = {
  runGrokAgent,
  shouldUseGrokResearch,
  detectGrokTask,
  GROK_AGENT_MODEL,
};
