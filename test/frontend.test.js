"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

test("HTML ids are unique", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test("literal app id selectors exist in the document", () => {
  const selectors = [...app.matchAll(/\$\("#([A-Za-z][\w-]*)"\)/g)].map(match => match[1]);
  const missing = [...new Set(selectors)].filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});
