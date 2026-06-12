"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { version: VERSION } = require("./package.json");
const { clean, ideaQuality, localIdeas, parseAvoid, voices, voiceOf, goalDirections } = require("./generator.js");

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 16 * 1024 * 1024;
const SESSION_AGE = 60 * 60 * 24 * 30;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "";

const staticFiles = new Set([
  "/", "/index.html", "/styles.css", "/app.js", "/generator.js", "/manifest.webmanifest",
  "/theme.js", "/sw.js", "/icon.svg", "/privacy.html"
]);
const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".weba": "audio/webm"
};
const uploadTypes = new Set(["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm"]);
const attempts = new Map();
let db = { users: [], projects: [], assets: [], sessions: [] };
let writeQueue = Promise.resolve();
setInterval(async () => {
  const now = Date.now();
  const sessionCount = db.sessions.length;
  db.sessions = db.sessions.filter(session => session.expiresAt >= now);
  if (db.sessions.length !== sessionCount) await saveDb();
  for (const [key, times] of attempts) {
    const recent = times.filter(time => now - time < 60_000);
    if (recent.length) attempts.set(key, recent);
    else attempts.delete(key);
  }
}, 60 * 60 * 1000).unref();

function securityHeaders(extra = {}) {
  const headers = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...extra
  };
  if (process.env.NODE_ENV === "production") headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, securityHeaders({
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    ...headers
  }));
  res.end(data);
}

function id() { return crypto.randomBytes(16).toString("hex"); }
function safeUser(user) { return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt }; }
function tokenHash(token) { return crypto.createHash("sha256").update(String(token || "")).digest("hex"); }
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(part => {
    const at = part.indexOf("=");
    return [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1))];
  }));
}
function currentUser(req) {
  const token = cookies(req).sideclip_session;
  const session = token && db.sessions.find(item => item.tokenHash === tokenHash(token));
  if (!session || session.expiresAt < Date.now()) return null;
  return db.users.find(user => user.id === session.userId) || null;
}
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) send(res, 401, { error: "Please sign in first." });
  return user;
}
function rateLimited(req, bucket = "default", max = 30) {
  const key = `${req.socket.remoteAddress}:${bucket}`;
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(time => now - time < 60_000);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > max;
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request is too large."), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON."), { status: 400 }); }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derived) => error ? reject(error) : resolve(`${salt}:${derived.toString("hex")}`));
  });
}
async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const candidate = await hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(`${salt}:${hash}`));
}
function sessionCookie(token, clear = false) {
  return `sideclip_session=${clear ? "" : token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : SESSION_AGE}${process.env.COOKIE_SECURE === "true" ? "; Secure" : ""}`;
}
function makeSession(userId) {
  const token = id();
  db.sessions.push({ tokenHash: tokenHash(token), userId, expiresAt: Date.now() + SESSION_AGE * 1000 });
  return token;
}
async function saveDb() {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const temp = `${DB_FILE}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(db, null, 2));
    await fsp.rename(temp, DB_FILE);
  });
  return writeQueue;
}

function ollamaSchema(count) {
  return {
    type: "object",
    properties: {
      ideas: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          properties: {
            format: { type: "string", enum: ["Story", "Educate", "Promote"] },
            hook: { type: "string" },
            body: { type: "string" },
            cta: { type: "string" },
            caption: { type: "string" }
          },
          required: ["format", "hook", "body", "cta", "caption"]
        }
      }
    },
    required: ["ideas"]
  };
}

function ollamaPrompt(input, count, usedHooks = new Set(), revisions = null) {
  const voice = voices[voiceOf(input)];
  const goalDirection = goalDirections[clean(input.goal, 80)] || "";
  const avoid = parseAvoid(input.avoid);
  const task = revisions
    ? `You previously wrote drafts that failed editorial review. Rewrite each draft so it passes, fixing every piece of feedback while keeping a similar topic:\n${revisions.map((item, index) => `${index + 1}. Draft hook: "${item.idea.hook}" | Draft body: "${item.idea.body}" | Feedback: ${item.issues.join(" ")}`).join("\n")}`
    : `Create exactly ${count} distinct short-form video post ideas for this campaign. The ideas must be usable online, not placeholder copy.`;
  return `You write social media content for one specific business. ${task}

Campaign:
- Product: ${clean(input.product, 80)}
- Audience: ${clean(input.audience, 120)}
- Description: ${clean(input.description, 240)}
- ${voice.direction}${goalDirection ? `\n- ${goalDirection}` : ""}

Quality rules:
- Write for this exact business and audience; never invent capabilities, prices, or claims beyond the description.
- The hook must be specific, engaging, and mention the product or a concrete detail from the description.
- The supporting body must directly answer or continue the hook with a concrete detail from the description.
- The caption must stand alone: restate the hook's payoff, add useful detail from the description, and end with the call to action. Make every caption at least 160 characters.
- If a hook promises a number (such as "3 signs"), the caption must list that many items, numbered "1." "2." "3.".
- Vary the angle: customer stories, common mistakes, how-to steps, comparisons, behind the scenes, proof, questions answered, and timely moments.
- Avoid generic phrases like "right fit", "chosen with care", "clear value", "straightforward next step", "game changer", or "details matter".
${avoid.length ? `- Never use these words: ${avoid.join(", ")}.\n` : ""}${usedHooks.size ? `- Do not reuse or closely echo these hooks already in the plan: ${[...usedHooks].slice(-12).join(" | ")}\n` : ""}- The cta is a short button label: a complete phrase of 8-32 characters with no hashtags.
- Use complete sentences. Keep hook <= 100 characters and body <= 140 characters.

Return only JSON with an "ideas" array of exactly ${count} items.`;
}

async function ollamaBatch(input, count, usedHooks, revisions = null) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL,
      prompt: ollamaPrompt(input, count, usedHooks, revisions),
      stream: false,
      format: ollamaSchema(count)
    }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error("Local AI did not respond.");
  const result = await response.json();
  const parsed = JSON.parse(result.response);
  const ideas = Array.isArray(parsed) ? parsed : parsed.ideas;
  if (!Array.isArray(ideas)) return [];
  // Length violations are left intact so the reviewer rejects them and the
  // retry prompt asks for a rewrite - truncating here would ship fragments.
  return ideas.slice(0, count).map(idea => ({
    format: ["Story", "Educate", "Promote"].includes(idea.format) ? idea.format : "Story",
    hook: clean(idea.hook, 400),
    body: clean(idea.body, 400),
    cta: clean(idea.cta, 200),
    caption: clean(idea.caption, 1600)
  }));
}

async function ollamaIdeas(input) {
  if (!process.env.OLLAMA_MODEL) return null;
  const batchSize = 6;
  const slots = new Array(30).fill(null);
  const used = { hooks: new Set(), bodies: new Set(), ctas: new Set() };
  const rejected = [];
  const review = idea => {
    if (!idea || !idea.hook || !idea.body || !idea.cta || !idea.caption) return { ok: false, issues: ["The idea is missing required fields."] };
    const quality = ideaQuality(idea, input);
    const issues = [...quality.issues];
    if (used.hooks.has(idea.hook)) issues.push("This hook already appears in the plan; take a different angle.");
    if (used.bodies.has(idea.body)) issues.push("This supporting line already appears in the plan.");
    if (used.ctas.has(idea.cta)) issues.push("This call to action already appears in the plan.");
    return { ok: quality.blockers.length === 0 && quality.score >= 88 && issues.length === quality.issues.length, issues };
  };
  const accept = (idea, slot) => {
    slots[slot] = idea;
    used.hooks.add(idea.hook);
    used.bodies.add(idea.body);
    used.ctas.add(idea.cta);
  };
  for (let start = 0; start < 30; start += batchSize) {
    let batch = [];
    try { batch = await ollamaBatch(input, batchSize, used.hooks); } catch {}
    for (let offset = 0; offset < batchSize; offset++) {
      const idea = batch[offset];
      const verdict = review(idea);
      if (verdict.ok) accept(idea, start + offset);
      else if (idea && idea.hook) rejected.push({ slot: start + offset, idea, issues: verdict.issues });
    }
  }
  for (let start = 0; start < rejected.length; start += batchSize) {
    const group = rejected.slice(start, start + batchSize).filter(item => slots[item.slot] === null);
    if (!group.length) continue;
    let revised = [];
    try { revised = await ollamaBatch(input, group.length, used.hooks, group); } catch {}
    revised.forEach((idea, index) => {
      const target = group[index];
      if (target && slots[target.slot] === null && review(idea).ok) accept(idea, target.slot);
    });
  }
  const fallback = localIdeas(input);
  const finalUsed = { hooks: new Set(), bodies: new Set(), ctas: new Set() };
  fallback.forEach((backup, index) => {
    if (!slots[index]) { finalUsed.hooks.add(backup.hook); finalUsed.bodies.add(backup.body); finalUsed.ctas.add(backup.cta); }
  });
  let aiCount = 0;
  const plan = fallback.map((backup, index) => {
    const idea = slots[index];
    const usable = idea && !finalUsed.hooks.has(idea.hook) && !finalUsed.bodies.has(idea.body) && !finalUsed.ctas.has(idea.cta);
    const chosen = usable ? idea : backup;
    finalUsed.hooks.add(chosen.hook);
    finalUsed.bodies.add(chosen.body);
    finalUsed.ctas.add(chosen.cta);
    if (usable) aiCount++;
    return { ...backup, ...chosen, day: index + 1, quality: ideaQuality(chosen, input).score };
  });
  return aiCount ? plan : null;
}

async function api(req, res, url) {
  if (rateLimited(req, "api", 120)) return send(res, 429, { error: "Too many requests. Try again shortly." });
  if (req.method !== "GET") {
    const origin = req.headers.origin;
    let originHost = "";
    try { originHost = origin ? new URL(origin).host : ""; } catch {}
    if (origin && originHost !== req.headers.host) return send(res, 403, { error: "Cross-origin requests are not allowed." });
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "Use application/json." });
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, ai: OLLAMA_MODEL ? "ollama" : "offline", version: VERSION });
  }
  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = currentUser(req);
    return send(res, 200, { user: user ? safeUser(user) : null, ai: OLLAMA_MODEL ? "ollama" : "offline", version: VERSION });
  }
  if (req.method === "POST" && url.pathname === "/api/register") {
    if (rateLimited(req, "auth", 8)) return send(res, 429, { error: "Too many attempts. Wait one minute." });
    const input = await body(req);
    const name = clean(input.name, 60);
    const email = clean(input.email, 160).toLowerCase();
    const password = String(input.password || "");
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) return send(res, 400, { error: "Use a name, valid email, and password of at least 10 characters." });
    if (db.users.some(user => user.email === email)) return send(res, 409, { error: "An account already exists for this email." });
    const user = { id: id(), name, email, password: await hashPassword(password), createdAt: new Date().toISOString() };
    db.users.push(user);
    const token = makeSession(user.id);
    await saveDb();
    return send(res, 201, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(token) });
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    if (rateLimited(req, "auth", 8)) return send(res, 429, { error: "Too many attempts. Wait one minute." });
    const input = await body(req);
    const user = db.users.find(item => item.email === clean(input.email, 160).toLowerCase());
    if (!user || !(await verifyPassword(String(input.password || ""), user.password))) return send(res, 401, { error: "Incorrect email or password." });
    const token = makeSession(user.id);
    await saveDb();
    return send(res, 200, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(token) });
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    const hash = tokenHash(cookies(req).sideclip_session);
    db.sessions = db.sessions.filter(session => session.tokenHash !== hash);
    await saveDb();
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", true) });
  }
  if (req.method === "POST" && url.pathname === "/api/generate") {
    const input = await body(req);
    let ideas;
    let engine = "offline";
    try {
      ideas = await ollamaIdeas(input);
      if (ideas) engine = "ollama";
    } catch {}
    return send(res, 200, { ideas: ideas || localIdeas(input), engine });
  }

  const user = requireUser(req, res);
  if (!user) return;
  if (req.method === "GET" && url.pathname === "/api/projects") {
    return send(res, 200, { projects: db.projects.filter(project => project.userId === user.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
  }
  if (req.method === "POST" && url.pathname === "/api/projects") {
    const input = await body(req);
    const now = new Date().toISOString();
    const existing = input.id && db.projects.find(project => project.id === input.id && project.userId === user.id);
    const project = existing || { id: id(), userId: user.id, createdAt: now };
    project.name = clean(input.name, 100) || "Untitled campaign";
    project.data = input.data && typeof input.data === "object" ? input.data : {};
    project.updatedAt = now;
    if (!existing) db.projects.push(project);
    await saveDb();
    return send(res, existing ? 200 : 201, { project });
  }
  const projectMatch = url.pathname.match(/^\/api\/projects\/([a-f0-9]+)$/);
  if (req.method === "DELETE" && projectMatch) {
    const before = db.projects.length;
    db.projects = db.projects.filter(project => !(project.id === projectMatch[1] && project.userId === user.id));
    if (db.projects.length === before) return send(res, 404, { error: "Project not found." });
    await saveDb();
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/uploads") {
    const input = await body(req);
    const mime = clean(input.type, 50);
    if (!uploadTypes.has(mime) || !String(input.data || "").startsWith(`data:${mime};base64,`)) return send(res, 400, { error: "Upload a supported image, video, or audio file." });
    const bytes = Buffer.from(input.data.split(",")[1], "base64");
    if (bytes.length > 10 * 1024 * 1024) return send(res, 413, { error: "Files must be under 10 MB." });
    const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".ogg", "audio/webm": ".weba" }[mime];
    const asset = { id: id(), userId: user.id, name: clean(input.name, 120), type: mime, url: `/media/${user.id}/${id()}${ext}`, createdAt: new Date().toISOString() };
    const target = path.join(DATA_DIR, asset.url.slice(1));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, bytes);
    db.assets.push(asset);
    await saveDb();
    return send(res, 201, { asset });
  }
  if (req.method === "GET" && url.pathname === "/api/assets") {
    return send(res, 200, { assets: db.assets.filter(asset => asset.userId === user.id) });
  }
  if (req.method === "GET" && url.pathname === "/api/export") {
    return send(res, 200, {
      exportedAt: new Date().toISOString(),
      user: safeUser(user),
      projects: db.projects.filter(project => project.userId === user.id),
      assets: db.assets.filter(asset => asset.userId === user.id)
    }, { "Content-Disposition": "attachment; filename=sideclip-export.json" });
  }
  if (req.method === "DELETE" && url.pathname === "/api/account") {
    const ownedAssets = db.assets.filter(asset => asset.userId === user.id);
    for (const asset of ownedAssets) await fsp.rm(path.join(DATA_DIR, asset.url.slice(1)), { force: true });
    db.users = db.users.filter(item => item.id !== user.id);
    db.projects = db.projects.filter(project => project.userId !== user.id);
    db.assets = db.assets.filter(asset => asset.userId !== user.id);
    db.sessions = db.sessions.filter(session => session.userId !== user.id);
    await saveDb();
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", true) });
  }
  send(res, 404, { error: "Not found." });
}

async function serve(req, res, url) {
  let file;
  if (url.pathname.startsWith("/media/")) {
    const user = currentUser(req);
    if (!user || !url.pathname.startsWith(`/media/${user.id}/`)) return send(res, 403, { error: "Forbidden." });
    file = path.join(DATA_DIR, url.pathname.slice(1));
  } else {
    if (!staticFiles.has(url.pathname)) return send(res, 404, "Not found.");
    file = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  }
  try {
    const stat = await fsp.stat(file);
    const headers = { "Content-Type": mimeTypes[path.extname(file)] || "application/octet-stream", "Content-Length": stat.size };
    res.writeHead(200, securityHeaders(headers));
    fs.createReadStream(file).pipe(res);
  } catch { send(res, 404, "Not found."); }
}

async function start() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  try { db = JSON.parse(await fsp.readFile(DB_FILE, "utf8")); } catch { await saveDb(); }
  db.users = Array.isArray(db.users) ? db.users : [];
  db.projects = Array.isArray(db.projects) ? db.projects : [];
  db.assets = Array.isArray(db.assets) ? db.assets : [];
  db.sessions = Array.isArray(db.sessions) ? db.sessions.filter(session => session.expiresAt >= Date.now()) : [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else await serve(req, res, url);
    } catch (error) {
      console.error(error);
      send(res, error.status || 500, { error: error.status ? error.message : "Something went wrong." });
    }
  });
  server.listen(PORT, HOST, () => console.log(`SideClip running at http://${HOST}:${PORT}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

if (require.main === module) start();
module.exports = { start, localIdeas, ideaQuality, hashPassword, verifyPassword, ollamaIdeas, ollamaPrompt };
