// Intentionally static: this page never creates orders or payments.
// The indicative card price is retained from the previous storefront.
const UNIT_AMOUNT = 1499;
const MAX_QUANTITY = 10;
const currency = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
});
const dialog = document.querySelector(".selection-dialog");
const reviewButton = document.querySelector("[data-review]");
const quantityControls = [...document.querySelectorAll("[data-quantity]")];
const menuButton = document.querySelector(".menu-toggle");
const menu = document.querySelector("#mobile-menu");
let quantity = 1;
let returnFocus = null;

function updateSelection(nextQuantity) {
  if (
    !Number.isInteger(nextQuantity) ||
    nextQuantity < 1 ||
    nextQuantity > MAX_QUANTITY
  ) {
    throw new RangeError(`Choose between 1 and ${MAX_QUANTITY} cards.`);
  }
  quantity = nextQuantity;
  document.querySelector("[data-quantity-value]").textContent =
    String(quantity);
  document.querySelector("[data-selection-quantity]").textContent =
    String(quantity);
  document.querySelector("[data-card-word]").textContent =
    quantity === 1 ? "card" : "cards";
  document.querySelector("[data-total]").textContent = currency.format(
    (UNIT_AMOUNT * quantity) / 100,
  );
  quantityControls.forEach((button) => {
    button.disabled =
      button.dataset.quantity === "minus"
        ? quantity === 1
        : quantity === MAX_QUANTITY;
  });
  return {
    product: "PINKEVA Card",
    quantity,
    currency: "EUR",
    indicativeSubtotal: UNIT_AMOUNT * quantity,
    checkoutAvailable: false,
    orderCreated: false,
  };
}

function reviewSelection(nextQuantity = quantity) {
  const selection = updateSelection(nextQuantity);
  if (!dialog.open) {
    returnFocus = document.activeElement;
    dialog.showModal();
    document.body.classList.add("modal-open");
  }
  return selection;
}
function closeSelection() {
  dialog.close();
}
quantityControls.forEach((button) =>
  button.addEventListener("click", () => {
    updateSelection(
      Math.max(
        1,
        Math.min(
          MAX_QUANTITY,
          quantity + (button.dataset.quantity === "plus" ? 1 : -1),
        ),
      ),
    );
  }),
);
reviewButton.addEventListener("click", () => reviewSelection());
document
  .querySelectorAll("[data-close]")
  .forEach((button) => button.addEventListener("click", closeSelection));
dialog.addEventListener("close", () => {
  document.body.classList.remove("modal-open");
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
});
// Native dialog supplies focus containment, Escape dismissal and background inertness.
dialog.addEventListener("click", (event) => {
  const bounds = dialog.getBoundingClientRect();
  if (
    event.target === dialog &&
    (event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom)
  )
    closeSelection();
});
document.querySelector("[data-edit]").addEventListener("click", () => {
  returnFocus = quantityControls.find((button) => !button.disabled);
  closeSelection();
  document
    .querySelector("#choose")
    .scrollIntoView({ behavior: "instant", block: "start" });
});

function setMenu(open, restoreFocus = false) {
  menu.hidden = !open;
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  if (restoreFocus) menuButton.focus();
}
menuButton.addEventListener("click", () => setMenu(menu.hidden));
menu
  .querySelectorAll("a")
  .forEach((link) => link.addEventListener("click", () => setMenu(false)));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !menu.hidden) setMenu(false, true);
});
document.addEventListener("click", (event) => {
  if (!menu.hidden && !event.target.closest(".site-header")) setMenu(false);
});

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const mobileLayout = window.matchMedia("(max-width: 760px)");
const stage = document.querySelector(".story-stage");
const story = document.querySelector(".story-layout");
const steps = [...document.querySelectorAll(".story-step")];
const tabs = [...document.querySelectorAll("[data-step]")];
const motionButton = document.querySelector(".motion-toggle");
const hero = document.querySelector(".hero");
const heroCard = document.querySelector(".hero-card");
let paused = false;
let activeStep = 0;
let frame = 0;
let heroVisible = true;
let storyVisible = false;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function setStep(index) {
  activeStep = index;
  tabs.forEach((tab, i) =>
    tab.setAttribute("aria-pressed", String(i === index)),
  );
  steps.forEach((step, i) => step.classList.toggle("is-active", i === index));
  document.querySelector("[data-story-count]").textContent = String(index + 1);
}
function drawScroll() {
  frame = 0;
  if (!mobileLayout.matches && storyVisible) {
    const centers = steps.map((step) => {
      const bounds = step.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    });
    const focusLine = window.innerHeight * 0.55;
    const distance = centers.map((center) => Math.abs(center - focusLine));
    setStep(distance.indexOf(Math.min(...distance)));
    if (!paused && !reducedMotion.matches) {
      const progress = clamp(
        (focusLine - centers[0]) / Math.max(1, centers[2] - centers[0]),
      );
      stage.style.setProperty("--spread", progress.toFixed(3));
    }
  }
  if (
    heroVisible &&
    !paused &&
    !reducedMotion.matches &&
    !mobileLayout.matches
  ) {
    const progress = clamp(
      -hero.getBoundingClientRect().top / hero.offsetHeight,
    );
    heroCard.style.transform = `rotateX(${17 - progress * 12}deg) rotateY(${-24 + progress * 18}deg) rotateZ(${-19 + progress * 9}deg)`;
  }
}
function requestDraw() {
  if (!frame) frame = requestAnimationFrame(drawScroll);
}
function applyMotionPreference() {
  document.body.classList.toggle("motion-paused", paused);
  motionButton.setAttribute("aria-pressed", String(paused));
  motionButton.textContent = paused ? "Resume motion" : "Pause motion";
  if (paused || reducedMotion.matches) {
    heroCard.style.removeProperty("transform");
    stage.style.setProperty("--spread", "1");
  } else if (mobileLayout.matches) {
    heroCard.style.removeProperty("transform");
    stage.style.setProperty("--spread", String(activeStep / 2));
  }
  requestDraw();
}
tabs.forEach((tab, index) =>
  tab.addEventListener("click", () => {
    setStep(index);
    if (mobileLayout.matches) {
      stage.style.setProperty(
        "--spread",
        paused || reducedMotion.matches ? "1" : String(index / 2),
      );
    } else {
      steps[index].scrollIntoView({
        behavior: paused || reducedMotion.matches ? "instant" : "smooth",
        block: "center",
      });
    }
  }),
);
motionButton.addEventListener("click", () => {
  paused = !paused;
  applyMotionPreference();
});
reducedMotion.addEventListener("change", applyMotionPreference);
mobileLayout.addEventListener("change", () => {
  setMenu(false);
  applyMotionPreference();
});
window.addEventListener("resize", requestDraw, { passive: true });
window.addEventListener("scroll", requestDraw, { passive: true });
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.target === hero) heroVisible = entry.isIntersecting;
      if (entry.target === story) storyVisible = entry.isIntersecting;
    });
    requestDraw();
  });
  observer.observe(hero);
  observer.observe(story);
} else {
  storyVisible = true;
}

setStep(0);
story.classList.add("story-ready");
applyMotionPreference();
updateSelection(1);
reviewButton.disabled = false;
document.querySelector("[data-availability]").textContent =
  "Online sales coming soon. Review your selection without placing an order.";
document.querySelector("#year").textContent = String(new Date().getFullYear());

// Optional draft WebMCP enhancement: only stages the same static review.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  try {
    Promise.resolve(
      document.modelContext.registerTool(
        {
          name: "review_card_selection",
          title: "Review PINKEVA Card selection",
          description:
            "Choose 1–10 cards and open the static selection summary. Prices are indicative; no order, reservation or payment is created.",
          inputSchema: {
            type: "object",
            properties: {
              quantity: { type: "integer", minimum: 1, maximum: 10 },
            },
            required: ["quantity"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input) {
            if (
              !input ||
              typeof input !== "object" ||
              !Number.isInteger(input.quantity) ||
              Object.keys(input).some((key) => key !== "quantity")
            )
              throw new TypeError("Provide only a quantity.");
            return reviewSelection(input.quantity);
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
  } catch {
    /* Unsupported draft API must not affect the storefront. */
  }
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
}
