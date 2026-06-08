"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { version: VERSION } = require("./package.json");

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
function cleanWords(value, max) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max);
  const boundary = clipped.lastIndexOf(" ");
  const base = (boundary > 0 ? clipped.slice(0, boundary) : clipped).replace(/[,:;.!?-]+$/, "");
  return `${base.slice(0, max - 1)}.`;
}
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

const vagueHookPattern = /^(try this|do this|stop scrolling|you need this|this changes everything|wait for it|the secret|one simple trick|before you add another task)/i;
function promisedCount(hook) {
  const match = String(hook || "").match(/^(\d+)\s|^(three|four|five)\s/i);
  return match ? Number(match[1] || { three: 3, four: 4, five: 5 }[match[2].toLowerCase()]) : 0;
}
function captionFulfillsPromise(idea) {
  const count = promisedCount(idea.hook);
  return !count || Array.from({ length: count }, (_, index) => String(idea.caption || "").includes(`${index + 1}.`)).every(Boolean);
}

function ideaQuality(idea, input = {}) {
  const hook = clean(idea.hook, 500);
  const body = clean(idea.body, 500);
  const cta = clean(idea.cta, 500);
  const caption = clean(idea.caption, 2000);
  const product = clean(input.product, 80).toLowerCase();
  const audience = clean(input.audience, 120).toLowerCase();
  const stopWords = new Set(["about", "after", "again", "better", "helps", "people", "provides", "their", "there", "these", "those", "through", "using", "with"]);
  const descriptionWords = (clean(input.description, 240).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(word => !stopWords.has(word));
  const hookRelevant = product && hook.toLowerCase().includes(product) ||
    descriptionWords.some(word => hook.toLowerCase().includes(word));
  const bodyRelevant = product && body.toLowerCase().includes(product) ||
    descriptionWords.some(word => body.toLowerCase().includes(word));
  const specific = descriptionWords.some(word => `${hook} ${body}`.toLowerCase().includes(word));
  const bodySpecific = descriptionWords.some(word => body.toLowerCase().includes(word));
  const hasAngle = /\d|pov|why|how|before|after|mistake|warning|what if|we |our |the day|the tiny thing|the small detail|the face|the daily|the moment|the sound|the household rule|the easiest|the best|a completely normal|a real result|ready for|what .+ says|review of today|could text|difference|stop|finally|fewer|without|vs|versus|meet|turn|get to|know|one |cannot|not just|from .+ to |\?/i.test(hook);
  const genericCopy = /chosen with care|clear value, useful details|straightforward next step|next important decision|truly fits|people decide whether|when details matter|the small detail people remember|without enough useful detail/i;
  const hookTerms = (hook.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(word => !stopWords.has(word) && word !== product);
  const bodyContinuesHook = hookTerms.some(word => body.toLowerCase().includes(word)) || descriptionWords.some(word => body.toLowerCase().includes(word));
  const issues = [];
  if (vagueHookPattern.test(hook)) issues.push("Hook is too vague.");
  if (genericCopy.test(`${hook} ${body}`)) issues.push("Copy sounds generic instead of describing a real customer situation.");
  if (/^(everyone|anyone|people|customers?)$/.test(audience)) issues.push("Audience is too broad to create targeted content.");
  if (!hookRelevant) issues.push("Hook needs a clearer product connection.");
  if (!bodyRelevant) issues.push("Supporting line needs a clearer product connection.");
  if (!specific) issues.push("Use a concrete detail from the campaign brief.");
  if (!bodyContinuesHook && !bodySpecific && genericCopy.test(body)) issues.push("Supporting line must directly explain or continue the hook.");
  if (!hasAngle) issues.push("Hook needs a clearer curiosity, value, proof, or pain angle.");
  if (hook.length < 18 || hook.length > 105) issues.push("Hook must be 18–105 characters.");
  if (body.length < 45 || body.length > 145) issues.push("Supporting line must be 45–145 characters.");
  if (cta.length < 8 || cta.length > 34) issues.push("Call to action must be 8–34 characters.");
  if (caption && caption.length < 140) issues.push("Caption needs enough useful information to stand on its own.");
  if (caption && !descriptionWords.some(word => caption.toLowerCase().includes(word))) issues.push("Caption needs a concrete campaign detail.");
  if (/\?$/.test(hook) && caption && caption.split("?").pop().trim().length < 80) issues.push("Caption must answer the hook's question.");
  if (!captionFulfillsPromise(idea)) issues.push("Caption must fulfill every numbered promise in the hook.");
  return { score: Math.max(0, 100 - issues.length * 12), issues };
}

function petIdeas(input) {
  const name = clean(input.product, 80) || "This little star";
  const description = clean(input.description, 240);
  const petType = (description.match(/\b(dog|puppy|cat|kitten|pet)\b/i) || [null, "pet"])[1].toLowerCase();
  const audience = clean(input.audience, 120).split(/,| and | who /i)[0].trim() || `${petType} lovers`;
  const visualStyles = ["orbit", "checklist", "spotlight", "cards", "grid", "waves"];
  const angles = [
    ["Story", `POV: ${name} hears the treat bag from three rooms away`, `${name} proves that a ${petType}'s hearing becomes remarkably selective when snacks are involved.`, "Share your pet's reaction"],
    ["Educate", `3 signs ${name} has trained the humans`, `${name}'s routine shows how quickly a clever ${petType} can turn adorable habits into household rules.`, "Save these funny signs"],
    ["Story", `The tiny thing ${name} does that makes every bad day better`, `${name} reminds ${audience} that a familiar greeting can turn an ordinary moment into the best part of the day.`, "Celebrate the little moments"],
    ["Educate", `Why ${name}'s favorite nap spot is never actually random`, `${name} chooses comfort, familiar scents, and the best view of the room like a true ${petType} strategist.`, "Check your pet's favorite spot"],
    ["Story", `Before ${name}, we thought personal space was real`, `${name} offers a relatable lesson in ${petType} life: closeness is not requested, it is lovingly assumed.`, "Tag a clingy-pet household"],
    ["Educate", `How ${name} asks for attention without saying a word`, `${name} uses eye contact, proximity, and perfectly timed charm to make every request impossible to miss.`, "Notice these quiet signals"],
    ["Story", `The face ${name} makes when dinner is two minutes late`, `${name} turns a tiny schedule change into the kind of dramatic ${petType} moment every pet parent recognizes.`, "Share the dinner-time drama"],
    ["Educate", `Why cute ${petType} videos like ${name}'s stop the scroll`, `${name}'s expressive reactions create an instant story: viewers recognize the feeling before they read the caption.`, "Use this storytelling tip"],
    ["Story", `We tried to photograph ${name}. ${name} had other plans.`, `${name} shows why the funniest ${petType} photos often happen immediately after the carefully planned shot.`, "Post the outtake too"],
    ["Educate", `3 easy ways to capture ${name}'s real personality`, `${name} looks most natural when the camera follows familiar routines instead of forcing a perfect pose.`, "Save the pet-photo checklist"],
    ["Story", `The daily ritual ${name} refuses to skip`, `${name}'s favorite routine turns an ordinary part of the day into a small tradition worth remembering.`, "Share your pet's ritual"],
    ["Educate", `Why ${name} follows you into every single room`, `${name} may be curious, connected, or simply unwilling to miss whatever the humans decide to do next.`, "Learn your pet's signals"],
    ["Story", `One look from ${name}, and the answer is always yes`, `${name} has mastered the universal ${petType} talent of turning eye contact into a highly persuasive argument.`, "Show us that persuasive look"],
    ["Educate", `How to make ${name}'s cute ${petType} post feel like a real story`, `Give ${name}'s moment a setup, one specific personality detail, and a payoff other pet lovers recognize.`, "Try the three-part story"],
    ["Story", `The moment ${name} realized the camera was on`, `${name} went from everyday ${petType} to main character with one perfectly timed look at the lens.`, "Capture the main-character moment"],
    ["Educate", `Why ${name}'s quirks are more memorable than a perfect pose`, `${name}'s unusual habits give people a specific reason to smile, remember the post, and come back again.`, "Lead with the lovable quirk"],
    ["Story", `A completely normal morning, according to ${name}`, `${name}'s version of a normal morning includes strong opinions, strategic naps, and at least one surprise.`, "Tell your pet's morning story"],
    ["Educate", `What ${name}'s body language says in this moment`, `${name}'s posture, ears, eyes, and distance offer useful clues about how this ${petType} is feeling.`, "Watch the full-body story"],
    ["Story", `We bought the toy. ${name} chose the box.`, `${name} delivers a classic ${petType} reminder that the simplest part of a gift is often the most exciting.`, "Share the unexpected favorite"],
    ["Educate", `Why familiar routines help ${name} feel secure`, `Predictable meals, walks, play, and rest give ${name} clear signals about what happens next.`, "Build a comforting routine"],
    ["Story", `The sound that instantly activates ${name}`, `${name} can ignore an entire conversation, then appear immediately when one very specific sound happens.`, "Name your pet's magic sound"],
    ["Educate", `How to photograph ${name} without losing the moment`, `Use natural light, get down to ${name}'s level, and capture a quick sequence instead of waiting for perfection.`, "Save these photo tips"],
    ["Story", `Why nobody gets the best seat when ${name} is home`, `${name} understands that every comfortable chair is really a reserved ${petType} lounge.`, "Show the claimed seat"],
    ["Educate", `Why ${name}'s most relatable videos work so well`, `${name}'s strongest moments pair one recognizable emotion with one unmistakable personality detail.`, "Find the relatable emotion"],
    ["Story", `${name}'s review of today's walk: not nearly long enough`, `${name} gives every walk the same honest ${petType} rating: excellent experience, unacceptable ending.`, "Rate today's walk"],
    ["Educate", `3 details that make ${name}'s captions more engaging`, `${name}'s best captions name the moment, reveal the personality, and invite other pet lovers into the story.`, "Use these caption prompts"],
    ["Story", `The household rule ${name} quietly rewrote`, `${name} proves that every home eventually develops at least one rule designed entirely around the ${petType}.`, "Share the rewritten rule"],
    ["Educate", `Why ${name}'s everyday moments deserve a place online`, `${name}'s small routines create warm, recognizable stories that help ${audience} feel instantly connected.`, "Post the everyday moment"],
    ["Story", `If ${name} could text, this would be the first message`, `${name}'s message would probably be short, specific, and closely related to snacks or immediate attention.`, "Write your pet's first text"],
    ["Promote", `Meet ${name}: proof that cute ${petType} content needs personality`, `${name} turns simple moments into memorable stories by being specific, expressive, and completely authentic.`, `Follow ${name}'s next adventure`]
  ];
  const promiseDetails = {
    1: `Three signs ${name} runs the house:\n1. Humans respond immediately to the treat stare.\n2. The best seat is always reserved.\n3. Daily schedules bend around ${name}.`,
    9: `Three ways to capture ${name}'s personality:\n1. Film a familiar routine.\n2. Keep the camera at ${name}'s level.\n3. Save the funny outtakes.`,
    25: `Three caption details that help ${name} connect:\n1. Name the specific moment.\n2. Reveal one personality quirk.\n3. Ask pet lovers to share theirs.`
  };
  return angles.map(([format, hook, body, cta], index) => {
    const detail = promiseDetails[index] || `${body}\n\nThe strongest post focuses on one specific moment and lets ${name}'s personality carry the story.`;
    const caption = `${hook}\n\n${detail}\n\n${cta}.\n\n#${name.replace(/[^a-z0-9]/gi, "")} #${petType}Life #Cute${petType.charAt(0).toUpperCase() + petType.slice(1)} #PetStories`;
    const item = { day: index + 1, format, hook: cleanWords(hook, 105), body: cleanWords(body, 145), cta: cleanWords(cta, 34), caption, visual: visualStyles[index % visualStyles.length] };
    return { ...item, quality: ideaQuality(item, input).score };
  });
}

function tag(value) {
  return `#${String(value || "").replace(/[^a-z0-9]/gi, "")}`.replace(/^#$/, "#SmallBusiness");
}

function marketIdeas(input, profile) {
  const product = clean(input.product, 80) || "Your brand";
  const rawAudience = clean(input.audience, 120) || profile.audience || "your audience";
  const audience = rawAudience.split(/,| and | who /i)[0].trim() || profile.audience || "your audience";
  const visualStyles = ["orbit", "checklist", "spotlight", "cards", "grid", "waves"];
  const topic = profile.topic;
  const benefit = profile.benefit;
  const pain = profile.pain;
  const outcome = profile.outcome;
  const action = profile.action;
  const proof = profile.proof;
  const risk = profile.risk;
  const moment = profile.moment;
  const category = profile.category || topic;
  const tags = `${tag(product)} ${tag(category)} ${tag(profile.seo || topic)} #LocalBusiness`;
  const captionInsights = [
    `Start with the situation ${audience} already recognize, then show the specific detail that makes ${product} different.`,
    `A useful post earns attention by helping someone recognize a need before asking them to make a decision.`,
    `Specific proof builds more trust than broad claims. Show what is included, who it helps, and what changes next.`,
    `Good planning reduces friction. Give people one detail they can use before ${moment}.`,
    `Name the frustration honestly, then explain the practical choice that makes the experience better.`,
    `The best promotion feels useful first: teach one thing, make the value clear, and invite the next step.`,
    `Small details make a brand memorable because they give people something concrete to picture and repeat.`,
    `Questions turn passive viewers into prepared buyers. Help them compare fit, timing, and expectations.`,
    `Trust grows when ${product} explains why the details matter instead of only saying the result is better.`,
    `A timely reminder works when it connects the upcoming moment to one simple action people can take now.`,
    `Price is only one part of value. Fit, reliability, communication, and the final experience matter too.`,
    `${product} becomes easier to choose when the post clearly connects the offer to ${outcome}.`,
    `Show the moment confidence replaces uncertainty. That emotional shift is often the real customer story.`,
    `A strong fit post helps people rule themselves in or out without pressure, saving time on both sides.`,
    `Transformation content works best when it clearly names the before, the after, and the bridge between them.`,
    `Thoughtful service is visible in small decisions. Make one of those decisions the center of the story.`,
    `Educational content should leave ${audience} better prepared even if they do not buy immediately.`,
    `Reduce choice overload by showing the clearest path to the result instead of listing every possible feature.`,
    `A believable customer journey starts with hesitation and ends with one practical next step.`,
    `Prevention content is strongest when it names the risk and gives people a simple way to avoid it.`,
    `Stress falls when expectations are clear. Explain what happens first, what is included, and what comes next.`,
    `Memorable experiences are easy to describe. Give people a detail they would naturally tell a friend.`,
    `Simple plans work because they reduce decisions at the moment people are already busy or uncertain.`,
    `Clear positioning tells ${audience} why ${product} fits their situation better than a generic alternative.`,
    `Intentional choices create stronger outcomes than last-minute guesses. Show the reason behind the choice.`,
    `Checklists perform well because they turn a vague decision into useful, saveable steps.`,
    `Timely promotion should answer why now, why this offer, and what someone gains by acting.`,
    `The first step should feel small enough to take today and meaningful enough to create momentum.`,
    `Confidence comes from comparing the right details, not from collecting more random options.`,
    `A strong call to action continues the story by making the next step feel natural and specific.`
  ];
  const conciseBodies = [
    `${product} makes ${topic} easier to understand and choose.`,
    `${product} brings clear value and practical detail to ${topic}.`,
    `${product} shows what thoughtful ${topic} can include.`,
    `${product} gives people a clearer way to approach ${topic}.`,
    `${product} replaces uncertainty with useful ${topic} details.`,
    `${product} makes the value behind ${topic} easier to see.`,
    `${product} focuses on the details that make ${topic} memorable.`,
    `${product} helps people ask better questions about ${topic}.`,
    `${product} makes a strong ${topic} choice feel more reliable.`,
    `${product} helps people plan ${topic} with less last-minute stress.`,
    `${product} explains what creates real value in ${topic}.`,
    `${product} connects ${topic} to a result people actually want.`,
    `${product} makes confidence part of the ${topic} experience.`,
    `${product} helps people decide whether ${topic} truly fits.`,
    `${product} creates a clearer path from the problem to ${outcome}.`,
    `${product} uses thoughtful details to improve the whole experience.`,
    `${product} gives people useful context before choosing ${topic}.`,
    `${product} makes the path to ${outcome} easier to follow.`,
    `${product} turns hesitation into a clear and practical next step.`,
    `${product} helps people avoid common mistakes around ${topic}.`,
    `${product} creates clearer expectations around ${topic}.`,
    `${product} makes ${topic} easier to remember and recommend.`,
    `${product} helps people prepare with ${proof}.`,
    `${product} makes the reason to choose ${topic} easier to explain.`,
    `${product} helps people choose ${topic} with more intention.`,
    `${product} turns a vague ${topic} decision into four clear checks.`,
    `${product} makes now useful by helping ${audience} ${action}.`,
    `${product} makes the first step toward ${outcome} concrete with ${proof}.`,
    `${product} helps people compare ${topic} using the details that matter.`,
    `${product} makes the next step toward ${outcome} clear and specific.`
  ];
  const templates = [
    ["Story", `POV: ${audience} find ${topic} that fits the moment`, `${product} helps ${audience} move from ${pain} to ${outcome}.`, `Explore ${product}`],
    ["Educate", `3 signs it is time to try ${product}`, `${product} gives ${audience} ${benefit} without the usual uncertainty.`, "Save these three signs"],
    ["Promote", `Meet ${product}: ${benefit}`, `${product} combines ${proof} for ${audience}.`, `Choose ${product}`],
    ["Story", `Before ${moment}, consider ${product}`, `${product} turns ${topic} into a clearer decision for ${audience}.`, "Plan it with confidence"],
    ["Educate", `Why you should not settle for ${pain}`, `${product} makes ${topic} clearer with useful details and support people can trust.`, "Know what to look for"],
    ["Promote", `How ${product} helps ${audience} ${action}`, `${product} offers ${benefit} around what matters most.`, "See how it works"],
    ["Story", `Why proof changes how people choose ${topic}`, `${product} shows ${proof} in a way ${audience} can understand quickly.`, "Notice the difference"],
    ["Educate", `Before you book ${topic}, ask these three questions`, `The right questions help ${audience} avoid ${risk} and choose the option that actually fits.`, "Use these questions"],
    ["Promote", `Why ${audience} choose ${product} for ${topic}`, `${product} combines ${proof} so ${audience} can choose with more confidence.`, "Start your plan"],
    ["Story", `Why planning ${moment} earlier changes the outcome`, `${product} helps ${audience} prepare for ${moment} with ${proof}.`, "Start earlier"],
    ["Educate", `The difference between cheap and truly valuable ${topic}`, `Value comes from fit, trust, timing, and the details that prevent disappointment later.`, "Compare the right way"],
    ["Promote", `How ${product} makes ${outcome} simpler`, `${product} helps ${audience} skip the guesswork and focus on the result they actually want.`, "Get the better result"],
    ["Story", `How ${product} helps ${audience} know they chose well`, `${product} creates confidence with ${proof}.`, "Look for this moment"],
    ["Educate", `How to tell if ${topic} matches what you actually need`, `${product} makes the choice clearer with ${proof}.`, "Check the fit first"],
    ["Promote", `Turn ${pain} into ${outcome}`, `${product} makes ${action} feel less overwhelming and more doable for ${audience}.`, "Make it easier"],
    ["Story", `One thoughtful detail can change the whole experience`, `${product} uses small, intentional choices to make ${topic} feel more personal and less generic.`, "Lead with the detail"],
    ["Educate", `What ${audience} should know before choosing ${topic}`, `The best choice solves the practical need and feels right for the moment, budget, and person.`, "Save this before choosing"],
    ["Promote", `Why ${product} brings ${benefit} closer`, `${product} connects ${benefit} to ${outcome}.`, "Find your best option"],
    ["Story", `From unsure to excited: the ${product} difference`, `${product} uses ${proof} to make the next step feel clearer.`, "Take the next step"],
    ["Educate", `How to avoid ${risk}`, `Start with the outcome, compare the details, and choose the option that can explain exactly what happens next.`, "Avoid the common mistake"],
    ["Promote", `Get ${topic} without the usual stress`, `${product} helps ${audience} get ${outcome} with clearer expectations and fewer surprises.`, "Make it less stressful"],
    ["Story", `Why people remember a great ${topic} experience`, `People remember how easy it felt, how well the details fit, and whether the result matched the promise.`, "Create a memorable moment"],
    ["Educate", `The easiest way to make ${moment} feel smoother`, `${product} helps ${audience} prepare for ${moment} with ${proof}.`, "Use the simple plan"],
    ["Promote", `Why ${product} makes the choice clearer for ${audience}`, `${product} pairs ${proof} with a direct path from interest to action.`, "Choose with clarity"],
    ["Story", `The best ${topic} starts with a more intentional choice`, `${product} gives ${audience} ${proof} before they commit.`, "Choose intentionally"],
    ["Educate", `4 things to check before saying yes to ${topic}`, `Check the fit, timeline, proof, and communication before you commit.`, "Save the four checks"],
    ["Promote", `Why ${product} is worth considering now`, `${product} helps ${audience} avoid ${pain} and move toward ${outcome}.`, "Consider it today"],
    ["Story", `A real result starts with one clear ${product} decision`, `${product} starts with ${proof}.`, "Make the first decision"],
    ["Educate", `How to choose ${topic} with more confidence`, `Compare the outcome, proof, process, and support instead of choosing from surface details alone.`, "Choose with confidence"],
    ["Promote", `Ready for ${outcome}? Start with ${product}`, `${product} helps ${audience} ${action} with fewer doubts and a clearer reason to act.`, `Start with ${product}`]
  ];
  const promiseDetails = {
    1: `Three signs ${product} may be the right fit:\n1. You want ${benefit}.\n2. You are tired of ${pain}.\n3. You want a choice that feels clear before you commit.`,
    7: `Ask these three questions before booking:\n1. How will this help you ${action}?\n2. Can you see proof such as ${proof}?\n3. How does it prevent ${risk}?`,
    25: `Four checks before saying yes:\n1. Need: will it help you ${action}?\n2. Timing: can it work for ${moment}?\n3. Proof: look for ${proof}.\n4. Risk: can it help prevent ${risk}?`
  };
  const usedBodies = new Set();
  return templates.map(([format, hook, body, cta], index) => {
    let cleanHook = cleanWords(hook, 105);
    let bodyCandidate = body;
    if (bodyCandidate.length > 145) bodyCandidate = conciseBodies[index];
    if (bodyCandidate.length > 145) bodyCandidate = `${product} makes this choice clearer, more useful, and easier to understand.`;
    let cleanBody = cleanWords(bodyCandidate, 145);
    if (/\b(and|or|with|without|to|from|in|a|an|the|that|who|for)\.$/i.test(cleanHook)) {
      cleanHook = cleanWords(`Why ${product} makes ${outcome} easier`, 105);
    }
    if (!cleanHook.toLowerCase().includes(product.toLowerCase()) && ideaQuality({ hook: cleanHook, body: cleanBody, cta }, input).issues.some(issue => issue.startsWith("Hook needs"))) {
      cleanHook = cleanWords(`${product}: ${cleanHook}`, 105);
    }
    if (!cleanBody.toLowerCase().includes(product.toLowerCase()) && ideaQuality({ hook: cleanHook, body: cleanBody, cta }, input).issues.some(issue => issue.startsWith("Supporting line needs"))) {
      cleanBody = cleanWords(`${product} helps ${audience} get ${outcome} with clear, practical support.`, 145);
    }
    if (/\b(and|or|with|without|to|from|in|a|an|the|that|who|for|usual|feels)\.$/i.test(cleanBody) || cleanBody.length < 45) {
      cleanBody = cleanWords(`${product} helps ${audience} get ${outcome} with clear support and fewer surprises.`, 145);
    }
    if (/\b(and|or|with|without|to|from|in|a|an|the|that|who|for|usual|feels)\.$/i.test(cleanBody) || cleanBody.length > 145) {
      cleanBody = conciseBodies[index].length <= 145 ? conciseBodies[index] : `${product} makes this choice clearer, more useful, and easier to understand.`;
    }
    if (usedBodies.has(cleanBody)) cleanBody = conciseBodies[index];
    usedBodies.add(cleanBody);
    const detail = promiseDetails[index] || `${cleanBody}\n\n${captionInsights[index]}`;
    const caption = `${cleanHook}\n\n${detail}\n\n${cleanWords(cta, 34)}.\n\n${tags}`;
    const item = { day: index + 1, format, hook: cleanHook, body: cleanBody, cta: cleanWords(cta, 34), caption, visual: visualStyles[index % visualStyles.length] };
    return { ...item, quality: ideaQuality(item, input).score };
  });
}

function localIdeas(input) {
  const product = clean(input.product, 80) || "Your product";
  const rawAudience = clean(input.audience, 120) || "busy teams";
  const audience = rawAudience.split(/,| and | who /i)[0].trim() || "busy teams";
  const description = clean(input.description, 240) || "get better results with less busywork";
  const sentence = description.replace(/[.!?]+$/, "");
  if (/\b(dog|puppy|cat|kitten|pet)\b/i.test(sentence) && !/grooming|service|owner|salon|appointment/i.test(sentence)) return petIdeas(input);
  const fallbackTopic = sentence
    .replace(/^(help|scan|create|build|make|plan|find|turn|organize|diagnose|generate)\s+/i, "")
    .split(/,| and | by | with | without /i)[0]
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(" ")
    .toLowerCase();
  const profiles = [
    [/clothing|apparel|t-?shirt|vintage pants|fashion|streetwear|outfit|retro style/i, {
      mode: "market", category: "Fashion", seo: "retro clothing", audience,
      topic: "retro-inspired everyday outfits", pain: "generic outfits that do not feel personal", outcome: "an outfit that feels confident and unmistakably yours",
      action: "build a dark retro look with statement pieces", benefit: "retro graphics, vintage-inspired pants, and confident everyday style",
      proof: "distinctive dark designs, wearable statement pieces, and easy outfit combinations", risk: "forgettable basics, awkward outfit pairings, and trend-chasing without personal style", moment: "the next night out or everyday outfit"
    }],
    [/bakery|cake|pastr|sourdough|bread/i, {
      mode: "market", category: "Bakery", seo: "custom cakes", audience,
      topic: "custom cakes and fresh pastries", pain: "last-minute dessert stress", outcome: "a celebration that feels personal and tastes fresh",
      action: "order custom cakes, sourdough, and weekend pastries", benefit: "fresh flavors, thoughtful design, and local bakery care",
      proof: "made-to-order cakes, seasonal pastries, and clear pickup details", risk: "generic cakes, flavor guesswork, and rushed pickup details", moment: "the birthday or weekend gathering"
    }],
    [/realtor|real estate|homebuyer|buy.*home|sell.*home/i, {
      mode: "market", category: "Real Estate", seo: "first time homebuyer", audience,
      topic: "first-home guidance", pain: "guessing through offers, inspections, and neighborhoods", outcome: "a clearer, more confident home purchase",
      action: "find and buy a home with less uncertainty", benefit: "local guidance from search to closing",
      proof: "neighborhood insight, offer strategy, and step-by-step buyer support", risk: "overpaying, missing red flags, and feeling rushed", moment: "the first home search"
    }],
    [/therap|anxiety|boundar|mental health|counsel/i, {
      mode: "market", category: "Therapy", seo: "online therapy", audience,
      topic: "online anxiety support", pain: "carrying anxiety alone after work", outcome: "calmer days and healthier boundaries",
      action: "manage anxiety and build better boundaries", benefit: "private support and practical coping tools",
      proof: "online sessions, simple exercises, and space to talk honestly", risk: "burnout, avoidance, and blurred boundaries", moment: "a stressful week"
    }],
    [/fitness|strength|coach|workout|gym|move better/i, {
      mode: "market", category: "Fitness", seo: "strength coaching", audience,
      topic: "beginner-friendly strength coaching", pain: "intimidating workouts and inconsistent routines", outcome: "stronger movement and more confidence",
      action: "build strength safely and consistently", benefit: "small-group coaching, simple progressions, and supportive accountability",
      proof: "coached form, realistic programming, and progress people can feel", risk: "doing too much too soon, poor form, and quitting early", moment: "the first month back in fitness"
    }],
    [/invoice|payment|bookkeep|accounting|freelance/i, {
      mode: "market", category: "Invoicing", seo: "freelancer invoicing", audience,
      topic: "freelancer invoicing", pain: "late payments and scattered invoice tracking", outcome: "faster payments and cleaner records",
      action: "send invoices and track payments faster", benefit: "simple invoices, payment tracking, and fewer awkward follow-ups",
      proof: "clear invoice status, organized client records, and fast reminders", risk: "missed invoices, unpaid work, and messy bookkeeping", moment: "the end of a client project"
    }],
    [/restaurant|pasta|dinner|date-night|cafe|coffee|food truck/i, {
      mode: "market", category: "Restaurant", seo: "date night restaurant", audience,
      topic: "a memorable date-night dinner", pain: "another forgettable dinner plan", outcome: "a cozy meal worth talking about",
      action: "book a table for handmade food and a better night out", benefit: "handmade dishes, warm service, and a reason to slow down",
      proof: "seasonal ingredients, thoughtful service, and a setting built for conversation", risk: "bland food, noisy rooms, and rushed service", moment: "date night"
    }],
    [/nonprofit|donat|underserved|free books|reading support/i, {
      mode: "market", category: "Nonprofit", seo: "literacy nonprofit", audience,
      topic: "children's reading support", pain: "kids missing books, confidence, and reading practice", outcome: "more children seeing reading as possible",
      action: "support free books and reading help", benefit: "books, encouragement, and practical literacy support",
      proof: "community partnerships, book access, and consistent reading support", risk: "low book access, falling confidence, and missed early support", moment: "a child's next reading milestone"
    }],
    [/skincare|skin|serum|moistur|fragrance-free|beauty/i, {
      mode: "market", category: "Skincare", seo: "sensitive skin care", audience,
      topic: "sensitive-skin skincare", pain: "trial-and-error routines that irritate skin", outcome: "a calmer daily routine",
      action: "build a simple fragrance-free routine", benefit: "gentle formulas and fewer unnecessary steps",
      proof: "fragrance-free products, clear ingredients, and routine-friendly guidance", risk: "irritation, product overload, and confusing ingredient claims", moment: "the morning skincare routine"
    }],
    [/plumb|drain|leak|water heater|home service|repair/i, {
      mode: "market", category: "Plumbing", seo: "emergency plumber", audience,
      topic: "fast plumbing help", pain: "leaks, clogs, and home repairs that cannot wait", outcome: "a safer, working home again",
      action: "book drain cleaning, leak repair, or water heater service", benefit: "quick response and clear repair options",
      proof: "emergency drain cleaning, leak repair, and water heater diagnostics", risk: "water damage, repeat clogs, and surprise repair costs", moment: "a plumbing emergency"
    }],
    [/photograph|wedding|portrait|camera|engaged/i, {
      mode: "market", category: "Photography", seo: "wedding photographer", audience,
      topic: "candid wedding photography", pain: "stiff posing and photos that do not feel like you", outcome: "wedding photos with real emotion",
      action: "capture candid, emotional moments", benefit: "natural direction and honest storytelling",
      proof: "calm guidance, candid coverage, and attention to emotional details", risk: "awkward posing, missed moments, and photos that feel generic", moment: "the wedding day"
    }],
    [/spanish|language|course|lesson|speak confidently/i, {
      mode: "market", category: "Language Learning", seo: "Spanish course", audience,
      topic: "practical Spanish speaking", pain: "memorizing words but freezing in real conversations", outcome: "more confident travel and everyday conversations",
      action: "practice Spanish for real-life situations", benefit: "simple lessons, useful phrases, and confidence-building practice",
      proof: "travel scenarios, speaking practice, and everyday conversation prompts", risk: "unused vocabulary, embarrassment, and forgetting under pressure", moment: "the first real conversation"
    }],
    [/\bfestival\b|\bevent\b|\bconcert\b|music fans|local artists|vendors/i, {
      mode: "market", category: "Events", seo: "community festival", audience,
      topic: "a local community event", pain: "weekend plans that feel repetitive", outcome: "a fun day people can share together",
      action: "bring friends or family to the event", benefit: "live music, local food, and activities for more than one age group",
      proof: "local artists, food vendors, and family-friendly activities", risk: "missing the schedule, parking confusion, and not knowing what to bring", moment: "the festival weekend"
    }],
    [/artist|song|album|single|music|indie pop|band/i, {
      mode: "market", category: "Music", seo: "new indie pop music", audience,
      topic: "new indie pop music", pain: "songs that sound polished but do not feel personal", outcome: "a track listeners want to replay",
      action: "listen to the new release", benefit: "dreamy hooks, honest lyrics, and a mood that sticks",
      proof: "memorable melodies, emotional writing, and a clear visual world", risk: "generic promotion, weak story, and forgettable release posts", moment: "release week"
    }],
    [/legal|law firm|contract|founder|dispute|attorney/i, {
      mode: "market", category: "Legal Services", seo: "small business contracts", audience,
      topic: "small business contract review", pain: "signing unclear contracts and hoping nothing goes wrong", outcome: "fewer expensive disputes",
      action: "review contracts before problems start", benefit: "clear legal guidance for practical business decisions",
      proof: "contract review, plain-English risk notes, and founder-focused next steps", risk: "unclear terms, missed obligations, and expensive disputes", moment: "signing a contract"
    }],
    [/tutor|math|student|grade|homework/i, {
      mode: "market", category: "Tutoring", seo: "online math tutoring", audience,
      topic: "online math tutoring", pain: "homework stress and falling confidence", outcome: "stronger math confidence and better grades",
      action: "help students understand math step by step", benefit: "patient explanations, targeted practice, and visible progress",
      proof: "skill checks, clear explanations, and practice that meets the student where they are", risk: "memorizing steps without understanding and avoiding homework", moment: "the next math test"
    }],
    [/sustainable travel|travel|tour|local guide|trip/i, {
      mode: "market", category: "Travel", seo: "sustainable travel", audience,
      topic: "small-group sustainable travel", pain: "tourist traps and trips that feel disconnected from local life", outcome: "a richer trip with lighter impact",
      action: "travel with local guides in smaller groups", benefit: "local insight, thoughtful pacing, and more responsible experiences",
      proof: "small groups, local guides, and community-minded itineraries", risk: "overcrowded tours, shallow experiences, and avoidable waste", moment: "the next meaningful trip"
    }],
    [/dog grooming|mobile grooming|pet grooming|grooming service/i, {
      mode: "market", category: "Dog Grooming", seo: "mobile dog grooming", audience,
      topic: "mobile dog grooming", pain: "stressful salon drop-offs and messy at-home grooming attempts", outcome: "a cleaner dog without the extra errand",
      action: "book grooming at home", benefit: "convenient grooming, calmer appointments, and a fresh-looking dog",
      proof: "at-home service, coat care, nail trims, and appointment convenience", risk: "matted coats, stressful travel, and skipped grooming routines", moment: "bath day"
    }],
    [/florist|flowers|bouquet|anniversary|gift/i, {
      mode: "market", category: "Florist", seo: "seasonal bouquets", audience,
      topic: "seasonal bouquets", pain: "generic gifts that feel like an afterthought", outcome: "a thoughtful gift that feels personal",
      action: "send seasonal flowers for meaningful moments", benefit: "fresh flowers, local design, and easy gifting",
      proof: "seasonal stems, thoughtful color choices, and delivery or pickup details", risk: "last-minute gifts, wilted flowers, and generic arrangements", moment: "a birthday or anniversary"
    }],
    [/candle|home fragrance|soy wax|home decor/i, {
      mode: "market", category: "Candles", seo: "soy candles", audience,
      topic: "hand-poured soy candles", pain: "overpowering scents and forgettable home decor", outcome: "a calmer evening at home",
      action: "choose a subtle scent for the room", benefit: "subtle fragrance, warm light, and a calmer atmosphere",
      proof: "hand-poured soy wax, balanced scents, and thoughtful packaging", risk: "overpowering fragrance, uneven burns, and impulse-buy clutter", moment: "a quiet evening at home"
    }],
    [/\bcrm\b|sales team|track leads|project management|remote team|organize tasks|deadlines/i, {
      mode: "market", category: "Business Software", seo: "team productivity software", audience,
      topic: "simple team software", pain: "missed follow-ups, scattered tasks, and unclear ownership", outcome: "a more organized team with visible next steps",
      action: "organize work and follow up consistently", benefit: "clear priorities, fewer missed tasks, and easier follow-through",
      proof: "shared status, practical reminders, and one place for the next step", risk: "lost leads, missed deadlines, and duplicated work", moment: "the next busy workweek"
    }],
    [/grocery delivery|fresh food|groceries/i, {
      mode: "market", category: "Grocery Delivery", seo: "grocery delivery", audience,
      topic: "affordable grocery delivery", pain: "last-minute grocery runs and empty-fridge stress", outcome: "fresh food at home with less running around",
      action: "get affordable fresh groceries delivered", benefit: "fresh essentials, simple ordering, and time back",
      proof: "affordable staples, convenient delivery, and family-friendly options", risk: "forgotten ingredients, impulse spending, and another rushed store trip", moment: "a busy weeknight"
    }],
    [/construction|renovation|remodel|kitchen|bathroom|home addition/i, {
      mode: "market", category: "Home Renovation", seo: "home renovation", audience,
      topic: "thoughtful home renovation", pain: "unclear estimates, shifting timelines, and renovation stress", outcome: "a home that works better for daily life",
      action: "plan a kitchen, bathroom, or home addition", benefit: "clear planning, skilled building, and practical design",
      proof: "detailed scopes, realistic timelines, and craftsmanship built for daily use", risk: "scope surprises, poor communication, and expensive rework", moment: "the first renovation consultation"
    }],
    [/hair salon|haircut|hair color|styling|salon/i, {
      mode: "market", category: "Hair Salon", seo: "low maintenance hair", audience,
      topic: "low-maintenance hair", pain: "styles that look good once but are hard to live with", outcome: "hair that feels polished on ordinary days",
      action: "choose a cut or color that fits daily life", benefit: "wearable cuts, thoughtful color, and realistic styling advice",
      proof: "personal consultations, practical upkeep guidance, and styles built around real routines", risk: "high-maintenance color, unclear expectations, and a cut that does not fit", moment: "the next salon appointment"
    }],
    [/dentist|dental|teeth|cleaning|oral care/i, {
      mode: "market", category: "Dentistry", seo: "family dentist", audience,
      topic: "gentle family dental care", pain: "putting off care because appointments feel stressful", outcome: "a healthier smile with less anxiety",
      action: "book preventive or emergency dental care", benefit: "gentle cleanings, clear explanations, and convenient care",
      proof: "preventive visits, calm communication, and help when something hurts", risk: "delayed care, avoidable pain, and dental anxiety", moment: "the next dental appointment"
    }],
    [/childcare|daycare|preschool|toddlers|play-based learning/i, {
      mode: "market", category: "Childcare", seo: "play based preschool", audience,
      topic: "safe play-based childcare", pain: "uncertainty about care, routines, and early learning", outcome: "a safe place where children can grow with confidence",
      action: "choose care that supports play and learning", benefit: "safe routines, caring teachers, and purposeful play",
      proof: "age-appropriate activities, consistent communication, and a welcoming environment", risk: "unclear routines, poor communication, and a setting that does not fit", moment: "the first childcare tour"
    }],
    [/financial advisor|wealth|invest|budget|financial plan/i, {
      mode: "market", category: "Financial Planning", seo: "financial advisor", audience,
      topic: "practical financial planning", pain: "guessing about budgets, investing, and long-term goals", outcome: "a clearer plan for the money ahead",
      action: "budget, invest, and plan long-term goals", benefit: "clear priorities, practical guidance, and a plan that can evolve",
      proof: "goal-based planning, plain-English explanations, and regular progress reviews", risk: "avoiding decisions, chasing trends, and planning without priorities", moment: "the next financial milestone"
    }],
    [/lawn|landscap|yard|garden/i, {
      mode: "market", category: "Lawn Care", seo: "eco friendly lawn care", audience,
      topic: "eco-friendly lawn care", pain: "a struggling yard and harsh chemical treatments", outcome: "a healthier yard that feels good to use",
      action: "care for the yard with fewer harsh chemicals", benefit: "healthier grass, thoughtful landscaping, and lower-impact care",
      proof: "seasonal maintenance, practical planting, and treatment choices explained clearly", risk: "wasted treatments, unhealthy soil, and a yard that never improves", moment: "the start of the growing season"
    }],
    [/personal chef|meal prep|weekly meals|prepared meals/i, {
      mode: "market", category: "Personal Chef", seo: "personal chef meal prep", audience,
      topic: "healthy weekly meal prep", pain: "another week of rushed dinners and takeout decisions", outcome: "good meals at home without nightly planning",
      action: "get healthy weekly meals prepared at home", benefit: "personalized meals, less cleanup, and easier weeknights",
      proof: "menu planning, fresh preparation, and meals matched to household needs", risk: "food waste, repetitive takeout, and stressful dinner decisions", moment: "the start of a busy week"
    }],
    [/pottery|workshop|creative hobby|craft class|art class/i, {
      mode: "market", category: "Creative Workshops", seo: "beginner pottery class", audience,
      topic: "beginner-friendly pottery workshops", pain: "wanting a creative hobby but not knowing where to start", outcome: "a relaxing weekend spent making something real",
      action: "try pottery in a welcoming beginner class", benefit: "hands-on guidance, creative time, and a finished piece",
      proof: "beginner pottery instruction, provided materials, and a relaxed weekend workshop", risk: "intimidating classes, missing supplies, and never making time to begin", moment: "the next free weekend"
    }],
    [/section 508|wcag|accessib/i, {
      topic: "accessibility preflight", pain: "last-minute accessibility issues",
      outcome: "a confident, documented handoff", action: "scan mixed-format deliverables",
      proof: "plain-English fixes and visible remaining risks", asset: "client-ready evidence pack",
      risk: "common Section 508 and WCAG risks"
    }],
    [/short-form|social video|video/i, {
      topic: "short-form video strategy", pain: "inconsistent posting and blank-page fatigue",
      outcome: "a month of publish-ready video ideas", action: "turn one campaign brief into focused clips",
      proof: "strong hooks, captions, and export-ready videos", asset: "ready-to-post content plan",
      risk: "weak hooks and forgettable social posts"
    }],
    [/job search|resume|application/i, {
      topic: "job-search workflow", pain: "scattered applications and repetitive admin",
      outcome: "a calmer, more organized job search", action: "track opportunities and tailor applications",
      proof: "clear status, notes, and next steps", asset: "organized application pipeline",
      risk: "missed follow-ups and generic applications"
    }],
    [/audio|driver|dj controller/i, {
      topic: "audio troubleshooting", pain: "unexplained dropouts and device conflicts",
      outcome: "a stable, performance-ready setup", action: "diagnose drivers, power, and optimizer conflicts",
      proof: "prioritized findings and practical fixes", asset: "diagnostic action plan",
      risk: "hidden Windows audio conflicts"
    }],
    [/science|lab|dilution|biomolecule/i, {
      topic: "lab calculations", pain: "slow calculations and preventable setup errors",
      outcome: "faster, more confident bench work", action: "calculate dilutions and solution prep",
      proof: "clear formulas, units, and reproducible results", asset: "reliable calculation workflow",
      risk: "unit mistakes and wasted reagents"
    }]
  ];
  const profile = (profiles.find(([pattern]) => pattern.test(sentence)) || [null, {
    mode: "market", category: "Small Business", seo: product, audience,
    topic: product, pain: "guessing through a decision without enough useful detail",
    outcome: "a result that fits the real need", action: "choose the next step with more confidence",
    benefit: "clear value, useful details, and a straightforward next step",
    proof: "specific benefits, practical information, and clear expectations",
    risk: "unclear options, rushed decisions, and disappointing results", moment: "the next important decision"
  }])[1];
  if (profile.mode === "market") return marketIdeas(input, profile);
  const { topic, pain, outcome, action, proof, asset, risk } = profile;
  const topicArticle = /^[aeiou]/i.test(topic) ? "an" : "a";
  const captionDetails = [
    `The shift is simple: make ${topic} part of the process instead of a final-minute rescue. Start small, repeat what works, and document the result.`,
    `Three signs to watch:\n1. ${risk} appear late.\n2. Nobody clearly owns the next step.\n3. The team cannot show what was checked or fixed.`,
    `A stronger workflow does more than find a problem. It gives the team ${proof}, so everyone knows what to do next.`,
    `The real cost of a late problem is not only the fix. It is the rushed decisions, repeated approvals, and lost confidence around it.`,
    `Use this three-step method:\n1. Run one consistent check.\n2. Prioritize the highest-impact result.\n3. Record the fix and owner.`,
    `The goal is not more process. It is ${outcome} without forcing the team into another complicated system.`,
    `Moving ${topic} earlier gives people time to make thoughtful fixes instead of choosing whatever is fastest under pressure.`,
    `Before finishing, check three things:\n1. Is the intended outcome clear?\n2. Is the evidence recorded?\n3. Are human-review decisions visible?`,
    `${product} is designed around the final handoff: clear findings, practical next steps, and a record the team can actually use.`,
    `Imagine replacing ${pain} with a repeatable routine. The biggest benefit is not speed alone; it is knowing what happens next.`,
    `One-file checks can miss project-wide patterns. Review the complete workflow to find repeat issues, inconsistent decisions, and ownership gaps.`,
    `Bring the work into one ${asset}. That makes priorities easier to compare, progress easier to track, and open questions harder to lose.`,
    `When someone asks, “How do you know it is ready?” the answer should be more than confidence. Show the method, result, and remaining risks.`,
    `Checking finds issues. Proving records what happened. Strong ${topic} includes the method, result, open questions, and next-step owner.`,
    `Repeatability turns ${topic} from a stressful event into an advantage the team can improve with every project.`,
    `Early feedback protects options. Once approvals, formatting, or delivery are locked, even a small fix can create an expensive revision cycle.`,
    `Automation is best for repeatable checks. Human judgment is still essential for context, quality, and the decisions that affect real people.`,
    `${product} focuses on the next step, not just the finding. Clear guidance helps the team move from problem to finished work faster.`,
    `A shared ${asset} replaces scattered notes and disconnected tools with visible priorities, owners, and open questions.`,
    `Actionable feedback answers four things: What is wrong? Why does it matter? What should change? Who owns the next step?`,
    `Fewer surprises come from making ${topic} visible before it becomes urgent. That is how teams protect both quality and deadlines.`,
    `A strong handoff is short because the hard questions were answered earlier. ${proof} makes the final decision easier to approve.`,
    `Move ${topic} upstream. Earlier improvements are usually faster to make, easier to verify, and less expensive to revisit.`,
    `A real preflight replaces “I think it is ready” with a repeatable check, practical fixes, and a clear path to ${outcome}.`,
    `Look across the whole project for patterns. Fixing a recurring cause once is more valuable than repairing the same symptom in every file.`,
    `Four questions to answer:\n1. What happened?\n2. What changed?\n3. What remains?\n4. Who owns the next step?`,
    `Prioritization keeps the team from drowning in noise. Focus first on work that meaningfully improves the outcome or reduces risk.`,
    `A structured ${topic} gives every stakeholder the same facts, the same open questions, and the same definition of done.`,
    `Build a quality gate with four parts: defined checks, a clear threshold, recorded evidence, and visible human review.`,
    `Knowing before you ship changes the conversation. The team can act with context, show its work, and deliver with confidence.`
  ];
  const visualStyles = ["orbit", "checklist", "spotlight", "cards", "grid", "waves"];
  const ideas = [
    ["Story", `POV: ${audience} finally make ${topic} feel manageable`, `A consistent ${topic} turns stressful last-minute work into ${outcome}.`, "See the better workflow"],
    ["Educate", `3 warning signs ${risk} are slowing you down`, `Catch the pattern early, prioritize the highest-impact fix, and protect the final result.`, "Save this quick checklist"],
    ["Promote", `Meet ${product}: a smarter way to ${action}`, `${product} turns complex work into ${proof}.`, `Explore ${product}`],
    ["Story", `We found ${topicArticle} ${topic} problem the day before delivery`, `Building ${topic} into the process creates time to fix issues before they become emergencies.`, "Fix it before the deadline"],
    ["Educate", `The simplest way to improve your ${topic}`, `Start with one repeatable check, document the result, then act on the clearest next step.`, "Try the three-step method"],
    ["Promote", `What if ${outcome} felt routine?`, `${product} helps ${audience} ${action} without adding another complicated system.`, "See how it works"],
    ["Story", `We stopped treating ${topic} like a final-minute task`, `Moving the work earlier created fewer surprises and a much clearer path to ${outcome}.`, "Build a calmer process"],
    ["Educate", `Before you finish your ${topic}, check these three things`, `For ${topic}, confirm the outcome, record the evidence, and keep human-review decisions visible.`, "Use this before delivery"],
    ["Promote", `Why ${audience} use ${product} before the final handoff`, `Get ${proof} in one focused workflow designed around the work you actually need to ship.`, "See what is included"],
    ["Story", `A day in the life after solving ${pain}`, `Less chasing. Fewer surprises. More time focused on work that moves the project forward.`, "Make the day easier"],
    ["Educate", `Why one-file ${topic} checks can hide the bigger problem`, `For ${topic}, a complete view reveals repeat patterns and gaps that isolated checks often miss.`, "Look at the whole workflow"],
    ["Promote", `${product}: one workspace, every ${topic} next step`, `${product} brings scattered work into one practical ${asset}.`, "Create your action plan"],
    ["Story", `They asked for proof of our ${topic}. We had it.`, `For ${topic}, clear evidence turns a vague promise into a credible result everyone can understand.`, "Document the result"],
    ["Educate", `${topic}: the difference between checking and proving`, `Strong ${topic} workflows record the method, result, open questions, and owner of the next decision.`, "Build stronger evidence"],
    ["Promote", `Turn ${topic} into a repeatable advantage`, `Move from scattered effort to ${outcome} with a workflow the whole team can follow.`, `Build your ${asset}`],
    ["Story", `One early ${topic} fix prevented a painful revision cycle`, `Earlier ${topic} feedback gives the team room to solve problems before time and options disappear.`, "Catch problems earlier"],
    ["Educate", `${topic} automation cannot make every decision`, `Automate repeatable ${topic} checks, then make the moments requiring human judgment impossible to miss.`, "Balance speed and judgment"],
    ["Promote", `${product} explains the next step, not just the problem`, `Practical guidance helps ${audience} move from finding to finished work faster.`, "See clearer recommendations"],
    ["Story", `Our ${topic} process stopped living in five different tools`, `A shared ${asset} keeps ${topic} priorities, owners, and open questions from getting lost.`, "Simplify the workflow"],
    ["Educate", `How to make ${topic} feedback actually actionable`, `For ${topic}, name the issue, explain the impact, show the next step, and assign an owner.`, "Use the action-first format"],
    ["Promote", `Get to ${outcome} with fewer surprises`, `${product} helps teams spot ${risk} and organize the work before it becomes urgent.`, "Start a private project"],
    ["Story", `Our shortest ${topic} handoff was also our strongest`, `For ${topic}, ${proof} made the decision easy to explain, approve, and act on.`, "Prepare a cleaner handoff"],
    ["Educate", `A better result starts before the final version`, `Move ${topic} upstream so improvements are faster, easier, and less expensive to make.`, "Move the work upstream"],
    ["Promote", `Your next project deserves a real preflight`, `Replace last-minute guesswork with ${proof} and a clear path to ${outcome}.`, "Preflight your next project"],
    ["Story", `We found the ${topic} pattern across the whole project`, `A complete ${topic} view reveals repeat problems the team can fix once and prevent next time.`, "Find the recurring problem"],
    ["Educate", `Four questions every strong ${topic} workflow answers`, `For ${topic}: what happened, what changed, what remains, and who owns the next step?`, "Save these four questions"],
    ["Promote", `Why ${product} prioritizes the ${topic} work that matters`, `Prioritized ${topic} steps help ${audience} act on meaningful work instead of drowning in noise.`, "Focus your next project"],
    ["Story", `From scattered ${topic} feedback to one confident decision`, `A structured ${topic} gives every stakeholder the same facts and the same next steps.`, "Align the whole team"],
    ["Educate", `How to create a repeatable ${topic} quality gate`, `For ${topic}, define the checks, set the threshold, record the evidence, and keep human review visible.`, "Build your quality gate"],
    ["Promote", `Know before you ship`, `${product} helps ${audience} turn ${topic} into ${outcome}.`, `Try ${product} privately`]
  ];
  return ideas.map(([format, hook, body, cta], index) => {
    let relevantHook = hook;
    let relevantBody = body;
    const draft = { hook, body, cta };
    const draftIssues = ideaQuality(draft, input).issues;
    if (draftIssues.some(issue => issue.startsWith("Hook needs a clearer product"))) {
      relevantHook = `${product}: ${hook}`;
    }
    if (draftIssues.some(issue => issue.startsWith("Supporting line needs"))) {
      relevantBody = `For ${topic}, ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
    }
    const caption = `${cleanWords(relevantHook, 105)}\n\n${captionDetails[index]}\n\n${cleanWords(relevantBody, 145)}\n\n${cleanWords(cta, 34)}.\n\n#${product.replace(/[^a-z0-9]/gi, "")} #${topic.replace(/[^a-z0-9]/gi, "")} #BetterWorkflows`;
    const item = { day: index + 1, format, hook: cleanWords(relevantHook, 105), body: cleanWords(relevantBody, 145), cta: cleanWords(cta, 34), caption, visual: visualStyles[index % visualStyles.length] };
    return { ...item, quality: ideaQuality(item, input).score };
  });
}

async function ollamaIdeas(input) {
  if (!OLLAMA_MODEL) return null;
  const schema = {
    type: "object",
    properties: {
      ideas: {
        type: "array",
        minItems: 30,
        maxItems: 30,
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
  const prompt = `Create exactly 30 distinct short-form video post ideas for this campaign. The ideas must be usable online, not placeholder copy.

Quality rules:
- The hook must be specific, engaging, and relevant to the product, audience, and description.
- The supporting body must directly answer or continue the hook with a concrete detail from the description.
- The caption must pay off the hook, include useful information, and fully deliver any numbered promise.
- Avoid generic phrases like "right fit", "chosen with care", "clear value", "straightforward next step", or "details matter".
- Do not invent capabilities beyond the description.
- Keep hook <= 105 characters, body <= 145 characters, cta <= 34 characters.

Product: ${clean(input.product, 80)}
Audience: ${clean(input.audience, 120)}
Description: ${clean(input.description, 240)}
Goal: ${clean(input.goal, 80)}

Return only JSON matching this schema: ${JSON.stringify(schema)}`;
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, format: schema }),
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw new Error("Local AI did not respond.");
  const result = await response.json();
  const parsed = JSON.parse(result.response);
  const ideas = Array.isArray(parsed) ? parsed : parsed.ideas;
  if (!Array.isArray(ideas)) return null;
  const generated = ideas.slice(0, 30).map((idea, index) => ({
    day: index + 1, format: ["Story", "Educate", "Promote"].includes(idea.format) ? idea.format : "Story",
    hook: clean(idea.hook, 105), body: clean(idea.body, 145), cta: clean(idea.cta, 34), caption: clean(idea.caption, 1600)
  }));
  const fallback = localIdeas(input);
  const usedHooks = new Set();
  const usedBodies = new Set();
  const usedCtas = new Set();
  return fallback.map((backup, index) => {
    const candidate = generated[index];
    const valid = candidate && candidate.hook && candidate.body && candidate.cta && candidate.caption && captionFulfillsPromise(candidate) &&
      ideaQuality(candidate, input).score >= 75 &&
      !usedHooks.has(candidate.hook) && !usedBodies.has(candidate.body) && !usedCtas.has(candidate.cta);
    const idea = valid ? candidate : backup;
    usedHooks.add(idea.hook); usedBodies.add(idea.body); usedCtas.add(idea.cta);
    return { ...backup, ...idea, day: index + 1, quality: ideaQuality(idea, input).score };
  });
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
module.exports = { start, localIdeas, ideaQuality, hashPassword, verifyPassword };
