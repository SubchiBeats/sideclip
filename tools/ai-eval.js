"use strict";

// Local-AI evaluation harness.
//
// Runs a fixed set of varied business briefs through the live Ollama pipeline
// and reports, per brief: how many of the 30 posts the model wrote (vs the
// template fallback), the average publish-readiness score, duplicate hooks,
// any invented-offer leaks, and elapsed time. Use it to measure whether a
// prompt, model, or sampling change actually improves output - refinement
// should be proven here, not guessed.
//
// Requires a running Ollama with the model set, e.g. (PowerShell):
//   $env:OLLAMA_MODEL="llama3.2:3b"; node tools/ai-eval.js
// Optionally narrow to one brief:  node tools/ai-eval.js bakery

const { ollamaIdeas } = require("../server");
const { localIdeas, ideaQuality } = require("../generator");

if (!process.env.OLLAMA_MODEL) {
  console.error('Set OLLAMA_MODEL first. PowerShell: $env:OLLAMA_MODEL="llama3.2:3b"; node tools/ai-eval.js');
  process.exit(1);
}
// Fixed seed so before/after comparisons measure the change, not sampling noise.
if (!process.env.OLLAMA_SEED) process.env.OLLAMA_SEED = "42";

const briefs = [
  { key: "bakery", product: "Sunrise Bakes", audience: "local families", description: "A neighborhood bakery making custom birthday cakes, fresh sourdough, and weekend pastries", voice: "warm-expert", goal: "Build awareness" },
  { key: "cafe", product: "Brew & Bark", audience: "dog owners", description: "A dog-friendly coffee shop with a fenced play yard and house-roasted espresso", voice: "playful-friend", goal: "Get more signups", avoid: "cheap" },
  { key: "realtor", product: "Keys with Maya", audience: "first-time homebuyers", description: "A local realtor helping first-time buyers find and confidently purchase homes in Atlanta", voice: "warm-expert", goal: "Get more signups" },
  { key: "fitness", product: "Iron Hour", audience: "beginners over 40", description: "Small-group strength coaching for adults over 40 who want to move better and feel stronger", voice: "bold-straight-talker", goal: "Teach the audience" },
  { key: "skincare", product: "Dewdrop Skin", audience: "people with sensitive skin", description: "Fragrance-free skincare made for sensitive skin and simple daily routines", voice: "premium-minimalist", goal: "Launch a product" },
  { key: "saas", product: "PipelinePro", audience: "small sales teams", description: "A CRM that helps small sales teams track leads, follow up, and close more deals", voice: "warm-expert", goal: "Get more signups" },
  { key: "florist", product: "Bloom & Stem", audience: "gift shoppers", description: "A local florist creating seasonal bouquets for birthdays, anniversaries, and thoughtful gifts", voice: "warm-expert", goal: "Build awareness" },
  { key: "music", product: "Nova Rae", audience: "indie pop fans", description: "An independent pop artist releasing dreamy songs about heartbreak and starting over", voice: "playful-friend", goal: "Launch a product" }
];

const offerPattern = /\d+\s?%|percent off|\bdiscounts?\b|\bsale\b|\$\s?\d|buy one get/i;
const pad = (value, width) => String(value).padEnd(width);

(async () => {
  const selected = process.argv[2] ? briefs.filter(brief => brief.key === process.argv[2]) : briefs;
  if (!selected.length) {
    console.error(`Unknown brief "${process.argv[2]}". Options: ${briefs.map(brief => brief.key).join(", ")}`);
    process.exit(1);
  }
  console.log(`Model: ${process.env.OLLAMA_MODEL}  |  seed: ${process.env.OLLAMA_SEED}  |  briefs: ${selected.length}\n`);
  console.log(`${pad("brief", 10)}${pad("ai/30", 7)}${pad("avgScore", 10)}${pad("dupes", 7)}${pad("offers", 8)}${pad("sec", 6)}`);
  console.log("-".repeat(48));

  const totals = { ai: 0, score: 0, dupes: 0, offers: 0, secs: 0 };
  const diagnostics = { rejects: new Map(), repaired: 0 };
  for (const brief of selected) {
    const started = Date.now();
    let plan = null;
    try { plan = await ollamaIdeas(brief, diagnostics); } catch (error) { /* report as zero below */ }
    const secs = Math.round((Date.now() - started) / 1000);
    if (!plan) {
      console.log(`${pad(brief.key, 10)}${pad("0 (fail)", 7)}${pad("-", 10)}${pad("-", 7)}${pad("-", 8)}${pad(secs, 6)}`);
      totals.secs += secs;
      continue;
    }
    const offlineHooks = new Set(localIdeas(brief).map(idea => idea.hook));
    const aiCount = plan.filter(idea => !offlineHooks.has(idea.hook)).length;
    const avgScore = Math.round(plan.reduce((sum, idea) => sum + ideaQuality(idea, brief).score, 0) / plan.length);
    const dupes = plan.length - new Set(plan.map(idea => idea.hook)).size;
    const offers = plan.filter(idea => offerPattern.test(`${idea.hook} ${idea.body} ${idea.cta} ${idea.caption}`) && !offerPattern.test(brief.description)).length;
    console.log(`${pad(brief.key, 10)}${pad(`${aiCount}`, 7)}${pad(avgScore, 10)}${pad(dupes, 7)}${pad(offers, 8)}${pad(secs, 6)}`);
    totals.ai += aiCount; totals.score += avgScore; totals.dupes += dupes; totals.offers += offers; totals.secs += secs;
  }

  const n = selected.length;
  console.log("-".repeat(48));
  console.log(`${pad("MEAN", 10)}${pad((totals.ai / n).toFixed(1), 7)}${pad((totals.score / n).toFixed(1), 10)}${pad((totals.dupes / n).toFixed(1), 7)}${pad((totals.offers / n).toFixed(1), 8)}${pad(Math.round(totals.secs / n), 6)}`);
  console.log(`\nai/30   = posts written by the local model (rest fell back to the built-in generator)`);
  console.log(`offers  = invented discounts/sales not present in the brief (should stay 0)`);
  console.log(`reclaimed via repair across all briefs: ${diagnostics.repaired}`);
  const reasons = [...diagnostics.rejects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (reasons.length) {
    console.log(`\nTop reject reasons (fix the biggest to raise ai/30):`);
    for (const [issue, count] of reasons) console.log(`  ${String(count).padStart(3)}x  ${issue}`);
  }
})();
