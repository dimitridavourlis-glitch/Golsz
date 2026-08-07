/* ==========================================================================
   GOLSZ — Global Script
   Handles: mobile nav, active link state, scroll reveal, waitlist form.

   NOTE ON THE WAITLIST FORM
   This is a static, front-end-only site (no backend/server). The waitlist
   and contact forms below intercept submission with JavaScript, validate
   the fields, and show an inline success message — but nothing is sent
   anywhere yet. To go live, either:
     1) Point the <form> "action" at a form endpoint (Tally, Formspree,
        Basin, Getform, etc.) and remove the preventDefault() below, or
     2) Wire the fetch() call (marked TODO below) to your provider's API,
        e.g. Mailchimp's list "subscribe" endpoint or a Tally webhook.
   ========================================================================== */

(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    initFooterYear();
    initMobileNav();
    initActiveNav();
    initScrollReveal();
    initForms();
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

  function initForms() {
    var forms = document.querySelectorAll("form[data-waitlist-form]");
    forms.forEach(function (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!validateForm(form)) return;

        // TODO: replace with a real submission, e.g.:
        // fetch("https://YOUR-PROVIDER-ENDPOINT", {
        //   method: "POST",
        //   headers: { "Content-Type": "application/json" },
        //   body: JSON.stringify(Object.fromEntries(new FormData(form)))
        // });

        showSuccess(form);
      });
    });
  }

  function validateForm(form) {
    var valid = true;
    var fields = form.querySelectorAll("[required]");

    fields.forEach(function (field) {
      var group = field.closest(".form-field") || field.parentElement;
      var value = field.value.trim();
      var ok = value.length > 0;

      if (field.type === "email" && ok) {
        ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      }

      if (!ok) {
        valid = false;
        if (group) group.classList.add("has-error");
      } else if (group) {
        group.classList.remove("has-error");
      }
    });

    return valid;
  }

  function showSuccess(form) {
    var successId = form.getAttribute("data-success-target");
    var successEl = successId ? document.getElementById(successId) : null;

    form.reset();
    form.hidden = true;

    if (successEl) {
      successEl.classList.add("is-visible");
      successEl.setAttribute("tabindex", "-1");
      successEl.focus();
    }
  }
})();
