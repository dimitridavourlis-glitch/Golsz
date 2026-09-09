/* ==========================================================================
   GOLSZ — landing page only (index.html)

   Drives the hero demo: the visitor names a goal, the route to it assembles.

   THE ROUTES BELOW ARE CURATED, NOT GENERATED. Nothing on this page calls
   Scout, the Anthropic API, or any endpoint. That is deliberate and should
   stay that way:
     - a landing page that spends model tokens on every anonymous visitor is
       a bill and a rate-limit waiting to happen;
     - a real Scout answer needs a Passport to be grounded in, and there
       isn't one yet, so anything it produced here would be the generic
       output the product exists to avoid.
   So these are hand-written standard routes, and the panel says "standard
   route" and "not your route" in the markup. Do not relabel them as
   personalised, and do not wire this to the API "to make it more impressive".

   An unrecognised goal returns null and the UI says GOLSZ doesn't have a
   preset route for it. That is the same thing the app does when Scout lacks
   data. The landing page must not be the one place GOLSZ bluffs.

   Progressive enhancement: index.html ships the NCAA D1 route fully rendered,
   so with JavaScript off the panel is complete and correct rather than empty.
   Animation is driven by timers, not requestAnimationFrame, so a throttled or
   background renderer still lands on the finished state.
   ========================================================================== */
(function () {
  "use strict";

  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var ROUTES = {
    ncaa: {
      name: "NCAA D1",
      stall: "Getting seen. Benchmarks without a showcase on the calendar is the most common dead end.",
      stops: [
        ["Club or school team", "Regular competitive minutes at your level."],
        ["Verified benchmarks", "Measured, dated, and recorded with how they were taken."],
        ["Summer showcase", "An event where D1 staff actually attend."],
        ["Target list &amp; outreach", "Programmes matched to your level, contacted directly."],
        ["NCAA D1 roster", "The goal you named."]
      ]
    },
    usports: {
      name: "U Sports",
      stall: "Assuming Canadian programmes recruit like American ones. The calendar and the contact rules are different.",
      stops: [
        ["School or club team", "Consistent minutes and a season record."],
        ["Academic eligibility", "Transcript and grade requirements confirmed early."],
        ["ID camp or open trial", "Run by the programmes themselves."],
        ["Coach outreach", "Direct contact, with video and benchmarks attached."],
        ["U Sports roster", "The goal you named."]
      ]
    },
    juco: {
      name: "JUCO",
      stall: "Treating JUCO as a fallback instead of a route. The transfer step needs planning from day one.",
      stops: [
        ["School team", "Game film worth sending."],
        ["JUCO showcase or visit", "Direct contact with two-year programmes."],
        ["JUCO roster", "Playing time while academics catch up."],
        ["Transfer profile", "Benchmarks and film rebuilt at the new level."],
        ["Four-year programme", "The goal you named."]
      ]
    },
    academy: {
      name: "an academy place",
      stall: "Age bands. Most academies recruit on a narrow window and miss you entirely if you arrive late.",
      stops: [
        ["Local club", "Playing regularly in your age group."],
        ["Scouted or self-referred trial", "An ID day, or a direct approach with video."],
        ["Trial period", "Weeks, not a single session."],
        ["Academy place", "The goal you named."]
      ]
    },
    european: {
      name: "a European club",
      stall: "Paperwork. Nationality, work permits and registration windows decide more of this than ability does.",
      stops: [
        ["Senior or youth club minutes", "A record someone abroad can verify."],
        ["Video profile", "Full matches, not a highlight reel."],
        ["Eligibility check", "Passport, permits and registration windows."],
        ["Club trial", "Arranged directly or through representation."],
        ["European club contract", "The goal you named."]
      ]
    },
    semipro: {
      name: "semi-professional",
      stall: "Waiting to be found. At this level almost every move starts with the athlete making contact.",
      stops: [
        ["Senior club minutes", "Playing against adults, not your age group."],
        ["Measurable output", "Numbers a coach at the next level recognises."],
        ["Direct approach", "Clubs contacted with film and benchmarks."],
        ["Semi-professional terms", "The goal you named."]
      ]
    },
    pro: {
      name: "a pro contract",
      stall: "Representation. Signing with the wrong agent early is harder to undo than having none.",
      stops: [
        ["Senior minutes", "A consistent role at a competitive level."],
        ["Verified performance record", "Dated, sourced, and independently checkable."],
        ["Representation", "An agent who works your actual level."],
        ["Trials and negotiation", "Terms, medicals, registration."],
        ["Professional contract", "The goal you named."]
      ]
    },
    better: {
      name: "measurably better",
      stall: "Comparing unlike measurements. A hand-timed sprint against an electronic one is not progress.",
      stops: [
        ["Baseline", "Every benchmark measured once, properly, and dated."],
        ["A training block", "One focus at a time, for long enough to move."],
        ["Retest, same method", "Same equipment, same conditions, same clock."],
        ["A real comparison", "Progress you can actually stand behind."]
      ]
    }
  };

  // Free text -> route key. Deliberately narrow: a goal we don't recognise
  // must fall through to the honest "no preset route" state rather than being
  // fuzzy-matched onto something that isn't what the athlete meant.
  var ALIASES = [
    [/\b(ncaa|d1|division\s*1|division\s*one|college)\b/i, "ncaa"],
    [/\b(u\s*sports|usports|canadian university|cis)\b/i, "usports"],
    [/\b(juco|junior college|two[- ]year)\b/i, "juco"],
    [/\b(academy|youth setup|residency)\b/i, "academy"],
    [/\b(europe|european|abroad|overseas)\b/i, "european"],
    [/\b(semi[- ]?pro|semiprofessional|semi professional)\b/i, "semipro"],
    [/\b(pro|professional|contract|paid)\b/i, "pro"],
    [/\b(better|improve|faster|stronger|fitter|progress)\b/i, "better"]
  ];

  function resolve(text) {
    var t = (text || "").trim();
    if (!t) return null;
    for (var i = 0; i < ALIASES.length; i++) if (ALIASES[i][0].test(t)) return ALIASES[i][1];
    return null;
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function each(sel, fn, root) { Array.prototype.forEach.call((root || document).querySelectorAll(sel), fn); }

  var out      = $("[data-out]");
  var routeEl  = $("[data-route]");
  var goalEl   = $("[data-out-goal]");
  var nextEl   = $("[data-next]");
  var nextText = $("[data-next-text]");
  var input    = $("[data-goal-input]");
  var form     = $("[data-ask]");
  if (!out || !routeEl || !form) return;

  var timers = [];
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  function stopMarkup(stop, isGoal) {
    return '<span class="lx-rdot"></span><div><b>' + stop[0] + '</b><span>' + stop[1] + '</span></div>';
  }

  function render(key) {
    clearTimers();
    var route = ROUTES[key];

    if (!route) {
      // The honest branch. No invented route, no nearest guess.
      out.classList.add("is-unknown");
      goalEl.textContent = "not recognised";
      routeEl.innerHTML = '<li class="lx-rstop is-in lx-rstop-none"><span class="lx-rdot"></span>' +
        '<div><b>GOLSZ doesn&rsquo;t have a preset route for that.</b>' +
        '<span>Rather than guess at one, Scout builds it with you from your sport, your level and what you have already done.</span></div></li>';
      nextText.textContent = "Build a Passport and tell Scout the goal in your own words — it will say what it can and can't work out.";
      nextEl.hidden = false;
      return;
    }

    out.classList.remove("is-unknown");
    goalEl.textContent = route.name;
    nextText.textContent = route.stall;

    routeEl.innerHTML = route.stops.map(function (s, i) {
      return '<li class="lx-rstop' + (i === route.stops.length - 1 ? " is-goal" : "") + '">' + stopMarkup(s) + '</li>';
    }).join("");

    var stops = routeEl.querySelectorAll(".lx-rstop");
    if (reduced) {
      each(".lx-rstop", function (li) { li.classList.add("is-in"); }, routeEl);
      nextEl.hidden = false;
      return;
    }

    nextEl.hidden = true;
    Array.prototype.forEach.call(stops, function (li, i) {
      timers.push(setTimeout(function () { li.classList.add("is-in"); }, 90 + i * 170));
    });
    timers.push(setTimeout(function () { nextEl.hidden = false; }, 90 + stops.length * 170 + 120));
  }

  function setActiveChip(key) {
    each("[data-goal]", function (b) { b.classList.toggle("is-on", b.getAttribute("data-goal") === key); });
  }

  each("[data-goal]", function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-goal");
      input.value = btn.textContent.trim();
      setActiveChip(key);
      render(key);
    });
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var key = resolve(input.value);
    setActiveChip(key);
    render(key);
  });
})();
