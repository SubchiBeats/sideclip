"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const theme = fs.readFileSync(path.join(root, "theme.js"), "utf8");

test("HTML ids are unique", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test("literal app id selectors exist in the document", () => {
  const selectors = [...app.matchAll(/\$\("#([A-Za-z][\w-]*)"\)/g)].map(match => match[1]);
  const missing = [...new Set(selectors)].filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test("video renderer fits supporting copy and centers CTA text", () => {
  assert.match(app, /fitTextBlock/);
  assert.match(app, /fitSingleLine/);
  assert.match(app, /ctx\.textAlign = "center"/);
  assert.doesNotMatch(app, /wrapText\(ctx, body, 300\)\.slice\(0, 3\)/);
  assert.doesNotMatch(app, /visible\[maxLines - 1\].*…/);
  assert.match(app, /Publish readiness/);
  assert.match(app, /planNeedsUpgrade/);
  assert.match(app, /ctx\.rect\(18, 160, 324, 260\)/);
  assert.match(app, /ctx\.rect\(30, 464, 300, 72\)/);
  assert.match(app, /fitTextBlock\(ctx, renderBody, 296, 14, 9, 600, 1\.28, 70\)/, "body text must be fitted to the panel height");
  assert.match(html, /width="1080" height="1920"/, "video must export at 1080x1920");
  assert.match(app, /ctx\.setTransform\(scale, 0, 0, scale, 0, 0\)/);
  assert.match(app, /quality\.blockers\.length > 0/, "render gate must use blocking issues");
});

test("theme toggle is persistent and hero copy uses readable panels", () => {
  assert.match(html, /id="themeToggle"/);
  assert.match(html, /mini-copy/);
  assert.match(theme, /sideclip-theme/);
  assert.match(theme, /prefers-color-scheme: dark/);
  assert.match(fs.readFileSync(path.join(root, "styles.css"), "utf8"), /\[data-theme="dark"\]/);
});

test("editor supports varied visuals and complete post captions", () => {
  assert.match(html, /id="visualStyle"/);
  assert.match(html, /id="editCaption"/);
  for (const style of ["orbit", "checklist", "spotlight", "cards", "grid", "waves"]) assert.match(app, new RegExp(style));
  assert.match(app, /state\.current\.caption/);
});

test("hero, dark actions, narration, and platform captions are polished", () => {
  const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  assert.match(styles, /\.mini-copy-coral\{[^}]*margin-bottom/);
  assert.match(styles, /\[data-theme="dark"\] \.button-dark,\[data-theme="dark"\] \.button-lime/);
  for (const id of ["voiceRate", "voicePitch", "captionPlatform", "adaptCaptionButton"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /function voiceScore/);
  assert.match(app, /utterance\.rate/);
  assert.match(app, /function platformCaption/);
  assert.match(app, /captionVariant/);
  assert.match(app, /fresh accurate angle/);
  assert.match(app, /fitTextBlock\(ctx, hook, 310, 34, 13, 800, 1\.08, 244\)/);
});

test("shared generator powers the client, plan readiness, and offline fallback", () => {
  const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  assert.match(html, /<script src="generator\.js"><\/script>/);
  assert.match(app, /SideClipGenerator\.localIdeas/);
  assert.match(app, /SideClipGenerator\.ideaQuality/);
  assert.doesNotMatch(app, /const templates = \{/, "weak client-side fallback templates must stay removed");
  assert.match(sw, /generator\.js/);
  assert.match(html, /id="planReadiness"/);
  assert.match(app, /updatePlanReadiness/);
  assert.match(app, /score-chip/);
  assert.match(app, /srtTime/);
});

test("brief captures brand voice, goal, and banned words end to end", () => {
  for (const id of ["voice", "avoid", "goal"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /voice: \$\("#voice"\)\.value/);
  assert.match(app, /avoid: \$\("#avoid"\)\.value/);
  assert.match(app, /goal: \$\("#goal"\)\.value/);
  assert.match(html, /maxlength="400"/, "the description field must allow grounding detail");
  assert.match(app, /source-chip/, "AI-written posts must be labeled in the plan");
  assert.match(html, /id="offerings"/, "the brief must capture what the business actually offers");
  assert.match(app, /offerings: \$\("#offerings"\)\.value/, "offerings must flow into generation and persistence");
});

test("campaigns autosave locally and restore exact account projects", () => {
  assert.match(app, /sideclip-draft-v1/);
  assert.match(app, /schedulePersistence/);
  assert.match(app, /saveProject\(\{ silent: true \}\)/);
  assert.match(app, /sideclip-last-project/);
  assert.match(app, /Project opened exactly as saved/);
  assert.doesNotMatch(app, /older plan was upgraded/);
});
