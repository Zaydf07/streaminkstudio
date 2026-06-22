require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const cheerio  = require('cheerio');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const cors     = require('cors');

const app  = express();
const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   CORS
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, curl, Postman)
    if (!origin) return cb(null, true);
    // Allow everything in dev (no ALLOWED_ORIGIN set)
    if (!ALLOWED_ORIGINS.length) return cb(null, true);
    // Allow any netlify.app subdomain + listed origins
    if (ALLOWED_ORIGINS.some(o => o === origin) ||
        /\.netlify\.app$/.test(origin) ||
        /\.onrender\.com$/.test(origin)) {
      return cb(null, true);
    }
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-admin-secret'],
  credentials: true,
}));

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   SECURITY HEADERS
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',    'nosniff');
  res.setHeader('X-Frame-Options',           'SAMEORIGIN');
  res.setHeader('X-XSS-Protection',          '1; mode=block');
  res.setHeader('Referrer-Policy',           'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',        'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   RATE LIMITER  (in-memory, per IP)
   Limits: 60 req/min general,
           10 req/min for AI endpoints
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const rateBuckets = new Map();

function rateLimit(maxPerMinute) {
  return (req, res, next) => {
    const ip  = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}:${Math.floor(Date.now() / 60000)}`;
    const count = (rateBuckets.get(key) || 0) + 1;
    rateBuckets.set(key, count);
    // Clean old keys every 5 min
    if (count === 1) setTimeout(() => rateBuckets.delete(key), 5 * 60 * 1000);
    if (count > maxPerMinute) {
      return res.status(429).json({ error: 'Too many requests â€” please wait a moment.' });
    }
    next();
  };
}

const generalLimit = rateLimit(60);
const aiLimit      = rateLimit(10);

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   AUTH MIDDLEWARE
   Verifies Supabase JWT from Bearer token.
   Falls through in dev mode (no Supabase).
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
async function requireAuth(req, res, next) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  // Dev mode â€” Supabase not configured, skip auth
  if (!supabaseUrl || !supabaseKey) {
    req.userId    = 'dev-user';
    req.userEmail = 'dev@localhost';
    return next();
  }

  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supabaseKey },
    });
    if (!r.ok) return res.status(401).json({ error: 'Invalid or expired session â€” please sign in again' });
    const user = await r.json();
    req.userId    = user.id;
    req.userEmail = user.email;
    req.userToken = token;
    next();
  } catch (e) {
    console.error('[auth]', e.message);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   CREDIT ENFORCEMENT
   cost = credits this call will spend.
   Checks subscription, blocks if over limit,
   deducts after the response is sent.
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const CREDIT_COSTS = {
  blog:          15,
  article:       10,
  email:          8,
  social:         3,
  pdf_export:     5,
  refine:         2,
  script_outline: 12,
  script_scene:   8,
  book_outline:   10,
  book_chapter:   12,
};

function checkCredits(cost, engine) {
  return async (req, res, next) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey || req.userId === 'dev-user') return next();

    try {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/subscriptions?user_id=eq.${req.userId}&select=id,credits_used,credits_limit,plan`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${req.userToken}` } }
      );
      const [sub] = await r.json();
      if (!sub) return res.status(402).json({ error: 'No subscription found. Please sign up.' });

      // -1 = unlimited (Agency plan)
      if (sub.credits_limit !== -1 && sub.credits_used + cost > sub.credits_limit) {
        return res.status(402).json({
          error:        'Monthly credit limit reached',
          creditsUsed:  sub.credits_used,
          creditsLimit: sub.credits_limit,
          plan:         sub.plan,
          upgradeUrl:   '/pricing',
        });
      }
      req.creditCost    = cost;
      req.creditEngine  = engine || 'unknown';
      req.subscriptionId = sub.id;
      next();
    } catch (e) {
      console.error('[credits]', e.message);
      next(); // Don't block on credit check failure â€” fail open
    }
  };
}

async function deductCredits(req) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey || !req.subscriptionId || !req.creditCost) return;
  try {
    // 1. Atomically increment credits_used
    await fetch(`${supabaseUrl}/rest/v1/rpc/increment_credits_used`, {
      method: 'POST',
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user_id: req.userId, p_amount: req.creditCost }),
    });
    // 2. Log to usage_logs so admin activity log populates
    await fetch(`${supabaseUrl}/rest/v1/usage_logs`, {
      method: 'POST',
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: req.userId, engine: req.creditEngine || 'unknown', credits: req.creditCost }),
    });
  } catch (e) {
    console.error('[deduct-credits]', e.message);
  }
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   PERSISTENT OAUTH STATE STORE
   File-backed so it survives restarts.
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const OAUTH_STATE_FILE = path.join(__dirname, '.oauth-state.json');

function loadOAuthState() {
  try { return JSON.parse(fs.readFileSync(OAUTH_STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveOAuthState(store) {
  try { fs.writeFileSync(OAUTH_STATE_FILE, JSON.stringify(store)); } catch(e) { console.warn('[oauth-state]', e.message); }
}

const oauthStateStore = {
  set(key, val) {
    const s = loadOAuthState();
    s[key] = { val, exp: Date.now() + 10 * 60 * 1000 }; // 10 min TTL
    saveOAuthState(s);
  },
  get(key) {
    const s = loadOAuthState();
    const entry = s[key];
    if (!entry || entry.exp < Date.now()) return undefined;
    return entry.val;
  },
  delete(key) {
    const s = loadOAuthState();
    delete s[key];
    saveOAuthState(s);
  },
};

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   MULTER  â€“ save uploaded images
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_')),
});
const upload = multer({ storage });

function saveGeneratedImage(buffer, ext = 'png') {
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
  const filename = `${Date.now()}-ai-background.${safeExt}`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  return `/uploads/${filename}`;
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   STATIC
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.use(express.json());

/* inject Supabase public keys to frontend */
app.get('/js/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.STREAMINK_CONFIG=${JSON.stringify({
    supabaseUrl:     process.env.SUPABASE_URL      || '',
    supabaseKey:     process.env.SUPABASE_ANON_KEY || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  })};`);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   PAGES
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/',                  (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/blog-templates',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'blog-templates.html')));
app.get('/editor',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'editor.html')));
app.get('/magazine',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'magazine.html')));
app.get('/article-templates', (req, res) => res.sendFile(path.join(__dirname, 'public', 'article-templates.html')));
app.get('/article-editor',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'article-editor.html')));
app.get('/dashboard',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/social-editor',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'social-editor.html')));
app.get('/email-editor',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'email-editor.html')));
app.get('/social-templates',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'social-templates.html')));
app.get('/brand-kit',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'brand-kit.html')));
app.get('/pricing',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));
app.get('/settings',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/login',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
/* seo-tools and calendar removed â€” functionality merged into editors */
app.get('/book-writer',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'book-writer.html')));
app.get('/script-writer',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'script-writer.html')));
/* /templates â€” redirect to content-type hub (blog-templates as default) */
app.get('/templates', (req, res) => res.redirect('/blog-templates'));

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: templates
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/templates', (req, res) => {
  res.json([
    { id: 'center-hero',   name: 'Center Hero',   mode: 'single'   },
    { id: 'hero-article',  name: 'Hero Article',  mode: 'single'   },
    { id: 'grid-magazine', name: 'Grid Magazine', mode: 'magazine' },
  ]);
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   HELPERS
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
async function fetchSiteData(url) {
  try {
    const res  = await fetch(url, { timeout: 15000 });
    const html = await res.text();
    const $    = cheerio.load(html);

    $('script, style').remove();

    const title = $('title').text().trim();
    const h1    = $('h1').first().text().trim();
    const text  = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 4000);

    const emailRx = /([\w.-]+@[\w.-]+\.\w+)/g;
    const phoneRx = /(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/g;

    const emails = [...new Set([...text.matchAll(emailRx)].map(m => m[1]))];
    const phones = [...new Set([...text.matchAll(phoneRx)].map(m => m[1]))];

    return { practice_name: h1 || title, text, emails, phones };
  } catch {
    return {};
  }
}

async function callGroq(prompt, maxTokens = 4096, temperature = 0.7) {
  const apiUrl = process.env.GROQ_API_URL;
  const apiKey = process.env.GROQ_API_KEY;
  const model  = process.env.GROQ_MODEL;

  if (!apiUrl || !apiKey || !model) {
    throw new Error('Groq API not configured â€” set GROQ_API_URL, GROQ_API_KEY, and GROQ_MODEL in your .env file');
  }

  const attempt = async () => {
    const res = await fetch(apiUrl, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages:    [{ role: 'user', content: prompt }],
        max_tokens:  maxTokens,
        temperature,
      }),
    });

    if (res.status === 429) return { retry: true };

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Groq ${res.status}: ${body.substring(0, 300)}`);
    }

    const data = await res.json();
    return { content: data.choices?.[0]?.message?.content?.trim() || '' };
  };

  let result = await attempt();
  if (result.retry) {
    // Rate limited â€” wait 4 s then retry once
    await new Promise(resolve => setTimeout(resolve, 4000));
    result = await attempt();
  }
  if (result.retry) throw new Error('Groq rate limit exceeded â€” please wait a moment and try again');

  return result.content;
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   JSON HELPERS
   Strip markdown fences, extract the
   first JSON object or array, and parse
   with a lightweight repair pass.
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function cleanJson(str) {
  if (!str) return '';
  // Remove markdown code fences (```json ... ``` or ``` ... ```)
  str = str.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const obj = str.match(/\{[\s\S]*\}/);
  const arr = str.match(/\[[\s\S]*\]/);
  if (!obj && !arr) return str;
  if (obj && arr) return obj.index <= arr.index ? obj[0] : arr[0];
  return (obj || arr)[0];
}

function safeParseJson(str) {
  const cleaned = cleanJson(str);
  try {
    return JSON.parse(cleaned);
  } catch {
    // Lightweight repair: trailing commas, unquoted keys
    try {
      const repaired = cleaned
        .replace(/,(\s*[}\]])/g, '$1')
        .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
      return JSON.parse(repaired);
    } catch (e) {
      throw new Error(`Could not parse AI response as JSON: ${e.message}`);
    }
  }
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: generate
   Accepts: multipart/form-data
   Fields : url, topic, brief, tone,
            length, template,
            images[] (files)
            section_1..3  (magazine)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/generate', requireAuth, aiLimit, checkCredits(CREDIT_COSTS.blog,'blog'), upload.any(), async (req, res) => {
  try {
    const body = req.body;

    const url        = body.url        || '';
    const topic      = body.topic      || '';
    const brief      = body.brief      || '';
    const tone       = body.tone       || 'professional';
    const length     = body.length     || 'medium';
    const wordCount  = parseInt(body.wordCount) || 0;
    const templateId = body.template   || '';

    /* uploaded image URLs */
    const imgs = (req.files || []).map(f => `/uploads/${f.filename}`);

    /* site data */
    const site     = url ? await fetchSiteData(url) : {};
    const practice = site.practice_name || (url ? new URL(url).hostname : '');
    const pageText = site.text  || '';
    const phones   = (site.phones  || []).join(', ');
    const emails   = (site.emails  || []).join(', ');

    /* tones */
    const toneMap = {
      professional:   'Write in a clear, formal, trustworthy professional tone.',
      friendly:       'Write in a warm, friendly, approachable tone.',
      storytelling:   'Write using engaging storytelling with smooth transitions.',
      persuasive:     'Write persuasively, highlighting benefits and encouraging action.',
      educational:    'Write in an educational tone, explaining concepts clearly.',
      luxury:         'Write in a premium, elegant, high-end luxury tone.',
      authoritative:  'Write in a confident, authoritative expert tone.',
      conversational: 'Write in a natural, conversational tone as if speaking directly to the reader.',
      empathetic:     'Write with empathy, understanding reader concerns and emotions.',
      bold:           'Write in a bold, confident, high-impact tone.',
    };

    const lengthMap = {
      short:  'Keep the article concise (300â€“400 words).',
      medium: 'Write a detailed article (600â€“800 words).',
      long:   'Write an in-depth, comprehensive article (1000â€“1200 words).',
    };

    const toneInstruction   = toneMap[tone]   || toneMap.professional;
    const lengthInstruction = wordCount
      ? `Write the article in approximately ${wordCount} words (target Â±10%).`
      : (lengthMap[length] || lengthMap.medium);

    /* shared base context for all prompts */
    const baseCtx = `
TONE: ${toneInstruction}
LENGTH: ${lengthInstruction}
OPTIONAL BRIEF: ${brief}
BUSINESS: ${practice}
PHONE: ${phones}
EMAIL: ${emails}
SOURCE CONTENT: ${pageText}
TOPIC: ${topic}
RULES: Output clean HTML only. No inline styles. No markdown fences.`.trim();

    const heroImg = imgs[0] || '';

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       GRID MAGAZINE
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'grid-magazine') {
      const sections = [1, 2, 3].map(i => body[`section_${i}`]).filter(Boolean);
      const sectionOutputs = await Promise.all(
        sections.map(title => callGroq(
          `Write 1â€“2 concise HTML paragraphs ONLY about: "${title}". Output ONLY <p> tags. Be specific and benefit-focused.`, 800
        ))
      );
      const grid = sections.map((title, i) => {
        const img  = imgs[i] ? `<img src="${imgs[i]}" alt="${title}">` : '';
        return `
<div class="tpl-mag-col">
  <div class="tpl-mag-sub be-editable" contenteditable="true">${title}</div>
  <div class="tpl-mag-image-wrap">${img}</div>
  <div class="tpl-mag-text be-editable" contenteditable="true">${sectionOutputs[i] || ''}</div>
</div>`;
      }).join('\n');
      return res.json({ article: `
<article class="be-magazine">
  <h1 class="be-editable" contenteditable="true">${topic}</h1>
  <div class="tpl-mag-grid">${grid}</div>
</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       CENTER HERO
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'center-hero') {
      let html = await callGroq(`${baseCtx}\nWrite a blog article about: ${topic}. Start with an <h1> title. Promote the business. End with a CTA.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      const h1Match = html.match(/<h1[^>]*>.*?<\/h1>/is);
      html = html.replace(/<h1[^>]*>.*?<\/h1>/is, '');
      return res.json({ article: `<article class="be-center-hero">
${heroImg ? `<img src="${heroImg}" class="be-img-center be-img-100" alt="">` : ''}
${h1Match ? h1Match[0] : ''}
${html.trim()}
</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       HERO ARTICLE
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'hero-article') {
      let html = await callGroq(`${baseCtx}\nWrite a blog article about: ${topic}. Start with an <h1> title. Include subheadings. Promote the business. End with a CTA.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      if (heroImg) html = html.replace(/(<h1[^>]*>.*?<\/h1>)/is, `$1\n<img src="${heroImg}" class="be-img-right be-img-50" alt="">`);
      return res.json({ article: `<article class="be-hero-article">${html}</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       SPLIT FEATURE  (image left | content right)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'split-feature') {
      let html = await callGroq(`${baseCtx}\nWrite a punchy feature article about: ${topic}.
- Start with <h1> headline
- Follow with a short <p class="sf-lead"> lead paragraph (2â€“3 sentences)
- Then 3â€“4 regular <p> paragraphs
- End with a <p class="sf-cta"> call-to-action sentence
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      const imgHtml = heroImg ? `<img src="${heroImg}" alt="${topic}">` : '<div class="sf-img-placeholder">Add Image</div>';
      return res.json({ article: `<article class="be-split-feature">
  <div class="sf-image">${imgHtml}</div>
  <div class="sf-content">${html.trim()}</div>
</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       FULL WIDTH  (full-bleed hero + text overlay)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'full-width') {
      let html = await callGroq(`${baseCtx}\nWrite a compelling article about: ${topic}.
- Start with <h1> headline (short, punchy, max 10 words)
- Then <p class="fw-tagline"> one powerful tagline sentence
- Then 4â€“5 <p> body paragraphs
- End with <p class="fw-cta"> strong CTA
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      const h1M  = html.match(/<h1[^>]*>.*?<\/h1>/is);
      const tagM = html.match(/<p class="fw-tagline">.*?<\/p>/is);
      let body   = html.replace(/<h1[^>]*>.*?<\/h1>/is,'').replace(/<p class="fw-tagline">.*?<\/p>/is,'').trim();
      return res.json({ article: `<article class="be-full-width">
  <div class="fw-hero"${heroImg ? ` style="background-image:url('${heroImg}')"` : ''}>
    <div class="fw-overlay">
      ${h1M  ? h1M[0]  : `<h1>${topic}</h1>`}
      ${tagM ? tagM[0] : ''}
    </div>
  </div>
  <div class="fw-body">${body}</div>
</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       NEWS COLUMNS  (newspaper masthead + columns)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'news-columns') {
      let html = await callGroq(`${baseCtx}\nWrite a news-style article about: ${topic}.
- Start with <h1> bold headline
- Then <p class="nc-byline">By ${practice || 'Staff Reporter'}</p>
- Then a <p class="nc-lead"><strong>LEAD:</strong> ... strong opening paragraph</p>
- Then 5â€“6 concise <p> news-style body paragraphs (short sentences, inverted pyramid)
- End with <p class="nc-dateline"> one closing quote or stat
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      const today = new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
      return res.json({ article: `<article class="be-news-columns">
  <div class="nc-masthead">
    <span class="nc-pub">StreamInk Daily</span>
    <span class="nc-date">${today}</span>
    <span class="nc-edition">Digital Edition</span>
  </div>
  <div class="nc-rule"></div>
  <div class="nc-body">
    ${heroImg ? `<img src="${heroImg}" class="nc-img" alt="${topic}">` : ''}
    ${html.trim()}
  </div>
</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       MOSAIC  (large hero cell + smaller tile grid)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'mosaic') {
      let html = await callGroq(`${baseCtx}\nWrite a feature article about: ${topic}.
Structure it as:
- <h1> main headline
- <p class="mo-intro"> 2-sentence intro paragraph
- Three sections, each wrapped in <section class="mo-tile"><h2>Section Title</h2><p>...</p></section>
- <p class="mo-cta"> closing CTA
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      const h1M    = html.match(/<h1[^>]*>.*?<\/h1>/is);
      const introM = html.match(/<p class="mo-intro">.*?<\/p>/is);
      const ctaM   = html.match(/<p class="mo-cta">.*?<\/p>/is);
      const tiles  = [...html.matchAll(/<section class="mo-tile">[\s\S]*?<\/section>/gi)].map(m => m[0]);
      const tileImgs = imgs.slice(1);
      const tileHtml = tiles.map((tile, i) =>
        tileImgs[i] ? tile.replace('<h2>', `<img src="${tileImgs[i]}" alt="" class="mo-tile-img"><h2>`) : tile
      ).join('\n');
      return res.json({ article: `<article class="be-mosaic">
  <div class="mo-hero">
    ${heroImg ? `<img src="${heroImg}" alt="${topic}" class="mo-hero-img">` : '<div class="mo-img-ph">Add Hero Image</div>'}
    <div class="mo-hero-text">
      ${h1M  ? h1M[0]  : `<h1>${topic}</h1>`}
      ${introM ? introM[0] : ''}
    </div>
  </div>
  <div class="mo-grid">${tileHtml || html.trim()}</div>
  ${ctaM ? `<div class="mo-footer">${ctaM[0]}</div>` : ''}
</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       MINIMAL BLOG  (typography-first, clean serif)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'minimal-blog') {
      let html = await callGroq(`${baseCtx}\nWrite an elegant, thoughtful blog post about: ${topic}.
- Start with <h1> title (creative, poetic â€” not generic)
- Then <p class="mb-meta">by ${practice || 'StreamInk'}</p>
- Then well-crafted paragraphs with occasional <h2> subheadings
- No bullet lists â€” use flowing prose
- End with a reflective closing paragraph
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      return res.json({ article: `<article class="be-minimal-blog">
  ${heroImg ? `<img src="${heroImg}" class="mb-hero-img" alt="${topic}">` : ''}
  ${html.trim()}
</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       PERSONAL JOURNAL  (warm diary style)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'personal-journal') {
      const today = new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
      let html = await callGroq(`${baseCtx}\nWrite a warm, personal journal-style entry about: ${topic}.
- Start with <h1> personal, reflective title
- Write in first person ("I", "we", "my")
- Use conversational, warm language
- Include 4â€“5 paragraphs with personal anecdotes or observations
- End with a hopeful or inspiring closing thought
- Occasionally use <em> for emphasis
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      return res.json({ article: `<article class="be-personal-journal">
  <div class="pj-header">
    <div class="pj-date">${today}</div>
    ${heroImg ? `<img src="${heroImg}" class="pj-img" alt="">` : ''}
  </div>
  <div class="pj-entry">${html.trim()}</div>
</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       TECH DARK  (dark-mode developer blog)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'tech-dark') {
      let html = await callGroq(`${baseCtx}\nWrite a technical developer-focused article about: ${topic}.
- Start with <h1> technical headline
- Then <p class="td-meta">by ${practice || 'StreamInk Tech'} Â· ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'})}</p>
- Use <h2> for section headers
- Include at least one <pre><code class="td-code"> ... </code></pre> block with a relevant code snippet or command
- Use <ul> or <ol> for technical steps or lists
- Use <blockquote class="td-note"> for important notes or tips
- End with key takeaways
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      return res.json({ article: `<article class="be-tech-dark">
  ${heroImg ? `<img src="${heroImg}" class="td-banner" alt="${topic}">` : ''}
  ${html.trim()}
</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       PHOTO ESSAY  (imagery-driven with captions)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'photo-essay') {
      let html = await callGroq(`${baseCtx}\nWrite a visually rich photo-essay article about: ${topic}.
- Start with <h1> evocative title
- Then <p class="pe-intro"> 2â€“3 sentence introduction
- Then ${Math.max(imgs.length, 3)} photo-caption blocks, each as:
  <figure class="pe-figure"><figcaption>Compelling caption text describing what this image shows</figcaption></figure>
- Add 1â€“2 <p> transition paragraphs between figures
- End with <p class="pe-closing"> reflective conclusion
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      // inject actual images into figure tags
      let figIdx = 0;
      html = html.replace(/<figure class="pe-figure">/g, () => {
        const src = imgs[figIdx] || '';
        figIdx++;
        return src
          ? `<figure class="pe-figure"><img src="${src}" alt="">`
          : `<figure class="pe-figure"><div class="pe-img-ph">Add Photo</div>`;
      });
      return res.json({ article: `<article class="be-photo-essay">${html.trim()}</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       LISTICLE  (numbered list article)
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    if (templateId === 'listicle') {
      let html = await callGroq(`${baseCtx}\nWrite a listicle article about: ${topic}.
- Start with <h1> headline that includes a number (e.g. "7 Ways toâ€¦", "10 Reasons Whyâ€¦")
- Then <p class="li-intro"> 1â€“2 sentence intro
- Then 7â€“10 numbered items, each as:
  <div class="li-item"><span class="li-num">N</span><div class="li-body"><h3>Item Title</h3><p>2â€“3 sentence explanation</p></div></div>
- End with <p class="li-conclusion"> brief closing paragraph
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      return res.json({ article: `<article class="be-listicle">
  ${heroImg ? `<img src="${heroImg}" class="li-hero-img" alt="${topic}">` : ''}
  ${html.trim()}
</article>` });
    }

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       DEFAULT FALLBACK
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    {
      let html = await callGroq(`${baseCtx}\nWrite a blog article about: ${topic}. Start with an <h1>. End with a CTA.`);
      if (!html) return res.json({ article: '<p>No content returned from AI.</p>' });
      if (heroImg && !/<img[^>]*>/i.test(html)) html = `<img src="${heroImg}" class="be-img-right be-img-33" alt="">\n${html.trim()}`;
      await deductCredits(req);
      res.json({ article: html });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ article: `<p>Error: ${err.message}</p>` });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: article generate
   Fields : topic, url, brief, tone,
            style (editorial/journalistic/expert),
            length, template,
            images[] (files)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/article/generate', requireAuth, aiLimit, checkCredits(CREDIT_COSTS.article,'article'), upload.any(), async (req, res) => {
  try {
    const body = req.body;
    const topic    = body.topic    || '';
    const url      = body.url      || '';
    const brief    = body.brief    || '';
    const tone     = body.tone     || 'professional';
    const style    = body.style    || 'editorial';
    const length   = body.length   || 'medium';
    const wordCount = parseInt(body.wordCount) || 0;
    const template = body.template || 'editorial-spread';

    const imgs    = (req.files || []).map(f => `/uploads/${f.filename}`);
    const heroImg = imgs[0] || '';

    const site     = url ? await fetchSiteData(url) : {};
    const practice = site.practice_name || (url ? new URL(url).hostname : '');
    const pageText = site.text || '';

    const styleMap = {
      editorial:      'Write in a polished editorial style with clear narrative flow and structured subheadings.',
      journalistic:   'Write in a journalistic style â€” inverted pyramid, lead with key facts, concise and factual.',
      expert:         'Write as a subject-matter expert with deep insights, data-driven claims, and authoritative analysis.',
      professional:   'Write in a clear, formal, trustworthy professional tone.',
      conversational: 'Write in a natural, conversational tone as if speaking directly to the reader.',
      academic:       'Write in an academic style with formal language, structured argument, and logical progression.',
    };

    const lengthMap = {
      short:  'Write a concise article (300â€“400 words).',
      medium: 'Write a well-developed article (700â€“900 words).',
      long:   'Write a comprehensive, in-depth article (1100â€“1400 words).',
    };

    const styleInstruction  = styleMap[style]  || styleMap.editorial;
    const lengthInstruction = wordCount
      ? `Write the article in approximately ${wordCount} words (Â±10%).`
      : (lengthMap[length] || lengthMap.medium);

    const baseCtx = `STYLE: ${styleInstruction}
LENGTH: ${lengthInstruction}
OPTIONAL BRIEF: ${brief}
${practice ? `ORGANIZATION: ${practice}` : ''}
${pageText ? `SOURCE CONTENT:\n${pageText.substring(0, 1500)}` : ''}
TOPIC: ${topic}
RULES: Output ONLY clean HTML. No inline styles. No markdown fences. Use: h1, h2, h3, p, ul, li, blockquote, strong, em.`;

    const today = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

    /* â”€â”€ EDITORIAL SPREAD â”€â”€ */
    if (template === 'editorial-spread' || template === 'editorial') {
      let html = await callGroq(`${baseCtx}\nWrite a feature article. Start with <h1>, then strong lead <p>, then 3â€“4 <h2> sections each with 1â€“2 <p>, then conclusion with CTA.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      const h1M = html.match(/<h1[^>]*>.*?<\/h1>/is)?.[0] || '';
      const body = html.replace(/<h1[^>]*>.*?<\/h1>/is, '').trim();
      return res.json({ article: `<article class="ae-editorial-spread">
  ${heroImg ? `<div class="aes-hero"><img src="${heroImg}" alt="${topic}"></div>` : ''}
  <div class="aes-title-block">${h1M}</div>
  <div class="aes-body">${body}</div>
</article>` });
    }

    /* â”€â”€ SPLIT STORY â”€â”€ */
    if (template === 'split-story' || template === 'feature') {
      let html = await callGroq(`${baseCtx}\nWrite a feature article. Start with <h1>, add <p class="ss-byline">By ${practice || 'Staff Writer'}</p>, then 4â€“5 <p> paragraphs and a <p class="ss-cta"> closing.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      return res.json({ article: `<article class="ae-split-story">
  <div class="ss-image">${heroImg ? `<img src="${heroImg}" alt="${topic}">` : '<div class="ss-img-ph">Add Image</div>'}</div>
  <div class="ss-content">${html}</div>
</article>` });
    }

    /* â”€â”€ LONG-FORM DEEP DIVE â”€â”€ */
    if (template === 'longform') {
      let html = await callGroq(`${baseCtx}\nWrite an in-depth long-form article. Start with <h1>. Include 4â€“5 <h2> sections. Add at least one <blockquote class="lf-pullquote"> with a compelling pull-quote. End with a strong conclusion paragraph.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      const h1M = html.match(/<h1[^>]*>.*?<\/h1>/is)?.[0] || '';
      const body = html.replace(/<h1[^>]*>.*?<\/h1>/is, '').trim();
      return res.json({ article: `<article class="ae-longform">
  <div class="lf-header"${heroImg ? ` style="background-image:url('${heroImg}')"` : ''}>
    <div class="lf-header-overlay">${h1M}<p class="lf-meta">By ${practice || 'StreamInk'} Â· ${today}</p></div>
  </div>
  <div class="lf-body">${body}</div>
</article>` });
    }

    /* â”€â”€ EXECUTIVE BRIEF â”€â”€ */
    if (template === 'executive-brief') {
      let html = await callGroq(`${baseCtx}\nWrite an executive brief. Structure:
- <h1> title
- <p class="eb-date">${today} | Prepared by: ${practice || 'StreamInk Studio'}</p>
- <div class="eb-summary"><h3>Key Findings</h3> then 3â€“4 <li> bullet points of key takeaways</div>
- 3 <h2> sections each with 1â€“2 <p> of detail
- <p class="eb-conclusion"> summary paragraph
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      return res.json({ article: `<article class="ae-executive-brief">${html}</article>` });
    }

    /* â”€â”€ RESEARCH PAPER â”€â”€ */
    if (template === 'research-paper') {
      let html = await callGroq(`${baseCtx}\nWrite a research-style article. Structure:
- <h1> title (centered)
- <p class="rp-authors">${practice || 'Author Name'}</p>
- <p class="rp-date">${today}</p>
- <div class="rp-abstract"><strong>Abstract:</strong> 2â€“3 sentence summary</div>
- Numbered sections: <h2>1. Introduction</h2>, <h2>2. Background</h2>, <h2>3. Analysis</h2>, <h2>4. Conclusions</h2>
- Each section has 1â€“2 <p> paragraphs
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      return res.json({ article: `<article class="ae-research-paper">${html}</article>` });
    }

    /* â”€â”€ BUSINESS REPORT â”€â”€ */
    if (template === 'business-report') {
      let html = await callGroq(`${baseCtx}\nWrite a business report. Structure:
- <h1> report title
- <div class="br-kpis"><div class="br-kpi"><span class="br-kpi-val">Key Stat</span><span class="br-kpi-label">Label</span></div> â€” create 3 relevant KPI boxes</div>
- 3â€“4 <h2> sections with <p> body
- <p class="br-footer">Prepared by ${practice || 'StreamInk Studio'} Â· ${today}</p>
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      return res.json({ article: `<article class="ae-business-report">
  <div class="br-header"${heroImg ? ` style="background-image:url('${heroImg}')"` : ''}>
    <div class="br-header-inner">${html.match(/<h1[^>]*>.*?<\/h1>/is)?.[0] || `<h1>${topic}</h1>`}</div>
  </div>
  <div class="br-body">${html.replace(/<h1[^>]*>.*?<\/h1>/is, '').trim()}</div>
</article>` });
    }

    /* â”€â”€ OP-ED â”€â”€ */
    if (template === 'op-ed' || template === 'authority') {
      let html = await callGroq(`${baseCtx}\nWrite an opinion/op-ed article. Structure:
- <h1> bold opinion headline
- <p class="oe-byline">By ${practice || 'Staff Writer'} Â· ${today}</p>
- Strong opening <p> stating the main argument
- 3â€“4 <p> paragraphs developing the argument with evidence
- <blockquote class="oe-pullquote"> one powerful pull quote
- <p class="oe-conclusion"> strong closing paragraph with call to action
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      return res.json({ article: `<article class="ae-op-ed">${html}</article>` });
    }

    /* â”€â”€ THOUGHT LEADERSHIP â”€â”€ */
    if (template === 'thought-leader') {
      let html = await callGroq(`${baseCtx}\nWrite a thought leadership article. Structure:
- <h1> powerful, insightful headline
- 4â€“5 well-crafted <p> paragraphs
- Include 1â€“2 <h2> section dividers
- Use <strong> for key terms and insights
- Authoritative, inspiring tone
- End with a forward-looking conclusion
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      return res.json({ article: `<article class="ae-thought-leader">
  <div class="tl-author">
    ${heroImg ? `<img src="${heroImg}" class="tl-author-img" alt="${practice || 'Author'}">` : '<div class="tl-author-avatar">ðŸ‘¤</div>'}
    <div class="tl-author-info">
      <div class="tl-author-name">${practice || 'Expert Author'}</div>
      <div class="tl-author-date">${today}</div>
    </div>
  </div>
  <div class="tl-body">${html}</div>
</article>` });
    }

    /* â”€â”€ BREAKING NEWS â”€â”€ */
    if (template === 'breaking-news') {
      let html = await callGroq(`${baseCtx}\nWrite a breaking news article. Structure:
- <h1> urgent, bold headline (news style, all caps first word)
- <p class="bn-dateline"><strong>${today.toUpperCase()}</strong> â€” </p> followed by wire-style lead paragraph
- <p class="bn-byline">By ${practice || 'News Desk'}</p>
- 3â€“4 short factual <p> paragraphs (inverted pyramid â€” most important first)
- <p class="bn-footer">Â© ${today.split(',')[1]?.trim() || '2026'} ${practice || 'StreamInk News'}</p>
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      return res.json({ article: `<article class="ae-breaking-news">
  <div class="bn-masthead">
    <span class="bn-pub">${practice || 'StreamInk News'}</span>
    <span class="bn-breaking">ðŸ”´ BREAKING</span>
    <span class="bn-date">${today}</span>
  </div>
  <div class="bn-rule"></div>
  ${heroImg ? `<img src="${heroImg}" class="bn-img" alt="${topic}">` : ''}
  <div class="bn-body">${html}</div>
</article>` });
    }

    /* â”€â”€ PRESS RELEASE â”€â”€ */
    if (template === 'press-release') {
      let html = await callGroq(`${baseCtx}\nWrite a formal press release. Structure:
- <p class="pr-release">FOR IMMEDIATE RELEASE</p>
- <p class="pr-date">${today}</p>
- <h1> press release headline
- <p class="pr-location"><strong>${practice || 'CITY, State'}</strong> â€” </p> followed by lead paragraph
- 3â€“4 body <p> paragraphs
- <blockquote class="pr-quote"> one executive quote with attribution
- <div class="pr-boilerplate"><strong>About ${practice || 'the Organization'}:</strong> 2â€“3 sentence boilerplate</div>
- <div class="pr-contact"><strong>Media Contact:</strong> Name, email, phone</div>
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      return res.json({ article: `<article class="ae-press-release">
  ${heroImg ? `<div class="pr-logo-row"><img src="${heroImg}" class="pr-logo" alt="${practice}"></div>` : ''}
  ${html}
</article>` });
    }

    /* â”€â”€ Q&A INTERVIEW â”€â”€ */
    if (template === 'interview-qa') {
      let html = await callGroq(`${baseCtx}\nWrite a Q&A interview article about: ${topic}.
Structure:
- <h1> interview title (e.g. "In Conversation Withâ€¦")
- <p class="qa-intro"> 1â€“2 sentence intro
- 6â€“8 Q&A pairs, each as:
  <div class="qa-pair">
    <p class="qa-q"><strong>Q:</strong> Question text here?</p>
    <p class="qa-a"><strong>A:</strong> Answer text here.</p>
  </div>
- <p class="qa-footer"> closing note
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      return res.json({ article: `<article class="ae-interview-qa">${html}</article>` });
    }

    /* â”€â”€ PROFILE STORY â”€â”€ */
    if (template === 'profile-story') {
      let html = await callGroq(`${baseCtx}\nWrite a profile article about a person or organization related to: ${topic}.
Structure:
- <h1> subject name / headline
- <p class="ps-tagline"> one-line description of the subject
- <div class="ps-facts"><ul> 4â€“5 <li> key facts about the subject</ul></div>
- <p class="ps-intro"> engaging introduction paragraph
- 3â€“4 <h2> sections telling the subject's story
- <p class="ps-closing"> memorable closing quote or insight
Output ONLY HTML tags.`);
      if (!html) return res.json({ article: '<p>No content returned.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      return res.json({ article: `<article class="ae-profile-story">
  <div class="ps-portrait">${heroImg ? `<img src="${heroImg}" alt="${topic}">` : '<div class="ps-portrait-ph">ðŸ“·</div>'}</div>
  <div class="ps-content">${html}</div>
</article>` });
    }

    /* â”€â”€ DEFAULT / CUSTOM â”€â”€ */
    {
      let html = await callGroq(`${baseCtx}\nWrite a well-structured article about: ${topic}. Start with <h1>. Use <h2> sections. End with a conclusion.`);
      if (!html) return res.json({ article: '<p>No content returned from AI.</p>' });
      html = html.replace(/```[\s\S]*?```/g, '').trim();
      if (heroImg) html = `<img src="${heroImg}" style="width:100%;margin-bottom:24px;border-radius:6px" alt="">\n${html}`;
      await deductCredits(req);
      res.json({ article: html });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ article: `<p>Error: ${err.message}</p>` });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: social post generate
   Fields: topic, platform, tone, brief, url, images[]
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/social/generate', requireAuth, aiLimit, checkCredits(CREDIT_COSTS.social,'social'), upload.any(), async (req, res) => {
  try {
    const { topic, platform, tone, brief, url, brand } = req.body;
    const imgs = (req.files || []).map(f => `/uploads/${f.filename}`);
    const heroImg = imgs[0] || '';

    const site     = url ? await fetchSiteData(url) : {};
    const practice = brand || site.practice_name || '';

    const platformLabels = { instagram:'Instagram', twitter:'Twitter/X', linkedin:'LinkedIn', facebook:'Facebook', story:'Instagram Story' };

    const userCta = req.body.cta ? req.body.cta.trim() : '';

    const prompt = `Create engaging social media content for ${platformLabels[platform] || 'Instagram'}.
${practice ? `Brand: ${practice}` : ''}
Topic: ${topic}
Tone: ${tone || 'engaging'}
${brief ? `Brief: ${brief}` : ''}
${userCta ? `CTA button text (use exactly): "${userCta}"` : 'CTA: generate a compelling 2-4 word call-to-action'}

Return ONLY a raw JSON object (no markdown, no extra text):
{
  "headline": "Bold punchy headline max 8 words",
  "subtext": "Supporting line max 20 words",
  "cta": "${userCta || 'compelling CTA max 4 words'}",
  "hashtags": "#tag1 #tag2 #tag3 #tag4 #tag5",
  "v2_headline": "Same idea, different angle, max 8 words",
  "v2_subtext": "Alternative supporting line",
  "v3_headline": "More inspiring/emotional version, max 8 words",
  "v3_subtext": "Different emotional hook"
}`;

    const raw    = await callGroq(prompt, 800);
    const parsed = safeParseJson(raw);

    const gradients = {
      instagram: 'linear-gradient(135deg,#f093fb 0%,#f5576c 50%,#4facfe 100%)',
      twitter:   'linear-gradient(135deg,#1da1f2,#0d8ed9)',
      linkedin:  'linear-gradient(135deg,#0077b5,#00a0dc)',
      facebook:  'linear-gradient(135deg,#1877f2,#42a5f5)',
      story:     'linear-gradient(180deg,#f093fb 0%,#f5576c 50%,#4facfe 100%)',
    };

    await deductCredits(req);
    res.json({
      data: {
        headline:    parsed.headline    || 'Your Headline Here',
        subtext:     parsed.subtext     || 'Supporting message goes here',
        cta:         userCta || parsed.cta || 'Learn More â†’',
        hashtags:    parsed.hashtags    || '#topic #brand',
        v2_headline: parsed.v2_headline || parsed.headline || '',
        v2_subtext:  parsed.v2_subtext  || parsed.subtext  || '',
        v3_headline: parsed.v3_headline || parsed.headline || '',
        v3_subtext:  parsed.v3_subtext  || parsed.subtext  || '',
      },
      heroImg,
      bg: gradients[platform] || gradients.instagram,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: GIF / Sticker search
   GET /api/media/search?q=...&type=gif|sticker
   Uses Tenor (free Google API key) â€” falls back to Giphy
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/media/search', async (req, res) => {
  const { q, type = 'gif' } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });

  const limit = 12;

  // â”€â”€ Try Tenor first (GIFs + stickers) â”€â”€
  const tenorKey = process.env.TENOR_API_KEY;
  if (tenorKey) {
    try {
      const endpoint = type === 'sticker'
        ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}+sticker&key=${tenorKey}&limit=${limit}&contentfilter=medium&media_filter=gif,tinygif`
        : `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=${tenorKey}&limit=${limit}&contentfilter=medium&media_filter=gif,tinygif`;

      const r    = await fetch(endpoint);
      const data = await r.json();
      if (data.results && data.results.length) {
        const results = data.results.map(item => {
          const gif    = item.media_formats?.gif    || item.media_formats?.tinygif;
          const tinygif= item.media_formats?.tinygif|| gif;
          return { url: gif?.url, preview: tinygif?.url, title: item.content_description };
        }).filter(r => r.url);
        return res.json({ results, source: 'tenor' });
      }
    } catch(e) { console.warn('Tenor error:', e.message); }
  }

  // â”€â”€ Try Giphy (GIFs + stickers) â”€â”€
  const giphyKey = process.env.GIPHY_API_KEY;
  if (giphyKey) {
    try {
      const endpoint = type === 'sticker'
        ? `https://api.giphy.com/v1/stickers/search?api_key=${giphyKey}&q=${encodeURIComponent(q)}&limit=${limit}&rating=g`
        : `https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=${encodeURIComponent(q)}&limit=${limit}&rating=g`;

      const r    = await fetch(endpoint);
      const data = await r.json();
      if (data.data && data.data.length) {
        const results = data.data.map(item => ({
          url:     item.images?.original?.url,
          preview: item.images?.fixed_width_small?.url || item.images?.preview_gif?.url,
          title:   item.title
        })).filter(r => r.url);
        return res.json({ results, source: 'giphy' });
      }
    } catch(e) { console.warn('Giphy error:', e.message); }
  }

  // â”€â”€ Free fallback: Giphy public beta key (rate-limited but functional) â”€â”€
  try {
    const PUBLIC_GIPHY = 'dc6zaTOxFJmzC'; // Giphy public beta key â€” free, low rate limit
    const endpoint = type === 'sticker'
      ? `https://api.giphy.com/v1/stickers/search?api_key=${PUBLIC_GIPHY}&q=${encodeURIComponent(q)}&limit=${limit}&rating=g`
      : `https://api.giphy.com/v1/gifs/search?api_key=${PUBLIC_GIPHY}&q=${encodeURIComponent(q)}&limit=${limit}&rating=g`;
    const r    = await fetch(endpoint);
    const data = await r.json();
    if (data.data && data.data.length) {
      const results = data.data.map(item => ({
        url:     item.images?.original?.url,
        preview: item.images?.fixed_width_small?.url || item.images?.preview_gif?.url,
        title:   item.title
      })).filter(r => r.url);
      return res.json({ results, source: 'giphy-public' });
    }
  } catch(e) { console.warn('Giphy public fallback error:', e.message); }

  res.json({ results: [], note: 'Add TENOR_API_KEY or GIPHY_API_KEY to .env for higher limits' });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: AI image generate
   Fields: prompt, style
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/ai-image/generate', async (req, res) => {
  try {
    const { prompt, width = 1024, height = 1024, style = 'photo' } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const openaiApiKey = process.env.OPENAI_API_KEY;

    // â”€â”€ PRIMARY: Pollinations.ai (free, no API key needed) â”€â”€
    if (!openaiApiKey) {
      const modelMap = { photo:'flux', '2d':'flux-anime', '3d':'flux-3d', sticker:'flux' };
      const model   = modelMap[style] || 'flux';
      const encoded = encodeURIComponent(prompt);
      const seed    = Math.floor(Math.random() * 99999);
      const url = `https://image.pollinations.ai/prompt/${encoded}?model=${model}&width=${width}&height=${height}&nologo=true&seed=${seed}`;
      console.log('[AI Image] Using Pollinations.ai:', url.slice(0, 100) + '...');
      // Download and serve locally so CORS + crop canvas works
      try {
        const imageRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (imageRes.ok) {
          const buf = Buffer.from(await imageRes.arrayBuffer());
          const imageUrl = saveGeneratedImage(buf, 'jpg');
          return res.json({ imageUrl });
        }
      } catch (fetchErr) {
        console.warn('[AI Image] Pollinations fetch failed, returning URL direct:', fetchErr.message);
      }
      // Return direct URL as fallback (browser fetches it, crossOrigin may block crop)
      return res.json({ imageUrl: url });
    }

    // â”€â”€ PREMIUM: OpenAI DALL-E â”€â”€
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errText.slice(0,200)}`);
    }

    const data = await response.json();
    const image = data.data && data.data[0];
    if (!image) throw new Error('No image returned from OpenAI');

    if (image.b64_json) {
      const imageUrl = saveGeneratedImage(Buffer.from(image.b64_json, 'base64'), 'png');
      return res.json({ imageUrl });
    }

    if (image.url) {
      const imageRes = await fetch(image.url);
      if (!imageRes.ok) throw new Error(`Image download failed: ${imageRes.status}`);
      const buf = Buffer.from(await imageRes.arrayBuffer());
      const imageUrl = saveGeneratedImage(buf, 'png');
      return res.json({ imageUrl });
    }

    throw new Error('Image response did not include image data');

  } catch (err) {
    console.error('[AI Image] Error:', err.message);
    // Final fallback: Pollinations.ai direct URL
    const encoded = encodeURIComponent((req.body && req.body.prompt) || 'professional business background');
    const seed    = Math.floor(Math.random() * 99999);
    res.json({ imageUrl: `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&seed=${seed}` });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: email newsletter generate
   Fields: topic, url, subject, sections, tone, length, images[]
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/email/generate', requireAuth, aiLimit, checkCredits(CREDIT_COSTS.email,'email'), upload.any(), async (req, res) => {
  try {
    const { topic, url, subject, sections, tone, length } = req.body;
    const imgs = (req.files || []).map(f => `/uploads/${f.filename}`);

    const site     = url ? await fetchSiteData(url) : {};
    const practice = site.practice_name || '';
    const pageText = site.text || '';

    const lengthMap = {
      short:  'Keep it brief (200-300 words total).',
      medium: 'Write a medium newsletter (400-500 words).',
      long:   'Write a detailed newsletter (600-800 words).',
    };

    const sectionList = sections
      ? (Array.isArray(sections) ? sections : sections.split('\n')).filter(Boolean).map(s => `- ${s.trim()}`).join('\n')
      : '';

    const prompt = `
Write a professional email newsletter in clean HTML.

CRITICAL RULES:
- Output ONLY HTML, no markdown, no preamble, no explanation
- Use ONLY: h1, h2, h3, p, ul, li, strong, em, a tags
- Do NOT add inline styles
- Make it scannable

BRAND: ${practice || topic}
SUBJECT: ${subject || topic}
TOPIC: ${topic}
TONE: ${tone || 'professional'}
LENGTH: ${lengthMap[length] || lengthMap.medium}
${sectionList ? `REQUIRED SECTIONS:\n${sectionList}` : ''}
${pageText ? `BRAND CONTEXT: ${pageText.substring(0, 2000)}` : ''}

STRUCTURE:
1. <h1> matching the subject
2. Short intro <p>
3. 2-3 <h2> sections with <p> each
4. CTA <p> with an <a> link
5. Brief sign-off <p>
`;

    let html = await callGroq(prompt, 2048);
    html = html.replace(/```html?\n?/gi, '').replace(/```/g, '').trim();

    // Return the raw AI HTML â€” the client builds its own header/CTA/footer sections
    await deductCredits(req);
    res.json({ html });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: AI refine selected text
   Body (JSON): text, instruction, tone
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/refine', requireAuth, aiLimit, checkCredits(CREDIT_COSTS.refine,'refine'), async (req, res) => {
  try {
    const { text, instruction, tone } = req.body;
    if (!text || !instruction) return res.status(400).json({ error: 'Missing text or instruction' });

    const prompt = `You are a professional editor. Rewrite the following text exactly according to the instruction.

INSTRUCTION: ${instruction}
${tone ? `TONE: ${tone}` : 'TONE: maintain the existing tone'}

ORIGINAL TEXT:
${text}

RULES:
- Return ONLY the rewritten text, nothing else â€” no preamble, no explanation, no quotes
- Preserve any HTML tags present in the original
- Match the approximate length unless the instruction says otherwise`;

    const refined = await callGroq(prompt, 1024);
    await deductCredits(req);
    res.json({ refined: refined.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: Meta tags â€” embedded in editors
   Body (JSON): topic, keyword, url, tone
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/meta/generate', async (req, res) => {
  try {
    const { topic, keyword, url, tone } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic required' });

    const prompt = `Generate SEO meta tags for content about: "${topic}".
${keyword ? `Primary keyword to include: ${keyword}` : ''}
${url ? `Website: ${url}` : ''}
${tone ? `Tone: ${tone}` : ''}

Return ONLY valid JSON, no markdown:
{
  "metaTitle": "60 chars max â€” includes primary keyword naturally",
  "metaDescription": "155 chars max â€” compelling, includes keyword, drives clicks",
  "slug": "url-friendly-slug",
  "ogTitle": "Social sharing title",
  "ogDescription": "Social sharing description"
}`;

    const raw = await callGroq(prompt, 500);
    res.json(safeParseJson(raw));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: Script Writer â€” generate outline
   Body (JSON): title, author, type, genre,
                brief, tone, pageCount,
                targetAudience
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/script/outline', requireAuth, aiLimit, checkCredits(CREDIT_COSTS.script_outline,'script'), async (req, res) => {
  try {
    const { title, author, type, genre, brief, tone, pageCount, targetAudience } = req.body;
    if (!title || !brief) return res.status(400).json({ error: 'Title and brief are required' });

    const pages     = Math.min(Math.max(parseInt(pageCount) || 10, 1), 120);
    const sceneCount = Math.min(Math.max(Math.round(pages * 0.8), 3), 30);

    const structureGuide = {
      'Feature Film':        'Three acts: Setup (25%), Confrontation (50%), Resolution (25%)',
      'Short Film':          'Single arc: Hook â†’ Rising Action â†’ Climax â†’ Resolution',
      'TV Episode (22 min)': 'Two acts with a cold open and tag',
      'TV Episode (60 min)': 'Four acts with teaser and tag',
      'TV Commercial (30s)': 'Single scene: Problem â†’ Solution â†’ Brand reveal',
      'TV Commercial (60s)': 'Two scenes: Story setup â†’ Emotional payoff â†’ Brand',
      'YouTube Script':      'Hook (0:00) â†’ Problem â†’ Story â†’ Solution â†’ CTA',
      'Web Series Episode':  'Cold open â†’ Two acts â†’ Cliffhanger',
      'Stage Play':          'Two to three acts with clear entrances and exits',
      'Documentary':         'Introduction â†’ Three thematic chapters â†’ Conclusion',
      'Podcast Script':      'Cold open â†’ Interview/Discussion segments â†’ Outro',
      'Corporate Video':     'Challenge â†’ Journey â†’ Transformation â†’ Result',
    };

    const prompt = `You are a professional script development executive and award-winning screenwriter.

Create a detailed scene outline for a ${type || 'script'} titled "${title}" by ${author || 'the author'}.

Genre: ${genre || 'Drama'}
Premise: ${brief}
Tone: ${tone || 'dramatic'}
Script length: approximately ${pages} pages
${targetAudience ? `Target audience: ${targetAudience}` : ''}
Structure guide: ${structureGuide[type] || 'Classic three-act structure'}

Requirements:
- Create exactly ${sceneCount} scenes
- Each scene heading must follow screenplay format: INT./EXT. LOCATION - DAY/NIGHT
- Each summary must be 1-2 sentences describing the dramatic action
- Build proper narrative momentum with clear conflict escalation

Return ONLY a valid JSON object, no markdown:
{
  "logline": "One compelling sentence describing the entire story",
  "structure": "${structureGuide[type] || 'Three-Act Structure'}",
  "acts": [
    {
      "name": "ACT ONE",
      "description": "Brief act description",
      "scenes": [
        {"heading": "INT. LOCATION - DAY", "summary": "What happens dramatically in this scene"}
      ]
    }
  ]
}`;

    const raw = await callGroq(prompt, 3000);
    await deductCredits(req);
    res.json(safeParseJson(raw));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: Script Writer â€” generate scene
   Body (JSON): title, type, genre, brief,
                tone, sceneHeading,
                sceneSummary, prevSceneEnding,
                sceneIndex, totalScenes
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/script/scene', requireAuth, aiLimit, checkCredits(CREDIT_COSTS.script_scene,'script'), async (req, res) => {
  try {
    const {
      title, type, genre, brief, tone,
      sceneHeading, sceneSummary,
      prevSceneEnding, sceneIndex, totalScenes
    } = req.body;

    const isFirst = sceneIndex === 0;
    const isLast  = sceneIndex === totalScenes - 1;
    const targetWords = type?.includes('Commercial') ? 80 : type?.includes('YouTube') ? 150 : 250;

    const prompt = `You are a professional ${genre || 'Drama'} screenwriter. Write one scene for a ${type || 'script'} titled "${title}".

Genre: ${genre || 'Drama'}
Tone: ${tone || 'dramatic'}
Story: ${brief}
Scene: ${sceneHeading}
What happens: ${sceneSummary}
${prevSceneEnding ? `Previous scene ended with: "${prevSceneEnding}"` : isFirst ? 'This is the OPENING scene â€” grab the audience immediately.' : ''}
${isLast ? 'This is the FINAL scene â€” deliver a satisfying, resonant conclusion.' : ''}
Target: ~${targetWords} words

Write this scene as professional screenplay using ONLY these XML tags:
<SLUG>INT. or EXT. LOCATION - DAY/NIGHT</SLUG>
<ACTION>What we see and hear on screen â€” visual, concrete, cinematic</ACTION>
<CHAR>CHARACTER NAME</CHAR>
<PAREN>(how they deliver the line)</PAREN>
<DIAL>What the character says</DIAL>
<TRANS>CUT TO: / DISSOLVE TO: / SMASH CUT TO: etc</TRANS>
${isFirst ? '<FADE>FADE IN:</FADE> â€” use this as the very first element' : ''}
${isLast ? 'End with <FADE>FADE OUT.</FADE> then <TRANS>THE END</TRANS>' : ''}

Rules:
- Action lines must be VISUAL â€” describe only what camera can see/hear
- Dialogue reveals character and advances plot â€” no "on-the-nose" lines
- Be concise: this is screenwriting, not prose
- Every line must earn its place
Output ONLY the XML-tagged scene. Nothing else.`;

    const rawContent = await callGroq(prompt, 1500);

    // Extract last line of dialogue for continuity
    const dialMatches = rawContent.match(/<DIAL>([\s\S]*?)<\/DIAL>/g) || [];
    const actionMatches = rawContent.match(/<ACTION>([\s\S]*?)<\/ACTION>/g) || [];
    const lastEl = dialMatches[dialMatches.length - 1] || actionMatches[actionMatches.length - 1] || '';
    const lastLine = lastEl.replace(/<[^>]+>/g, '').trim().substring(0, 120);

    const wordCount = rawContent.replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean).length;
    await deductCredits(req);
    res.json({ rawContent, lastLine, wordCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: Script Writer â€” improve scene
   Body (JSON): sceneText, instruction,
                type, genre, sceneHeading
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/script/improve', requireAuth, aiLimit, checkCredits(CREDIT_COSTS.refine,'refine'), async (req, res) => {
  try {
    const { sceneText, instruction, type, genre, sceneHeading } = req.body;
    if (!sceneText || !instruction) return res.status(400).json({ error: 'Scene and instruction required' });

    const prompt = `You are a professional script editor specialising in ${genre || 'Drama'} ${type || 'screenplays'}.
Scene: "${sceneHeading || 'Current scene'}"

Current scene content:
"""
${sceneText.substring(0, 2500)}
"""

Editor instruction: ${instruction}

Rewrite the scene using ONLY these XML tags:
<SLUG>scene heading</SLUG>
<ACTION>action/description</ACTION>
<CHAR>CHARACTER NAME</CHAR>
<PAREN>(parenthetical)</PAREN>
<DIAL>dialogue</DIAL>
<TRANS>transition</TRANS>
<FADE>fade in/out</FADE>

Rules:
- Preserve story continuity and character voices
- Match approximate original length unless told otherwise
- Output ONLY the XML-tagged scene, nothing else`;

    const rawContent = await callGroq(prompt, 1800);
    const wordCount  = rawContent.replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean).length;
    await deductCredits(req);
    res.json({ rawContent, wordCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: Book Writer â€” generate outline
   Body (JSON): title, author, genre,
                description, writingStyle,
                chapterCount
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/book/outline', requireAuth, aiLimit, checkCredits(CREDIT_COSTS.book_outline,'book'), async (req, res) => {
  try {
    const { title, author, genre, description, writingStyle, chapterCount } = req.body;
    if (!title || !description) return res.status(400).json({ error: 'Title and description are required' });

    const count = Math.min(Math.max(parseInt(chapterCount) || 8, 3), 20);

    const prompt = `You are a master ${genre || 'fiction'} author and story architect.

Create a compelling chapter outline for a ${genre || 'novel'} titled "${title}" by ${author || 'the author'}.

Story premise: ${description}
Writing style: ${writingStyle || 'descriptive'}
Number of chapters: ${count}

Requirements:
- Each chapter title must be evocative and specific to that chapter's events
- Each summary must be 2-3 sentences describing exactly what happens
- Build a strong narrative arc: setup â†’ rising action â†’ climax â†’ resolution
- Create natural story momentum that pulls the reader from chapter to chapter

Return ONLY a valid JSON array, no markdown, no explanation:
[{"number":1,"title":"Chapter Title Here","summary":"What happens in this chapter..."},...]`;

    const raw      = await callGroq(prompt, 2048);
    const chapters = safeParseJson(raw);
    await deductCredits(req);
    res.json({ chapters });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: Book Writer â€” generate chapter
   Body (JSON): title, author, genre,
                description, writingStyle,
                chapterNumber, totalChapters,
                chapterTitle, chapterSummary,
                wordsPerChapter, previousEnding
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/book/chapter', requireAuth, aiLimit, checkCredits(CREDIT_COSTS.book_chapter,'book'), async (req, res) => {
  try {
    const {
      title, author, genre, description, writingStyle,
      chapterNumber, totalChapters, chapterTitle, chapterSummary,
      wordsPerChapter, previousEnding, previousChapterSummary,
      previousChapterContent
    } = req.body;

    const words   = Math.min(parseInt(wordsPerChapter) || 1000, 2000);
    const tokens  = Math.round(words * 1.5) + 400;

    const isFirst = chapterNumber === 1;
    const isLast  = chapterNumber === totalChapters;

    const safePreviousChapterSummary = previousChapterSummary
      ? previousChapterSummary.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$\{/g,'\\${')
      : '';
    const safePreviousChapterContent = previousChapterContent
      ? previousChapterContent.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$\{/g,'\\${')
      : '';

    const previousContext = safePreviousChapterSummary
      ? `Previous chapter summary: ${safePreviousChapterSummary}`
      : previousEnding
        ? `The previous chapter ended with: "${previousEnding}"`
        : '';

    const previousText = safePreviousChapterContent
      ? `\nPrevious chapter content:\n${safePreviousChapterContent}\n`
      : '';

    const prompt = `You are a skilled ${genre || 'fiction'} author. Write Chapter ${chapterNumber}: "${chapterTitle}" of the novel "${title}" by ${author || 'the author'}.

Story premise: ${description}
Writing style: ${writingStyle || 'descriptive and immersive'}
Chapter summary: ${chapterSummary}
Target length: approximately ${words} words
${previousContext}${previousText}
${isFirst ? 'This is the opening chapter â€” establish the world, protagonist, and tone strongly.' : ''}
${isLast ? 'This is the FINAL chapter â€” provide satisfying resolution and closure.' : ''}

Writing rules:
- Write full flowing narrative prose â€” show don't tell
- Use vivid descriptions, natural dialogue, and authentic character voices
- Match the ${writingStyle || 'descriptive'} style throughout
- Do NOT include the chapter title or "Chapter ${chapterNumber}" heading
- Separate paragraphs with a blank line (double newline)
- ${isLast ? 'End with emotional resolution and closure' : 'End at a natural stopping point that creates anticipation'}
- Output ONLY pure prose text â€” no HTML, no markdown, no headings

Write the full chapter now:`;

    const content = await callGroq(prompt, Math.min(tokens, 4000));
    const wordCount = content.trim().split(/\s+/).length;
    const paragraphs = content.trim().split(/\n{2,}/);
    const lastLine = paragraphs[paragraphs.length - 1]?.trim().substring(0, 150) || '';

    deductCredits(req);
    res.json({ content: content.trim(), wordCount, lastLine });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: Book Writer â€” improve text
   Body (JSON): text, instruction,
                genre, chapterTitle
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/book/improve', requireAuth, aiLimit, checkCredits(CREDIT_COSTS.refine,'refine'), async (req, res) => {
  try {
    const { text, instruction, genre, chapterTitle } = req.body;
    if (!text || !instruction) return res.status(400).json({ error: 'Text and instruction are required' });

    const prompt = `You are a professional book editor and ${genre || 'fiction'} author.
${chapterTitle ? `Chapter: "${chapterTitle}"` : ''}

Text to improve:
"""
${text.substring(0, 3000)}
"""

Instruction: ${instruction}

Rules:
- Return ONLY the improved text â€” no explanation, no preamble, no commentary
- Preserve the author's voice and narrative style
- Separate paragraphs with a blank line
- Match the approximate original length unless the instruction says otherwise

Improved text:`;

    const improved = await callGroq(prompt, 2500);
    await deductCredits(req);
    res.json({ improved: improved.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   SOCIAL PUBLISHING â€” OAuth + Publish
   ENV vars needed:
     INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET
     TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET
     LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
     FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
     APP_BASE_URL  (e.g. https://yourdomain.com)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

// File-backed OAuth state store (survives server restarts)
const oauthPending = oauthStateStore;

const BASE_URL = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

function callbackUrl(platform) {
  return `${BASE_URL}/auth/${platform}/callback`;
}

/* â”€â”€ Status check â€” does the server have API keys configured? â”€â”€ */
app.get('/api/social/status', (req, res) => {
  res.json({
    instagram: !!(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET),
    twitter:   !!(process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_SECRET),
    linkedin:  !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET),
    facebook:  !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET),
  });
});

/* â”€â”€â”€ INSTAGRAM / FACEBOOK OAuth (Meta) â”€â”€â”€ */
// Both use the same Meta OAuth flow; the scope differs
app.get('/auth/instagram', (req, res) => {
  const { INSTAGRAM_APP_ID } = process.env;
  if (!INSTAGRAM_APP_ID) return res.redirect(`/oauth-callback?error=Instagram+app+not+configured`);

  const state = req.query.state || crypto.randomBytes(16).toString('hex');
  oauthPending.set(state, { platform: 'instagram' });

  const url = new URL('https://www.facebook.com/v19.0/dialog/oauth');
  url.searchParams.set('client_id',    INSTAGRAM_APP_ID);
  url.searchParams.set('redirect_uri', callbackUrl('instagram'));
  url.searchParams.set('scope',        'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement');
  url.searchParams.set('response_type','code');
  url.searchParams.set('state',        state);
  res.redirect(url.toString());
});

app.get('/auth/instagram/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/oauth-callback?error=${encodeURIComponent(error)}&platform=instagram`);
  if (!code)  return res.redirect(`/oauth-callback?error=no_code&platform=instagram`);

  try {
    const { INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET } = process.env;
    // Exchange code for token
    const tokenRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?` +
      `client_id=${INSTAGRAM_APP_ID}&client_secret=${INSTAGRAM_APP_SECRET}` +
      `&redirect_uri=${encodeURIComponent(callbackUrl('instagram'))}&code=${code}`);
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error.message);

    // Get long-lived token
    const llRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?` +
      `grant_type=fb_exchange_token&client_id=${INSTAGRAM_APP_ID}&client_secret=${INSTAGRAM_APP_SECRET}` +
      `&fb_exchange_token=${tokenData.access_token}`);
    const llData = await llRes.json();
    const longToken = llData.access_token || tokenData.access_token;

    // Get connected IG Business Account
    const pagesRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${longToken}`);
    const pagesData = await pagesRes.json();
    const page = pagesData.data?.[0];
    let igAccountId = null, acctName = 'Instagram';

    if (page) {
      const igRes = await fetch(`https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${longToken}`);
      const igData = await igRes.json();
      igAccountId = igData.instagram_business_account?.id;
      if (igAccountId) {
        const igInfoRes = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}?fields=username&access_token=${longToken}`);
        const igInfo = await igInfoRes.json();
        acctName = '@' + (igInfo.username || 'account');
      }
    }

    const tokenPayload = JSON.stringify({ accessToken: longToken, igAccountId });
    res.redirect(`/oauth-callback?platform=instagram&token=${encodeURIComponent(tokenPayload)}&account=${encodeURIComponent(acctName)}`);
  } catch(err) {
    console.error('Instagram OAuth error:', err);
    res.redirect(`/oauth-callback?error=${encodeURIComponent(err.message)}&platform=instagram`);
  }
});

app.get('/auth/facebook', (req, res) => {
  const { FACEBOOK_APP_ID } = process.env;
  if (!FACEBOOK_APP_ID) return res.redirect(`/oauth-callback?error=Facebook+app+not+configured`);

  const state = req.query.state || crypto.randomBytes(16).toString('hex');
  oauthPending.set(state, { platform: 'facebook' });

  const url = new URL('https://www.facebook.com/v19.0/dialog/oauth');
  url.searchParams.set('client_id',    FACEBOOK_APP_ID);
  url.searchParams.set('redirect_uri', callbackUrl('facebook'));
  url.searchParams.set('scope',        'pages_show_list,pages_manage_posts,pages_read_engagement');
  url.searchParams.set('response_type','code');
  url.searchParams.set('state',        state);
  res.redirect(url.toString());
});

app.get('/auth/facebook/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/oauth-callback?error=${encodeURIComponent(error)}&platform=facebook`);
  if (!code)  return res.redirect(`/oauth-callback?error=no_code&platform=facebook`);

  try {
    const { FACEBOOK_APP_ID, FACEBOOK_APP_SECRET } = process.env;
    const tokenRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?` +
      `client_id=${FACEBOOK_APP_ID}&client_secret=${FACEBOOK_APP_SECRET}` +
      `&redirect_uri=${encodeURIComponent(callbackUrl('facebook'))}&code=${code}`);
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error.message);

    const pagesRes  = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${tokenData.access_token}`);
    const pagesData = await pagesRes.json();
    const page      = pagesData.data?.[0];
    const acctName  = page?.name || 'Facebook Page';
    const pageToken = page?.access_token || tokenData.access_token;
    const pageId    = page?.id || 'me';

    const tokenPayload = JSON.stringify({ accessToken: pageToken, pageId });
    res.redirect(`/oauth-callback?platform=facebook&token=${encodeURIComponent(tokenPayload)}&account=${encodeURIComponent(acctName)}`);
  } catch(err) {
    console.error('Facebook OAuth error:', err);
    res.redirect(`/oauth-callback?error=${encodeURIComponent(err.message)}&platform=facebook`);
  }
});

/* â”€â”€â”€ TWITTER / X OAuth 2.0 (PKCE) â”€â”€â”€ */
app.get('/auth/twitter', (req, res) => {
  const { TWITTER_CLIENT_ID } = process.env;
  if (!TWITTER_CLIENT_ID) return res.redirect(`/oauth-callback?error=Twitter+app+not+configured`);

  const state        = req.query.state || crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  oauthPending.set(state, { platform: 'twitter', codeVerifier });

  const url = new URL('https://twitter.com/i/oauth2/authorize');
  url.searchParams.set('response_type',         'code');
  url.searchParams.set('client_id',             TWITTER_CLIENT_ID);
  url.searchParams.set('redirect_uri',          callbackUrl('twitter'));
  url.searchParams.set('scope',                 'tweet.write tweet.read users.read media.write offline.access');
  url.searchParams.set('state',                 state);
  url.searchParams.set('code_challenge',        codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  res.redirect(url.toString());
});

app.get('/auth/twitter/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/oauth-callback?error=${encodeURIComponent(error)}&platform=twitter`);
  if (!code)  return res.redirect(`/oauth-callback?error=no_code&platform=twitter`);

  const pending = oauthPending.get(state);
  const codeVerifier = pending?.codeVerifier;
  if (!codeVerifier) return res.redirect(`/oauth-callback?error=invalid_state&platform=twitter`);
  oauthPending.delete(state);

  try {
    const { TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET } = process.env;
    const credentials = Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString('base64');

    const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code, grant_type: 'authorization_code',
        redirect_uri: callbackUrl('twitter'),
        code_verifier: codeVerifier,
      }).toString()
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    // Get user info
    const userRes  = await fetch('https://api.twitter.com/2/users/me', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const userData = await userRes.json();
    const handle   = userData.data?.username ? '@' + userData.data.username : 'X Account';
    const userId   = userData.data?.id;

    const tokenPayload = JSON.stringify({
      accessToken:  tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      userId
    });
    res.redirect(`/oauth-callback?platform=twitter&token=${encodeURIComponent(tokenPayload)}&account=${encodeURIComponent(handle)}`);
  } catch(err) {
    console.error('Twitter OAuth error:', err);
    res.redirect(`/oauth-callback?error=${encodeURIComponent(err.message)}&platform=twitter`);
  }
});

/* â”€â”€â”€ LINKEDIN OAuth 2.0 â”€â”€â”€ */
app.get('/auth/linkedin', (req, res) => {
  const { LINKEDIN_CLIENT_ID } = process.env;
  if (!LINKEDIN_CLIENT_ID) return res.redirect(`/oauth-callback?error=LinkedIn+app+not+configured`);

  const state = req.query.state || crypto.randomBytes(16).toString('hex');
  oauthPending.set(state, { platform: 'linkedin' });

  const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id',     LINKEDIN_CLIENT_ID);
  url.searchParams.set('redirect_uri',  callbackUrl('linkedin'));
  url.searchParams.set('scope',         'openid profile w_member_social');
  url.searchParams.set('state',         state);
  res.redirect(url.toString());
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/oauth-callback?error=${encodeURIComponent(error)}&platform=linkedin`);
  if (!code)  return res.redirect(`/oauth-callback?error=no_code&platform=linkedin`);

  try {
    const { LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET } = process.env;
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  callbackUrl('linkedin'),
        client_id:     LINKEDIN_CLIENT_ID,
        client_secret: LINKEDIN_CLIENT_SECRET,
      }).toString()
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    // Get user profile
    const profileRes  = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const profile  = await profileRes.json();
    const name     = profile.name || profile.localizedFirstName || 'LinkedIn User';
    const personId = profile.sub;

    const tokenPayload = JSON.stringify({ accessToken: tokenData.access_token, personId });
    res.redirect(`/oauth-callback?platform=linkedin&token=${encodeURIComponent(tokenPayload)}&account=${encodeURIComponent(name)}`);
  } catch(err) {
    console.error('LinkedIn OAuth error:', err);
    res.redirect(`/oauth-callback?error=${encodeURIComponent(err.message)}&platform=linkedin`);
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   API: Social Publish
   POST /api/social/publish
   Body: { platform, imageData (base64 PNG), caption, accessToken (JSON string) }
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/social/publish', async (req, res) => {
  const { platform, imageData, caption, accessToken: tokenStr } = req.body;
  if (!platform || !imageData || !tokenStr) {
    return res.status(400).json({ error: 'platform, imageData, and accessToken are required' });
  }

  let tokenObj = {};
  try { tokenObj = JSON.parse(tokenStr); } catch(e) { tokenObj = { accessToken: tokenStr }; }

  // Save image to uploads/
  try {
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer     = Buffer.from(base64Data, 'base64');
    const filename   = `social-${Date.now()}.png`;
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, filename), buffer);
    const imageUrl = `${BASE_URL}/uploads/${filename}`;

    let postUrl = null;

    switch(platform) {
      /* â”€â”€ INSTAGRAM â”€â”€ */
      case 'instagram': {
        const { accessToken, igAccountId } = tokenObj;
        if (!igAccountId) throw new Error('No Instagram Business Account linked. Connect via a Facebook Page that has an Instagram Business Account.');

        // Step 1: Create media container
        const containerRes = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_url: imageUrl, caption, access_token: accessToken })
        });
        const container = await containerRes.json();
        if (container.error) throw new Error(container.error.message);

        // Step 2: Wait 3s for container to process
        await new Promise(r => setTimeout(r, 3000));

        // Step 3: Publish
        const publishRes = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}/media_publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creation_id: container.id, access_token: accessToken })
        });
        const publishData = await publishRes.json();
        if (publishData.error) throw new Error(publishData.error.message);
        postUrl = `https://instagram.com/p/${publishData.id}`;
        break;
      }

      /* â”€â”€ TWITTER/X â”€â”€ */
      case 'twitter': {
        const { accessToken, userId } = tokenObj;

        // Upload media (Twitter v1.1 endpoint)
        const mediaUpRes = await fetch('https://upload.twitter.com/1.1/media/upload.json', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ media_data: base64Data, media_category: 'tweet_image' })
        });
        const mediaData = await mediaUpRes.json();
        if (mediaData.errors) throw new Error(mediaData.errors[0]?.message || 'Media upload failed');
        const mediaId = mediaData.media_id_string;

        // Post tweet
        const tweetRes = await fetch('https://api.twitter.com/2/tweets', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ text: caption || ' ', media: { media_ids: [mediaId] } })
        });
        const tweetData = await tweetRes.json();
        if (tweetData.errors) throw new Error(tweetData.errors[0]?.message || 'Tweet failed');
        postUrl = `https://twitter.com/i/web/status/${tweetData.data?.id}`;
        break;
      }

      /* â”€â”€ LINKEDIN â”€â”€ */
      case 'linkedin': {
        const { accessToken, personId } = tokenObj;
        const author = `urn:li:person:${personId}`;

        // Step 1: Register image upload
        const registerRes = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            registerUploadRequest: {
              recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
              owner: author,
              serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }]
            }
          })
        });
        const registerData = await registerRes.json();
        const uploadUrl  = registerData.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
        const assetUrn   = registerData.value?.asset;
        if (!uploadUrl) throw new Error('LinkedIn upload registration failed');

        // Step 2: Upload image bytes
        await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${accessToken}` },
          body: buffer
        });

        // Step 3: Create post
        const postRes = await fetch('https://api.linkedin.com/v2/ugcPosts', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            author,
            lifecycleState: 'PUBLISHED',
            specificContent: {
              'com.linkedin.ugc.ShareContent': {
                shareCommentary: { text: caption || '' },
                shareMediaCategory: 'IMAGE',
                media: [{ status: 'READY', description: { text: caption || '' }, media: assetUrn, title: { text: 'Post' } }]
              }
            },
            visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
          })
        });
        const postData = await postRes.json();
        if (postData.status >= 400) throw new Error(postData.message || 'LinkedIn post failed');
        postUrl = `https://www.linkedin.com/feed/update/${postData.id}`;
        break;
      }

      /* â”€â”€ FACEBOOK PAGE â”€â”€ */
      case 'facebook': {
        const { accessToken, pageId } = tokenObj;
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/${pageId || 'me'}/photos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: imageUrl, caption, access_token: accessToken, published: true })
        });
        const fbData = await fbRes.json();
        if (fbData.error) throw new Error(fbData.error.message);
        postUrl = `https://facebook.com/${fbData.post_id || fbData.id}`;
        break;
      }

      default:
        throw new Error(`Unknown platform: ${platform}`);
    }

    // Schedule cleanup of temp image after 15 mins
    setTimeout(() => {
      try { fs.unlinkSync(path.join(uploadsDir, filename)); } catch(e){}
    }, 15 * 60 * 1000);

    res.json({ success: true, postUrl });
  } catch(err) {
    console.error(`[social/publish][${platform}]`, err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/oauth-callback', (req, res) => res.sendFile(path.join(__dirname, 'public', 'oauth-callback.html')));

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   ADMIN ROUTES
   Protected by ADMIN_SECRET env var.
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'Admin not configured â€” set ADMIN_SECRET in .env' });
  const provided = req.headers['x-admin-secret'] || req.query.secret;
  if (provided !== secret) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Serve admin.html freely â€” the page itself handles the password lock screen
app.get('/admin', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);

/* User list */
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.json({ note: 'Supabase not connected', users: [] });
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=100`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    const data = await r.json();
    res.json({ users: data.users || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Usage stats */
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.json({ note: 'Supabase not connected' });
  try {
    const h = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
    const safe = v => Array.isArray(v) ? v : [];
    const [subsArr, logsArr] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/subscriptions?select=plan,credits_used,credits_limit`, { headers: h }).then(r => r.json()).then(safe),
      fetch(`${SUPABASE_URL}/rest/v1/usage_logs?select=engine,credits,user_id,created_at&order=created_at.desc&limit=500`, { headers: h }).then(r => r.json()).then(safe),
    ]);
    const totalUsers   = subsArr.length;
    const totalCredits = subsArr.reduce((s, r) => s + (r.credits_used || 0), 0);
    const byPlan       = subsArr.reduce((m, r) => { m[r.plan] = (m[r.plan] || 0) + 1; return m; }, {});
    const byEngine     = logsArr.reduce((m, r) => { m[r.engine] = (m[r.engine] || 0) + (r.credits || 0); return m; }, {});
    const mrr          = subsArr.reduce((s, r) => s + (r.plan === 'pro' ? 29 : r.plan === 'agency' ? 79 : 0), 0);
    res.json({ totalUsers, totalCredits, byPlan, byEngine, mrr, recentLogs: logsArr.slice(0, 50) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   DOCUMENT SHARING
   Creates a time-limited share token,
   stores it in Supabase, returns a URL.
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
/* Change a user's plan */
app.post('/api/admin/user/plan', requireAdmin, async (req, res) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  const { userId, plan } = req.body;
  if (!userId || !plan) return res.status(400).json({ error: 'userId and plan required' });
  const limits = { free: 100, pro: 2000, agency: -1 };
  if (!limits[plan] && limits[plan] !== -1) return res.status(400).json({ error: 'Invalid plan. Use: free, pro, agency' });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ plan, credits_limit: limits[plan] }),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    res.json({ ok: true, plan, credits_limit: limits[plan] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Reset a user's credits */
app.post('/api/admin/user/reset-credits', requireAdmin, async (req, res) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ credits_used: 0 }),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/share', requireAuth, generalLimit, async (req, res) => {
  const { docId, ttlHours = 72 } = req.body;
  if (!docId) return res.status(400).json({ error: 'docId required' });
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL) return res.status(501).json({ error: 'Sharing requires Supabase to be connected' });

  const token   = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  const key     = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/share_links`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${req.userToken || key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ token, doc_id: docId, created_by: req.userId, expires_at: expires }),
    });
    if (!r.ok) throw new Error(await r.text());
    const base = process.env.APP_BASE_URL || `http://localhost:${DEFAULT_PORT}`;
    res.json({ url: `${base}/share/${token}`, expiresAt: expires });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve the share viewer page â€” JS on the page calls /api/share/resolve/:token
app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// JSON endpoint for share.html to fetch document content
app.get('/api/share/resolve/:token', async (req, res) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL) return res.status(501).json({ error: 'Sharing requires Supabase' });
  const key = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/share_links?token=eq.${req.params.token}&select=doc_id,expires_at,created_at`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!r.ok) return res.status(404).json({ error: 'Not found' });
    const [link] = await r.json();
    if (!link) return res.status(404).json({ error: 'Share link not found' });
    if (new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'Link expired' });

    // fetch the actual document
    const dr = await fetch(
      `${SUPABASE_URL}/rest/v1/documents?id=eq.${link.doc_id}&select=title,content,type,updated_at`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!dr.ok) return res.status(404).json({ error: 'Document not found' });
    const [doc] = await dr.json();
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    res.json({
      title:     doc.title || 'Shared document',
      content:   doc.content || '',
      type:      doc.type || 'document',
      shared_at: link.created_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   TRANSACTIONAL EMAIL  (Resend)
   POST /api/email/send
   Body: { to, subject, html }
   Requires RESEND_API_KEY in .env
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/email/send', requireAuth, generalLimit, async (req, res) => {
  const { to, subject, html } = req.body;
  if (!to || !subject || !html) return res.status(400).json({ error: 'to, subject and html are required' });

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(501).json({ error: 'Email sending requires RESEND_API_KEY in .env â€” get a free key at resend.com' });

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'StreamInk Studio <noreply@streamink.studio>',
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Resend error');
    res.json({ success: true, id: data.id });
  } catch (e) {
    console.error('[email/send]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   PASSWORD RESET PAGE
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/forgot-password', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'forgot-password.html'))
);

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   FEEDBACK FORM  POST /api/feedback
   Body: { name, email, use, rating, message }
   Emails submission to FEEDBACK_EMAIL (or falls back to a log)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/feedback', generalLimit, async (req, res) => {
  const { name, email, use, rating, message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const OWNER_EMAIL   = process.env.FEEDBACK_EMAIL || 'mzaydf@gmail.com';
  const resendKey     = process.env.RESEND_API_KEY;
  const stars         = 'â˜…'.repeat(Number(rating) || 0) + 'â˜†'.repeat(5 - (Number(rating) || 0));
  const submittedAt   = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });

  const htmlBody = `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#211C14">
  <div style="background:#4B43C4;padding:24px 28px;border-radius:10px 10px 0 0">
    <h2 style="margin:0;color:#fff;font-size:20px">New feedback â€” StreamInk Studio</h2>
    <p style="margin:6px 0 0;color:rgba(255,255,255,.7);font-size:13px">${submittedAt}</p>
  </div>
  <div style="background:#fff;border:1px solid #E3DACA;border-top:none;border-radius:0 0 10px 10px;padding:24px 28px">
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:8px 0;color:#6E6557;width:110px">From</td><td style="padding:8px 0;font-weight:600">${name || '(anonymous)'}</td></tr>
      <tr><td style="padding:8px 0;color:#6E6557">Email</td><td style="padding:8px 0">${email || '(not provided)'}</td></tr>
      <tr><td style="padding:8px 0;color:#6E6557">Using for</td><td style="padding:8px 0">${use || 'â€”'}</td></tr>
      <tr><td style="padding:8px 0;color:#6E6557">Rating</td><td style="padding:8px 0;font-size:18px;color:#F5A623">${stars}</td></tr>
    </table>
    <div style="margin-top:16px;padding:16px;background:#FBF7EF;border-radius:8px;border-left:3px solid #4B43C4">
      <p style="margin:0;font-size:14px;line-height:1.7;color:#211C14">${message.replace(/\n/g,'<br>')}</p>
    </div>
    ${email ? `<p style="margin-top:16px;font-size:12px;color:#A89E8C">Reply directly to this email to respond to ${name || 'the user'}.</p>` : ''}
  </div>
</div>`;

  // Always log it server-side regardless of email config
  console.log(`[feedback] from=${name||'anon'} rating=${rating} use=${use} msg=${message.slice(0,80)}`);

  if (!resendKey) {
    // No email key â€” still acknowledge success to the user, just can't send
    console.warn('[feedback] RESEND_API_KEY not set â€” feedback logged only');
    return res.json({ ok: true, note: 'Logged (no email key configured)' });
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'StreamInk Studio <noreply@streamink.studio>',
        to:   [OWNER_EMAIL],
        reply_to: email || undefined,
        subject: `[Feedback] ${rating ? stars + ' ' : ''}${name ? `from ${name}` : 'anonymous'} â€” StreamInk`,
        html:  htmlBody,
      }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.message || `Resend ${r.status}`);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[feedback/email]', e.message);
    res.json({ ok: true, note: 'Logged but email failed' }); // still tell user success
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   404 CATCH-ALL
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.use((req, res, next) => {
  // API routes get JSON 404
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  // Pages get branded 404.html
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   GLOBAL ERROR HANDLER
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';
  console.error(`[${status}] ${req.method} ${req.path} â€”`, message);
  if (process.env.ERROR_WEBHOOK_URL) {
    fetch(process.env.ERROR_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, path: req.path, message, ts: new Date().toISOString() }),
    }).catch(() => {});
  }
  res.status(status).json({ error: message });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   START
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function startServer(port, retryLimit = 10) {
  const server = app.listen(port, () => {
    console.log(`Blog Engine running â†’ http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retryLimit > 0) {
      console.warn(`Port ${port} is already in use. Trying ${port + 1}...`);
      setTimeout(() => startServer(port + 1, retryLimit - 1), 100);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}

startServer(DEFAULT_PORT);
