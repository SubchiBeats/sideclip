"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { localIdeas, ideaQuality, hashPassword, verifyPassword, ollamaIdeas, ollamaPrompt } = require("../server");
const { cleanWords } = require("../generator");

const ollamaInput = { product: "FocusFlow", audience: "busy creative freelancers", description: "Plan their week, block distractions, and get meaningful work done without burning out." };
function aiIdea(n) {
  return {
    format: "Story",
    hook: `Why FocusFlow protects week plan number ${n} from chaos`,
    body: `FocusFlow plans your week around protected focus blocks and fewer distractions, variation ${n}.`,
    cta: `Plan week ${n} with FocusFlow`,
    caption: `Why FocusFlow protects week plan number ${n} from chaos. FocusFlow plans your week around protected focus blocks, fewer distractions, and meaningful work you can finish without burning out. Plan week ${n} with FocusFlow today.`
  };
}
function stubResponse(ideas) {
  return { ok: true, json: async () => ({ response: JSON.stringify({ ideas }) }) };
}

test("offline generator returns thirty structured ideas", () => {
  const ideas = localIdeas({ product: "SideClip", audience: "creators", description: "ship video faster" });
  assert.equal(ideas.length, 30);
  assert.deepEqual(new Set(ideas.map(idea => idea.format)), new Set(["Story", "Educate", "Promote"]));
  assert.ok(ideas.every(idea => idea.hook && idea.body && idea.cta));
  assert.equal(new Set(ideas.map(idea => idea.hook)).size, 30);
  assert.equal(new Set(ideas.map(idea => idea.body)).size, 30);
  assert.equal(new Set(ideas.map(idea => idea.cta)).size, 30);
  assert.equal(new Set(ideas.map(idea => idea.caption)).size, 30);
  assert.equal(new Set(ideas.map(idea => idea.visual)).size, 6);
  assert.ok(ideas.every(idea => idea.body.length <= 145));
  assert.ok(ideas.every(idea => idea.cta.length <= 34));
  assert.ok(ideas.every(idea => ideaQuality(idea, { product: "SideClip", description: "ship video faster" }).score === 100));
});

test("offline supporting copy stays concise for long campaign briefs", () => {
  const ideas = localIdeas({
    product: "AccessReady",
    audience: "Government contractors, communications teams, small agencies, universities, nonprofits, and public-sector freelancers",
    description: "Scan mixed-format communications deliverables for common Section 508 and WCAG accessibility risks, explain fixes in plain English, organize remediation, and generate client-ready evidence packs before content is published or delivered."
  });
  assert.equal(new Set(ideas.map(idea => idea.body)).size, 30);
  assert.ok(ideas.every(idea => idea.body.length <= 145));
  assert.ok(ideas.every(idea => !idea.body.endsWith(" scan")));
  assert.match(ideas.map(idea => idea.body).join(" "), /preflight|review|delivery|evidence/i);
  assert.match(ideas[0].body, /accessibility preflight/i);
  const numbered = ideas.find(idea => idea.hook.startsWith("3 warning signs"));
  assert.match(numbered.caption, /1\./);
  assert.match(numbered.caption, /2\./);
  assert.match(numbered.caption, /3\./);
  const fourQuestions = ideas.find(idea => idea.hook.startsWith("Four questions"));
  assert.match(fourQuestions.caption, /4\./);
  assert.ok(ideas.every(idea => ideaQuality(idea, {
    product: "AccessReady",
    description: "Scan mixed-format communications deliverables for common Section 508 and WCAG accessibility risks, explain fixes in plain English, organize remediation, and generate client-ready evidence packs before content is published or delivered."
  }).score === 100));
});

test("offline generator adapts to personality and pet briefs", () => {
  const input = { product: "mork", audience: "dog lovers", description: "mork is a cute dog" };
  const ideas = localIdeas(input);
  assert.equal(ideas.length, 30);
  assert.ok(ideas.every(idea => /mork|dog/i.test(`${idea.hook} ${idea.body} ${idea.caption}`)));
  assert.ok(ideas.every(idea => !/workflow/i.test(`${idea.hook} ${idea.body}`)));
  assert.ok(ideas.every(idea => ideaQuality(idea, input).score === 100));
  assert.match(ideas[1].caption, /1\./);
  assert.match(ideas[1].caption, /2\./);
  assert.match(ideas[1].caption, /3\./);
});

test("offline generator does not leak internal workflow labels into video briefs", () => {
  const ideas = localIdeas({ product: "SideClip", audience: "creators", description: "ship video faster" });
  const joined = ideas.map(idea => `${idea.hook} ${idea.body} ${idea.caption}`).join(" ");
  assert.doesNotMatch(joined, /short-form video workflow/i);
  assert.ok(ideas.every(idea => ideaQuality(idea, { product: "SideClip", description: "ship video faster" }).score === 100));
});

test("fashion briefs create specific posts and broad audiences lower readiness", () => {
  const description = "Provides retro style T shirts and vintage pants with cool dark designs that help people dress with confidence.";
  const targeted = { product: "ClothingIO", audience: "21-30 retro fashion buyers", description };
  assert.ok(localIdeas(targeted).every(idea => ideaQuality(idea, targeted).score === 100));

  const broad = { ...targeted, audience: "everyone" };
  assert.ok(localIdeas(broad).every(idea => ideaQuality(idea, broad).score < 100));
});

test("publish readiness separates render blockers from advisory guidance", () => {
  const input = { product: "FocusFlow", audience: "freelancers", description: "Plan their week, block distractions, and get meaningful work done" };
  const caption = "FocusFlow helps you plan the week with focus blocks, distraction limits, and a realistic schedule you can actually follow, so the important work gets finished.";
  const blocked = ideaQuality({ hook: "Why FocusFlow protects your weekly plan from chaos", body: "Too short.", cta: "Try FocusFlow today", caption }, input);
  assert.ok(blocked.blockers.includes("Supporting line must be 45–145 characters."));
  assert.ok(blocked.blockers.every(issue => blocked.issues.includes(issue)));
  const advisory = ideaQuality({
    hook: "Why FocusFlow protects your weekly plan from chaos",
    body: "FocusFlow plans your week around two protected deep work blocks every single day.",
    cta: "Try FocusFlow today", caption
  }, { ...input, audience: "everyone" });
  assert.ok(advisory.issues.includes("Audience is too broad to create targeted content."));
  assert.equal(advisory.blockers.length, 0, "advisory issues must not block rendering");
  const missingCaption = ideaQuality({ hook: "Why FocusFlow protects your weekly plan from chaos", body: "FocusFlow plans your week around two protected deep work blocks every single day.", cta: "Try FocusFlow today", caption: "" }, input);
  assert.ok(missingCaption.blockers.includes("Add a complete caption so the post can publish on its own."));
  const inventedOffer = ideaQuality({ hook: "Why FocusFlow protects your weekly plan from chaos", body: "FocusFlow plans your week around two protected deep work blocks every single day.", cta: "Get 10% off your first order", caption }, input);
  assert.ok(inventedOffer.blockers.some(issue => issue.includes("discounts")), "invented discounts must block publishing");
});

test("cleanWords truncates on word boundaries without dangling fragments", () => {
  assert.equal(cleanWords("We will show you the easiest way to succeed", 40), "We will show you the easiest way.");
  assert.equal(cleanWords("Meet the family behind Bark's famous treats", 30), "Meet the family behind Bark.");
  assert.equal(cleanWords("Short enough already", 105), "Short enough already");
});

test("local AI generation batches requests and merges validated ideas", async t => {
  process.env.OLLAMA_MODEL = "stub-model";
  const realFetch = global.fetch;
  t.after(() => { delete process.env.OLLAMA_MODEL; global.fetch = realFetch; });
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, "stub-model");
    assert.equal(payload.format.properties.ideas.minItems, 6);
    const base = (calls - 1) * 6;
    return stubResponse(Array.from({ length: 6 }, (_, i) => aiIdea(base + i + 1)));
  };
  const plan = await ollamaIdeas(ollamaInput);
  assert.equal(calls, 5, "thirty ideas must be requested in five batches of six");
  assert.equal(plan.length, 30);
  assert.match(plan[0].hook, /number 1 from chaos/);
  assert.match(plan[29].hook, /number 30 from chaos/);
  assert.equal(new Set(plan.map(idea => idea.hook)).size, 30);
  assert.ok(plan.every(idea => idea.quality === 100));
  assert.ok(plan.every(idea => idea.source === "ai"), "model-written posts must be tagged as AI");
});

test("local AI repairs fixable drafts instead of discarding them", async t => {
  process.env.OLLAMA_MODEL = "stub-model";
  const realFetch = global.fetch;
  t.after(() => { delete process.env.OLLAMA_MODEL; global.fetch = realFetch; });
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    const count = JSON.parse(options.body).format.properties.ideas.minItems;
    const base = (calls - 1) * 6;
    return stubResponse(Array.from({ length: count }, (_, i) => {
      const idea = aiIdea(base + i + 1);
      if (base + i === 0) idea.cta = "Click here right now to learn absolutely everything about this offer today";
      if (base + i === 1) idea.body = "FocusFlow plans your week around protected focus blocks and fewer distractions every single day so the important work never slips through the cracks again.";
      return idea;
    }));
  };
  const diagnostics = { rejects: new Map(), repaired: 0 };
  const plan = await ollamaIdeas({ ...ollamaInput, goal: "Get more signups" }, diagnostics);
  assert.equal(calls, 5, "repaired drafts must not trigger extra retry or top-up batches");
  assert.equal(plan.length, 30);
  assert.ok(plan[0].cta.length >= 8 && plan[0].cta.length <= 34, "an over-long CTA must be repaired to a valid length");
  assert.equal(plan[0].source, "ai", "a repaired draft is still model-written content");
  assert.ok(plan[1].body.length <= 145, "an over-long supporting line must be trimmed at a word boundary");
  assert.ok(plan.every(idea => idea.quality >= 88), "every kept post must clear the readiness bar");
  assert.ok(diagnostics.repaired >= 2, "the diagnostics must count reclaimed drafts");
});

test("local AI drafts with invented claims are rejected and retried with feedback", async t => {
  process.env.OLLAMA_MODEL = "stub-model";
  const realFetch = global.fetch;
  t.after(() => { delete process.env.OLLAMA_MODEL; global.fetch = realFetch; });
  const prompts = [];
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    prompts.push(payload.prompt);
    if (calls <= 5) {
      const base = (calls - 1) * 6;
      return stubResponse(Array.from({ length: 6 }, (_, i) => base + i === 0
        ? { ...aiIdea(1), hook: "Our team guarantees your weekly plan stays on track" }
        : aiIdea(base + i + 1)));
    }
    return stubResponse([aiIdea(99)]);
  };
  const plan = await ollamaIdeas(ollamaInput);
  assert.equal(calls, 6);
  assert.match(prompts[5], /Verify this claim is true before publishing/, "the retry must tell the model which claim was invented");
  assert.match(plan[0].hook, /number 99/, "the unverifiable claim must not ship");
});

test("local AI tops up empty slots with fresh batches before falling back", async t => {
  process.env.OLLAMA_MODEL = "stub-model";
  process.env.OLLAMA_SEED = "7";
  const realFetch = global.fetch;
  t.after(() => { delete process.env.OLLAMA_MODEL; delete process.env.OLLAMA_SEED; global.fetch = realFetch; });
  let calls = 0;
  let seenSeed = null;
  global.fetch = async (url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    seenSeed = payload.options.seed;
    const count = payload.format.properties.ideas.minItems;
    const base = (calls - 1) * 6;
    if (calls <= 5) {
      return stubResponse(Array.from({ length: count }, (_, i) => i < 3 ? aiIdea(base + i + 1) : {}));
    }
    return stubResponse(Array.from({ length: count }, (_, i) => aiIdea(base + i + 1)));
  };
  const diagnostics = { rejects: new Map() };
  const plan = await ollamaIdeas(ollamaInput, diagnostics);
  assert.equal(calls, 7, "two top-up batches must follow when slots stay empty");
  assert.equal(seenSeed, 7, "OLLAMA_SEED must reach the model options");
  assert.equal(plan.filter(idea => idea.source === "ai").length, 27);
  assert.equal(plan.filter(idea => idea.source === "template").length, 3);
  assert.equal(new Set(plan.map(idea => idea.hook)).size, 30);
  assert.ok(diagnostics.rejects.size >= 1, "diagnostics must record reject reasons");
});

test("local AI retry sends reviewer feedback and salvages failed drafts", async t => {
  process.env.OLLAMA_MODEL = "stub-model";
  const realFetch = global.fetch;
  t.after(() => { delete process.env.OLLAMA_MODEL; global.fetch = realFetch; });
  const prompts = [];
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    prompts.push(payload.prompt);
    if (calls <= 5) {
      const base = (calls - 1) * 6;
      // A too-short body is unrepairable (repair only trims over-long copy), so
      // this draft must travel to the retry round rather than being salvaged.
      return stubResponse(Array.from({ length: 6 }, (_, i) => base + i === 0 ? { ...aiIdea(1), body: "Tiny." } : aiIdea(base + i + 1)));
    }
    return stubResponse([aiIdea(99)]);
  };
  const plan = await ollamaIdeas(ollamaInput);
  assert.equal(calls, 6, "one retry batch must follow the five generation batches");
  assert.match(prompts[5], /failed editorial review/);
  assert.match(prompts[5], /Supporting line must be 45–145 characters\./, "the retry prompt must quote the reviewer feedback");
  assert.match(plan[0].hook, /number 99/, "the revised idea must land in the failed slot");
});

test("local AI prompts carry brand voice, goal, banned words, and few-shot examples", () => {
  const input = { product: "Sunrise Bakes", audience: "local families", description: "A neighborhood bakery making custom birthday cakes, fresh sourdough, and weekend pastries", voice: "premium-minimalist", goal: "Launch a product", avoid: "cheap, crazy" };
  const prompt = ollamaPrompt(input, 6, new Set(["An old hook"]));
  assert.match(prompt, /premium and minimal/);
  assert.match(prompt, /product launch/i);
  assert.match(prompt, /Never use these words: cheap, crazy/);
  assert.match(prompt, /An old hook/);
  assert.match(prompt, /on-brand examples for THIS business/);
  assert.match(prompt, /"hook":/, "the prompt must embed concrete example ideas");
  assert.match(prompt, /and points\./, "the schema instruction must mention the points field");

  const retryPrompt = ollamaPrompt(input, 2, new Set(), [{ idea: { hook: "Too short", body: "Tiny." }, issues: ["Hook must be 18–105 characters."] }]);
  assert.match(retryPrompt, /failed editorial review/);
  assert.doesNotMatch(retryPrompt, /on-brand examples for THIS business/, "retry prompts skip examples to stay focused on fixes");
});

test("password hashes are salted and verifiable", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
});

test("account and project API lifecycle", async t => {
  const port = 43000 + process.pid % 1000;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sideclip-test-"));
  let child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir },
    stdio: "ignore"
  });
  t.after(() => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const generatorFile = await fetch(`${base}/generator.js`);
  assert.equal(generatorFile.status, 200);
  assert.match(await generatorFile.text(), /SideClipGenerator/);
  const register = await fetch(`${base}/api/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test User", email: "test@example.com", password: "a secure test password" })
  });
  assert.equal(register.status, 201);
  const cookie = register.headers.get("set-cookie").split(";")[0];
  const saved = await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: "Launch", data: { plan: [] } })
  });
  assert.equal(saved.status, 201);
  const list = await fetch(`${base}/api/projects`, { headers: { Cookie: cookie } });
  assert.equal((await list.json()).projects.length, 1);
  child.kill();
  await new Promise(resolve => child.once("exit", resolve));
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir },
    stdio: "ignore"
  });
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const restoredSession = await fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
  assert.equal((await restoredSession.json()).user.email, "test@example.com");
  const exported = await fetch(`${base}/api/export`, { headers: { Cookie: cookie } });
  assert.equal((await exported.json()).projects.length, 1);
  const upload = await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      name: "pixel.png", type: "image/png",
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    })
  });
  assert.equal(upload.status, 201);
  const asset = (await upload.json()).asset;
  assert.equal((await fetch(`${base}${asset.url}`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}${asset.url}`)).status, 403);
  const audioUpload = await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: "voiceover.webm", type: "audio/webm", data: "data:audio/webm;base64,AA==" })
  });
  assert.equal(audioUpload.status, 201);
  const crossOrigin = await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com", Cookie: cookie },
    body: JSON.stringify({ name: "Blocked", data: {} })
  });
  assert.equal(crossOrigin.status, 403);
  const removed = await fetch(`${base}/api/account`, {
    method: "DELETE", headers: { "Content-Type": "application/json", Cookie: cookie }
  });
  assert.equal(removed.status, 200);
});
