/* ==========================================================================
   GOLSZ — Global Script
   Handles: mobile nav, active link state, scroll reveal, hero region,
   marketing-page prices.

   THERE IS NO FORM HANDLING HERE ANY MORE.
   initForms()/validateForm()/showSuccess() were removed on 2026-09-07 along
   with contact.html's "Join the waitlist" form. They intercepted submission,
   validated, and showed "You're on the list." while sending the data
   nowhere — a fake success state on the only form the marketing site had.
   The form was deleted rather than wired to a provider, because GOLSZ is
   open for signups now and the real call to action is "Start free".
   If a real form is ever added, give it a genuine backend before it ships;
   do not restore a client-only success message.
   ========================================================================== */

(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    initFooterYear();
    initMobileNav();
    initActiveNav();
    initScrollReveal();
    initHeroRegion();
  });

  // Swaps the homepage hero's background photo based on the visitor's
  // region (Canada / US / Europe / default), resolved server-side via
  // /api/geo.js so no client-side geo lookup or third-party service is
  // involved. No-op on any page without a [data-hero-region] hero. The
  // CSS gradient fallback already on .hero-mega covers the time between
  // page load and this resolving (or if it fails/no image exists yet for
  // that region), so the hero never shows a broken background.
  function initHeroRegion() {
    var hero = document.querySelector("[data-hero-region]");
    if (!hero) return;

    var IMAGE_BY_REGION = {
      ca: "assets/hero-ca.jpg",
      us: "assets/hero-us.jpg",
      eu: "assets/hero-eu.jpg",
    };

    fetch("/api/geo")
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        // One /api/geo call serves both the hero image and the prices —
        // a second fetch for the same answer would be a second chance to
        // disagree with the first.
        applyCurrency(data && data.region);
        var path = data && IMAGE_BY_REGION[data.region];
        if (!path) return;
        var img = new Image();
        img.onload = function () {
          hero.style.backgroundImage = "linear-gradient(100deg, rgba(9,12,10,0.94) 0%, rgba(9,12,10,0.72) 42%, rgba(9,12,10,0.25) 68%, rgba(9,12,10,0.55) 100%), linear-gradient(0deg, rgba(9,12,10,0.9) 0%, transparent 22%), url(" + path + ")";
        };
        // Only swap once the image is actually decoded/loaded — never
        // point background-image at a path that doesn't exist yet, which
        // would just leave the CSS fallback gradients showing anyway, but
        // silently, instead of erroring loudly during development.
        img.src = path;
      })
      .catch(function () { /* fallback gradient stays — see .hero-mega */ });
  }

  // PRICES ON THE MARKETING PAGE
  //
  // The number and the currency WORD come from the same row, deliberately.
  // This page shipped "All prices in CAD" underneath euro figures for weeks
  // — a specific, confident, false claim about money that nothing caught,
  // because the label and the amounts were two independent pieces of text.
  // Reading both from one object is what makes that class of bug impossible
  // rather than merely fixed.
  //
  // Mirrors PLAN_PRICES in golsz-app.html and PLAN_CATALOG in
  // api/_plan-catalog.js; tests/test_pricing.cjs diffs all three.
  var CURRENCIES = {
    eur: { symbol: "\u20AC", label: "euro (EUR)", short: "EUR", free: 0, starter: 6, pro: 15, elite: 30 },
    cad: { symbol: "CA$", label: "Canadian dollars (CAD)", short: "CAD", free: 0, starter: 9, pro: 23, elite: 45 },
    usd: { symbol: "US$", label: "US dollars (USD)", short: "USD", free: 0, starter: 7, pro: 16, elite: 32 }
  };
  var REGION_CURRENCY = { ca: "cad", us: "usd", eu: "eur" };

  function applyCurrency(region) {
    // Rest of world gets USD. The static HTML ships EUR, so a visitor with
    // JavaScript off, or a geo call that fails, still reads a coherent page
    // rather than a blank price.
    var row = CURRENCIES[REGION_CURRENCY[region] || "usd"];
    if (!row) return;
    document.querySelectorAll("[data-gz-price]").forEach(function (el) {
      var plan = el.getAttribute("data-gz-price");
      if (!(plan in row)) return;
      var per = el.querySelector("small");
      el.textContent = row.symbol + row[plan];
      if (per) el.appendChild(per);          // keep the "/mo" that was there
    });
    document.querySelectorAll("[data-gz-currency-label]").forEach(function (el) { el.textContent = row.label; });
    document.querySelectorAll("[data-gz-currency-short]").forEach(function (el) { el.textContent = row.short; });
  }

  function initFooterYear() {
    var yearEls = document.querySelectorAll("[data-year]");
    var year = new Date().getFullYear();
    yearEls.forEach(function (el) {
      el.textContent = year;
    });
  }

  function initMobileNav() {
    var toggle = document.querySelector(".nav-toggle");
    var panel = document.querySelector(".mobile-panel");
    if (!toggle || !panel) return;

    toggle.addEventListener("click", function () {
      var isOpen = panel.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(isOpen));
    });

    panel.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        panel.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  function initActiveNav() {
    var path = window.location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll(".nav-link[data-page]").forEach(function (link) {
      if (link.getAttribute("data-page") === path) {
        link.classList.add("is-active");
        link.setAttribute("aria-current", "page");
      }
    });
  }

  function initScrollReveal() {
    var items = document.querySelectorAll(".reveal");
    if (!items.length) return;

    if (!("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("is-visible"); });
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );

    items.forEach(function (el) { observer.observe(el); });
  }

})();
