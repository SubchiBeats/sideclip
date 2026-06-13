"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { localIdeas, ideaQuality } = require("../server");
const { assembleCaption, captionFulfillsPromise } = require("../generator");

const briefs = [
  ["Sunrise Bakes", "local families", "A neighborhood bakery making custom birthday cakes, fresh sourdough, and weekend pastries"],
  ["Keys with Maya", "first-time homebuyers", "A local realtor helping first-time buyers find and confidently purchase homes in Atlanta"],
  ["Calm Harbor", "busy professionals", "Online therapy that helps busy professionals manage anxiety and build healthier boundaries"],
  ["Iron Hour", "beginners over 40", "Small-group strength coaching for adults over 40 who want to move better and feel stronger"],
  ["InvoiceNest", "freelancers", "Simple invoicing software that helps freelancers send invoices, track payments, and get paid faster"],
  ["Luna Table", "date-night diners", "A cozy Italian restaurant serving handmade pasta and seasonal date-night dinners"],
  ["Books for All", "parents and teachers", "A nonprofit giving free books and reading support to children in underserved communities"],
  ["Dewdrop Skin", "people with sensitive skin", "Fragrance-free skincare made for sensitive skin and simple daily routines"],
  ["Rapid Rooter", "homeowners", "A local plumber offering emergency drain cleaning, leak repair, and water heater service"],
  ["Ever After Photo", "engaged couples", "A wedding photographer capturing candid, emotional moments without stiff posing"],
  ["Speak Easy Spanish", "adult beginners", "An online Spanish course that helps adults speak confidently for travel and everyday life"],
  ["Riverlight Fest", "families and music fans", "A free community music festival with local artists, food vendors, and kids activities"],
  ["Nova Rae", "indie pop fans", "An independent pop artist releasing dreamy songs about heartbreak and starting over"],
  ["ClearPath Legal", "small business owners", "A small business law firm helping founders review contracts and avoid expensive disputes"],
  ["Bright Math", "middle school parents", "Online math tutoring that helps middle school students build confidence and improve grades"],
  ["Wander Kindly", "eco-conscious travelers", "Small-group sustainable travel experiences led by local guides"],
  ["Paws & Polish", "dog owners", "A mobile dog grooming service that comes to busy pet owners at home"],
  ["Bloom & Stem", "gift shoppers", "A local florist creating seasonal bouquets for birthdays, anniversaries, and thoughtful gifts"],
  ["Quiet Glow", "home decor shoppers", "Hand-poured soy candles with subtle scents for calm evenings at home"],
  ["PipelinePro", "small sales teams", "A CRM that helps small sales teams track leads, follow up, and close more deals"],
  ["FreshCart", "busy parents", "A grocery delivery app that brings affordable fresh food to busy families"],
  ["Oakline Build", "homeowners planning renovations", "A residential construction company specializing in kitchens, bathrooms, and home additions"],
  ["Velvet Chair", "women seeking low-maintenance style", "A neighborhood hair salon offering cuts, color, and low-maintenance styling"],
  ["Bright Smile Dental", "families", "A family dentist providing preventive care, gentle cleanings, and emergency appointments"],
  ["Little Lantern", "working parents", "A childcare center offering safe play-based learning for toddlers and preschoolers"],
  ["Northstar Wealth", "young professionals", "A financial advisor helping young professionals budget, invest, and plan for long-term goals"],
  ["CloudDesk", "remote teams", "Project management software for remote teams to organize tasks, deadlines, and communication"],
  ["Green Yard Co", "homeowners", "Eco-friendly lawn care and landscaping for healthy yards without harsh chemicals"],
  ["Chef Nia", "busy couples", "A personal chef preparing healthy weekly meals in clients homes"],
  ["Maker House", "creative adults", "Weekend pottery workshops for beginners who want a relaxing creative hobby"],
  ["OddThing", "curious people", "A completely unusual service nobody has classified before"]
];

test("broad business audit produces relevant, complete, varied content", () => {
  const brokenEnding = /\b(and|or|with|without|to|from|in|a|an|the|that|who|for|usual|feels)\.$/i;
  for (const [product, audience, description] of briefs) {
    const input = { product, audience, description };
    const ideas = localIdeas(input);
    assert.equal(ideas.length, 30, product);
    assert.equal(new Set(ideas.map(idea => idea.hook)).size, 30, `${product} hooks`);
    assert.equal(new Set(ideas.map(idea => idea.body)).size, 30, `${product} supporting lines`);
    assert.equal(new Set(ideas.map(idea => idea.caption)).size, 30, `${product} captions`);
    if (product === "OddThing") {
      assert.ok(ideas.some(idea => ideaQuality(idea, input).score < 100), `${product} should flag an unusably vague brief`);
    } else {
      assert.ok(ideas.every(idea => ideaQuality(idea, input).score === 100), `${product} quality`);
    }
    assert.ok(ideas.every(idea => idea.hook.length <= 105 && idea.body.length <= 145), `${product} limits`);
    assert.ok(ideas.every(idea => !brokenEnding.test(idea.hook) && !brokenEnding.test(idea.body)), `${product} complete sentences`);
  }
});

test("category matching keeps content in the right business", () => {
  const organizer = { product: "Tidy Nest", audience: "overwhelmed parents", description: "A professional home organizing service that declutters closets, kitchens, and garages" };
  const organizerIdeas = localIdeas(organizer);
  const organizerText = organizerIdeas.map(idea => `${idea.hook} ${idea.body} ${idea.caption}`).join(" ");
  assert.doesNotMatch(organizerText, /renovation|remodel|home addition|craftsmanship|skilled building/i, "an organizing service must not get renovation content");
  assert.match(organizerText, /organized|declutter|closet/i);
  assert.ok(organizerIdeas.every(idea => ideaQuality(idea, organizer).score === 100));

  const cafe = { product: "Brew & Bark", audience: "dog owners", description: "A dog-friendly coffee shop with a fenced play yard and house-roasted espresso" };
  const cafeIdeas = localIdeas(cafe);
  const cafeText = cafeIdeas.map(idea => `${idea.hook} ${idea.body}`).join(" ");
  assert.doesNotMatch(cafeText, /treat bag|nap spot|trained the humans|household rule/i, "a pet-friendly business must not be treated as a pet");
  assert.match(cafeText, /coffee|espresso/i);
  assert.ok(cafeIdeas.every(idea => ideaQuality(idea, cafe).score === 100));
  const brokenEnding = /\b(and|or|with|without|to|from|in|a|an|the|that|who|for|next)\.$/i;
  assert.ok(cafeIdeas.every(idea => !brokenEnding.test(idea.cta)), "calls to action must not be cut off mid-phrase");

  const keepsake = { product: "Stitch & Story", audience: "new parents", description: "Handmade personalized baby blankets embroidered with names and birth dates" };
  const keepsakeIdeas = localIdeas(keepsake);
  assert.match(keepsakeIdeas.map(idea => `${idea.hook} ${idea.body}`).join(" "), /handmade|personalized/i);
  assert.ok(keepsakeIdeas.every(idea => ideaQuality(idea, keepsake).score === 100), "handmade gift briefs must produce specific content");

  const demo = { product: "FocusFlow", audience: "busy creative freelancers", description: "Plan their week, block distractions, and get meaningful work done without burning out." };
  assert.ok(localIdeas(demo).every(idea => ideaQuality(idea, demo).score === 100), "the bundled demo brief must score 100");
});

test("verb-phrase actions stay grammatical across templates", () => {
  const input = { product: "Oakline Build", audience: "homeowners planning renovations", description: "A residential construction company specializing in kitchens, bathrooms, and home additions" };
  const text = localIdeas(input).map(idea => `${idea.hook} ${idea.body} ${idea.caption}`).join(" ");
  assert.doesNotMatch(text, /\bmakes plan a\b|\bmakes now useful\b|\bwhat thoughtful a\b/i);
});

test("brand voice, campaign goal, and banned words shape the plan", () => {
  const base = { product: "Sunrise Bakes", audience: "local families", description: "A neighborhood bakery making custom birthday cakes, fresh sourdough, and weekend pastries" };
  const warm = localIdeas({ ...base, voice: "warm-expert" });
  const playful = localIdeas({ ...base, voice: "playful-friend" });
  assert.notDeepEqual(warm.map(idea => idea.caption), playful.map(idea => idea.caption), "different voices must produce different captions");
  assert.ok(playful.every(idea => ideaQuality(idea, base).score === 100));

  const signupInput = { ...base, goal: "Get more signups" };
  const signups = localIdeas(signupInput);
  assert.equal(signups[2].cta, "Start free today");
  assert.equal(signups[29].cta, "Start free with Sunrise Bakes");
  assert.equal(new Set(signups.map(idea => idea.cta)).size, 30);
  assert.ok(signups.every(idea => ideaQuality(idea, signupInput).score === 100));

  const safeInput = { ...base, avoid: "cheap, stress" };
  const safeIdeas = localIdeas(safeInput);
  assert.ok(safeIdeas.every(idea => !/cheap|stress/i.test(`${idea.hook} ${idea.body} ${idea.cta} ${idea.caption}`)), "banned words must not appear anywhere in the plan");
  assert.equal(new Set(safeIdeas.map(idea => idea.hook)).size, 30, "banned-word repairs must keep hooks unique");
  assert.ok(safeIdeas.every(idea => ideaQuality(idea, safeInput).score === 100));
  const flagged = ideaQuality({
    hook: "Why our cheap cakes always win",
    body: "Our cakes cost less than every other bakery in the neighborhood, every day.",
    cta: "Order a cake today",
    caption: "Our custom birthday cakes and weekend pastries are made fresh in the neighborhood every morning, so every celebration tastes like it came from family."
  }, safeInput);
  assert.ok(flagged.blockers.some(issue => issue.includes("cheap")), "a banned word must block rendering");
});

test("unsupported claims are flagged for verification", () => {
  const cafe = { product: "Brew & Bark", audience: "dog owners", description: "A dog-friendly coffee shop with a fenced play yard and house-roasted espresso" };
  const caption = "Brew & Bark pairs house-roasted espresso with a fenced play yard, so dog owners can slow down while their pups run. Come see the play yard for yourself this week.";
  const claimy = ideaQuality({ hook: "Our staff is trained to watch your dog while you sip", body: "Brew & Bark gives dog owners a fenced play yard and house-roasted espresso.", cta: "Visit Brew & Bark", caption }, cafe);
  assert.ok(claimy.issues.some(issue => issue.startsWith("Verify this claim")), "a staff claim absent from the brief must be flagged");
  assert.ok(!claimy.blockers.some(issue => issue.startsWith("Verify this claim")), "claims stay advisory for human-edited copy");
  const grounded = ideaQuality({ hook: "Why the fenced play yard makes Brew & Bark different", body: "Brew & Bark gives dog owners a fenced play yard and house-roasted espresso.", cta: "Visit Brew & Bark", caption }, cafe);
  assert.ok(!grounded.issues.some(issue => issue.startsWith("Verify this claim")), "copy grounded in the brief must not be flagged");
});

test("declared offerings ground claims and count as concrete detail", () => {
  const base = { product: "Velvet Chair", audience: "busy professionals", description: "A neighborhood hair salon offering cuts, color, and low-maintenance styling" };
  const idea = { hook: "Our certified stylists make low-maintenance color easy", body: "Velvet Chair pairs certified stylists with free parking for busy professionals.", cta: "Book at Velvet Chair", caption: "Velvet Chair pairs certified stylists, free parking, and low-maintenance color so busy professionals can look polished without the upkeep. Book your chair this week and skip the fuss." };

  const ungrounded = ideaQuality(idea, base);
  assert.ok(ungrounded.issues.some(issue => issue.startsWith("Verify this claim")), "a certification claim absent from the brief must be flagged");

  const grounded = ideaQuality(idea, { ...base, offerings: "certified stylists, free parking, evening appointments" });
  assert.ok(!grounded.issues.some(issue => issue.startsWith("Verify this claim")), "a claim listed in offerings must be accepted");

  // Offerings also supply concrete brief detail to otherwise generic copy.
  const sparse = { product: "Velvet Chair", audience: "busy professionals", description: "A salon" };
  const post = { hook: "Why busy professionals choose Velvet Chair for balayage", body: "Velvet Chair brings balayage and gloss treatments to busy professionals.", cta: "Book at Velvet Chair", caption: "Velvet Chair brings balayage, gloss treatments, and quick blowouts to busy professionals who want salon results that last. Book your chair and keep it simple all month." };
  const withFacts = ideaQuality(post, { ...sparse, offerings: "balayage, gloss treatments, quick blowouts" });
  assert.ok(!withFacts.issues.includes("Use a concrete detail from the campaign brief."), "offerings terms must satisfy the concrete-detail check");
});

test("hybrid caption assembly guarantees publishable structure for AI ideas", () => {
  const input = { product: "Brew & Bark", audience: "dog owners", description: "A dog-friendly coffee shop with a fenced play yard and house-roasted espresso", voice: "playful-friend" };

  const plainIdea = { day: 4, hook: "Meet the house-roasted espresso your dog already loves", body: "Our fenced play yard lets dogs run while you sip fresh espresso.", cta: "Visit Brew & Bark" };
  const plain = assembleCaption(plainIdea, input);
  assert.ok(plain.length >= 160, "assembled caption must be long enough to stand alone");
  assert.match(plain, /Visit Brew & Bark\.\s*$|Visit Brew & Bark\.\n/);
  assert.equal(ideaQuality({ ...plainIdea, caption: plain }, input).blockers.length, 0, "assembled caption must clear every render blocker");

  const numberedIdea = { day: 2, hook: "3 reasons dog owners love Brew & Bark", body: "From espresso to play yards, here is why.", cta: "Plan your visit", points: ["House-roasted espresso", "A fenced play yard", "Treats for your pup"] };
  const numbered = assembleCaption(numberedIdea, input);
  assert.match(numbered, /1\. House-roasted espresso/);
  assert.match(numbered, /2\. A fenced play yard/);
  assert.match(numbered, /3\. Treats for your pup/);
  assert.ok(captionFulfillsPromise({ hook: numberedIdea.hook, caption: numbered }), "model-supplied points must satisfy the numbered promise");

  const missingPoints = { day: 5, hook: "3 signs your dog needs Brew & Bark", body: "Restless mornings and long afternoons.", cta: "Book a table" };
  const padded = assembleCaption(missingPoints, input);
  assert.ok(captionFulfillsPromise({ hook: missingPoints.hook, caption: padded }), "a numbered hook must still be fulfilled when the model omits points");
});

test("market categories do not leak operational template language", () => {
  const leaked = /\ban? a\b|workflow|handoff|preflight|quality gate|human review|one-file|stakeholder|project-wide|complex work|measurable progress/i;
  for (const [product, audience, description] of briefs) {
    const text = localIdeas({ product, audience, description }).map(idea => `${idea.hook} ${idea.body}`).join(" ");
    assert.doesNotMatch(text, leaked, product);
  }
});
