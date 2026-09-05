import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const script = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// A small event/state fixture, not a browser. Native dialog focus containment,
// layout and visual rendering remain browser-level review items.
class Element {
  constructor() {
    this.listeners = new Map();
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
    };
    this.style = {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
    };
    this.dataset = {};
    this.isConnected = true;
    this.rect = { top: 0, height: 800, bottom: 800, left: 0, right: 500 };
    this.offsetHeight = 800;
  }
  addEventListener(type, callback) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  fire(type, event = {}) {
    for (const callback of this.listeners.get(type) ?? []) callback({ target: this, ...event });
  }
  click() { if (!this.disabled) this.fire('click'); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  getBoundingClientRect() { return this.rect; }
  focus() { this.document.activeElement = this; }
  scrollIntoView(options) { this.scrolled = options; }
  closest() { return null; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
}
function boot({ mobile = false, reduced = false, webmcp = false } = {}) {
  const document = new Element();
  const elements = new Map();
  const el = (selector) => {
    if (!elements.has(selector)) {
      const element = new Element();
      element.document = document;
      elements.set(selector, element);
    }
    return elements.get(selector);
  };
  const minus = el('minus'); minus.dataset.quantity = 'minus';
  const plus = el('plus'); plus.dataset.quantity = 'plus';
  const steps = [0, 1, 2].map((i) => {
    const step = el(`step${i}`);
    step.rect = { top: 120 + i * 520, height: 520 };
    return step;
  });
  const tabs = [0, 1, 2].map((i) => el(`tab${i}`));
  const closes = [el('close'), el('continue')];
  const links = [el('menu-link')];
  const collections = {
    '[data-quantity]': [minus, plus], '[data-close]': closes,
    '.story-step': steps, '[data-step]': tabs,
  };
  document.querySelector = el;
  document.querySelectorAll = (selector) => collections[selector] ?? [];
  document.body = el('body');
  document.activeElement = el('[data-review]');
  el('#mobile-menu').hidden = true;
  el('#mobile-menu').querySelectorAll = () => links;
  el('[data-checkout]').disabled = true;
  const registered = [];
  if (webmcp) document.modelContext = { registerTool: (tool) => registered.push(tool) };
  const window = new Element();
  window.innerHeight = 800;
  const media = [new Element(), new Element()];
  media[0].matches = reduced;
  media[1].matches = mobile;
  window.matchMedia = (query) => query.includes('reduced-motion') ? media[0] : media[1];
  const frames = [];
  vm.runInNewContext(script, { document, window, Intl, AbortController, requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; } });
  const flush = () => { while (frames.length) frames.shift()(); };
  const change = (index, value) => { media[index].matches = value; media[index].fire('change'); flush(); };
  flush();
  return { document, window, el, minus, plus, steps, tabs, closes, links, registered, flush, change };
}

test('selection uses integer cents, enforces bounds, and never enables checkout', () => {
  const page = boot();
  assert.equal(page.el('[data-review]').disabled, false);
  assert.equal(page.minus.disabled, true);
  for (let i = 0; i < 15; i++) page.plus.click();
  assert.equal(page.el('[data-quantity-value]').textContent, '10');
  assert.equal(page.el('[data-total]').textContent, '€149.90');
  assert.equal(page.plus.disabled, true);
  page.el('[data-review]').click();
  assert.equal(page.el('.selection-dialog').open, true);
  assert.equal(page.el('[data-selection-quantity]').textContent, '10');
  assert.equal(page.el('[data-card-word]').textContent, 'cards');
  assert.equal(page.el('[data-checkout]').disabled, true);
  for (let i = 0; i < 15; i++) page.minus.click();
  assert.equal(page.el('[data-total]').textContent, '€14.99');
  assert.equal(page.el('[data-card-word]').textContent, 'card');
});

test('closing and editing a selection release the scroll lock and restore a usable focus target', () => {
  const page = boot();
  page.el('[data-review]').click();
  assert.equal(page.document.body.classList.contains('modal-open'), true);
  page.closes[0].click();
  assert.equal(page.document.body.classList.contains('modal-open'), false);
  assert.equal(page.document.activeElement, page.el('[data-review]'));
  page.el('[data-review]').click();
  page.el('[data-edit]').click();
  assert.equal(page.el('.selection-dialog').open, false);
  assert.equal(page.document.activeElement, page.plus);
  assert.equal(page.el('#choose').scrolled.block, 'start');
});

test('mobile menu dismisses on navigation, Escape and desktop breakpoint changes', () => {
  const page = boot({ mobile: true });
  const button = page.el('.menu-toggle');
  button.click();
  assert.equal(page.el('#mobile-menu').hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  page.links[0].click();
  assert.equal(page.el('#mobile-menu').hidden, true);
  button.click();
  page.document.fire('keydown', { key: 'Escape' });
  assert.equal(page.document.activeElement, button);
  button.click();
  page.change(1, false);
  assert.equal(page.el('#mobile-menu').hidden, true);
});

test('mobile story controls select matching copy and layers without jumping the page', () => {
  const page = boot({ mobile: true });
  page.tabs[2].click();
  assert.equal(page.tabs[2].getAttribute('aria-pressed'), 'true');
  assert.equal(page.steps[2].classList.contains('is-active'), true);
  assert.equal(page.steps[0].classList.contains('is-active'), false);
  assert.equal(page.el('.story-stage').style['--spread'], '1');
  assert.equal(page.steps[2].scrolled, undefined);
  page.tabs[0].click();
  assert.equal(page.el('.story-stage').style['--spread'], '0');
});

test('desktop scroll reveals layers; pause and system reduced motion stop transforms', () => {
  const page = boot();
  const move = () => {
    page.steps.forEach((step) => { step.rect.top -= 600; });
    page.el('.hero').rect.top = -200;
    page.window.fire('scroll'); page.flush();
  };
  const initial = Number(page.el('.story-stage').style['--spread']);
  move();
  assert.ok(Number(page.el('.story-stage').style['--spread']) > initial);
  assert.equal(page.tabs[1].getAttribute('aria-pressed'), 'true');
  page.el('.motion-toggle').click(); page.flush();
  assert.equal(page.el('.story-stage').style['--spread'], '1');
  assert.equal(page.el('.hero-card').style.transform, undefined);
  move();
  assert.equal(page.el('.hero-card').style.transform, undefined);
  page.el('.motion-toggle').click(); page.flush();
  page.change(0, true);
  move();
  assert.equal(page.el('.story-stage').style['--spread'], '1');
  assert.equal(page.el('.hero-card').style.transform, undefined);
});

test('optional agent contract opens the same static review and rejects invalid input atomically', () => {
  const page = boot({ webmcp: true });
  assert.equal(page.registered.length, 1);
  const tool = page.registered[0];
  assert.equal(tool.name, 'review_card_selection');
  assert.equal(tool.annotations.readOnlyHint, false);
  const result = tool.execute({ quantity: 3 });
  assert.equal(result.indicativeSubtotal, 4497);
  assert.equal(result.orderCreated, false);
  assert.equal(result.checkoutAvailable, false);
  assert.equal(page.el('[data-selection-quantity]').textContent, '3');
  assert.equal(page.el('.selection-dialog').open, true);
  for (const input of [null, {}, [], { quantity: 0 }, { quantity: 11 }, { quantity: 1.5 }, { quantity: '3' }, { quantity: 2, pay: true }]) {
    assert.throws(() => tool.execute(input));
    assert.equal(page.el('[data-selection-quantity]').textContent, '3');
  }
});

test('static page links and assets resolve; checkout stays disabled without JavaScript', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(anchor), `Missing anchor: ${anchor}`);
  for (const [, path] of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) {
    const relative = path.startsWith('/assets/') ? `../public${path}` : `..${path}`;
    assert.ok(existsSync(fileURLToPath(new URL(relative, import.meta.url))), `Missing asset: ${path}`);
  }
  assert.match(html, /<button[^>]*data-checkout[^>]*disabled/s);
  assert.match(html, /<noscript\b/);
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|location\.(?:href|assign|replace)/);
});
