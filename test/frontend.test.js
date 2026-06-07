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
});

test("theme toggle is persistent and hero copy uses readable panels", () => {
  assert.match(html, /id="themeToggle"/);
  assert.match(html, /mini-copy/);
  assert.match(theme, /sideclip-theme/);
  assert.match(theme, /prefers-color-scheme: dark/);
  assert.match(fs.readFileSync(path.join(root, "styles.css"), "utf8"), /\[data-theme="dark"\]/);
});
