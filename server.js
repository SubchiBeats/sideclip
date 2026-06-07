"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");

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
  "/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest",
  "/sw.js", "/icon.svg", "/privacy.html"
]);
const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".weba": "audio/webm"
};
const uploadTypes = new Set(["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm"]);
const sessions = new Map();
const attempts = new Map();
let db = { users: [], projects: [], assets: [] };
let writeQueue = Promise.resolve();
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
  for (const [key, times] of attempts) {
    const recent = times.filter(time => now - time < 60_000);
    if (recent.length) attempts.set(key, recent);
    else attempts.delete(key);
  }
}, 60 * 60 * 1000).unref();

function securityHeaders(extra = {}) {
  const headers = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://127.0.0.1:11434; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
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
function clean(value, max = 5000) { return String(value || "").trim().slice(0, max); }
function safeUser(user) { return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt }; }
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(part => {
    const at = part.indexOf("=");
    return [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1))];
  }));
}
function currentUser(req) {
  const token = cookies(req).sideclip_session;
  const session = token && sessions.get(token);
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
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_AGE * 1000 });
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

function localIdeas(input) {
  const product = clean(input.product, 80) || "Your product";
  const audience = clean(input.audience, 120) || "your audience";
  const result = clean(input.description, 240) || "get a better result";
  const types = ["Story", "Educate", "Promote"];
  const hooks = [
    `POV: ${audience} finally found a better way`,
    `3 mistakes stopping ${audience} from moving faster`,
    `Meet ${product}: less busywork, more progress`,
    `The moment I stopped doing everything the hard way`,
    `A simple framework to ${result.toLowerCase()}`,
    `What if ${result.toLowerCase()} felt easy?`,
    `I thought I needed more discipline. I needed a better system.`,
    `Try this before you add another task`,
    `${product} was built for people who are done settling`,
    `A day in the life after simplifying the work`
  ];
  return Array.from({ length: 30 }, (_, index) => ({
    day: index + 1,
    format: types[index % 3],
    hook: hooks[index % hooks.length],
    body: `${product} helps ${audience} ${result.charAt(0).toLowerCase()}${result.slice(1).replace(/\.$/, "")}.`,
    cta: `Try ${product} today`
  }));
}

async function ollamaIdeas(input) {
  if (!OLLAMA_MODEL) return null;
  const prompt = `Create exactly 30 short-form video ideas as JSON array. Each object needs day, format (Story, Educate, or Promote), hook, body, cta. Product: ${clean(input.product, 80)}. Audience: ${clean(input.audience, 120)}. Description: ${clean(input.description, 240)}. Goal: ${clean(input.goal, 80)}. Return JSON only.`;
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, format: "json" }),
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw new Error("Local AI did not respond.");
  const result = await response.json();
  const parsed = JSON.parse(result.response);
  const ideas = Array.isArray(parsed) ? parsed : parsed.ideas;
  return ideas.slice(0, 30).map((idea, index) => ({
    day: index + 1, format: ["Story", "Educate", "Promote"].includes(idea.format) ? idea.format : "Story",
    hook: clean(idea.hook, 180), body: clean(idea.body, 300), cta: clean(idea.cta, 100)
  }));
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
    return send(res, 200, { ok: true, ai: OLLAMA_MODEL ? "ollama" : "offline", version: "1.0.0" });
  }
  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = currentUser(req);
    return send(res, 200, { user: user ? safeUser(user) : null, ai: OLLAMA_MODEL ? "ollama" : "offline" });
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
    await saveDb();
    return send(res, 201, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(makeSession(user.id)) });
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    if (rateLimited(req, "auth", 8)) return send(res, 429, { error: "Too many attempts. Wait one minute." });
    const input = await body(req);
    const user = db.users.find(item => item.email === clean(input.email, 160).toLowerCase());
    if (!user || !(await verifyPassword(String(input.password || ""), user.password))) return send(res, 401, { error: "Incorrect email or password." });
    return send(res, 200, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(makeSession(user.id)) });
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    sessions.delete(cookies(req).sideclip_session);
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
    for (const [token, session] of sessions) if (session.userId === user.id) sessions.delete(token);
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
module.exports = { start, localIdeas, hashPassword, verifyPassword };
