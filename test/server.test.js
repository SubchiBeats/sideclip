"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { localIdeas, ideaQuality, hashPassword, verifyPassword } = require("../server");

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
  const child = spawn(process.execPath, ["server.js"], {
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
