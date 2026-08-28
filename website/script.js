const body = document.body;
const navToggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');
const drawer = document.querySelector('.cart-drawer');
const overlay = document.querySelector('.cart-overlay');
const toast = document.querySelector('.toast');
const cardPrice = 14.99;
let quantity = 1;
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

function setNav(open) {
  navLinks.classList.toggle('is-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
}

function setDrawer(open) {
  body.classList.toggle('drawer-open', open);
  drawer.setAttribute('aria-hidden', String(!open));
}

function updateCart() {
  const value = document.querySelector('[data-quantity-value]');
  const subtotal = document.querySelector('[data-subtotal]');
  if (value) value.textContent = quantity;
  if (subtotal) subtotal.textContent = `€${(cardPrice * quantity).toFixed(2)}`;
}

navToggle?.addEventListener('click', () => setNav(!navLinks.classList.contains('is-open')));
navLinks?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setNav(false)));

document.querySelectorAll('[data-add-cart]').forEach((trigger) => {
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    setNav(false);
    setDrawer(true);
  });
});

document.querySelectorAll('[data-close-cart]').forEach((trigger) => trigger.addEventListener('click', () => setDrawer(false)));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setDrawer(false);
    setNav(false);
  }
});

document.querySelector('[data-quantity="minus"]')?.addEventListener('click', () => {
  quantity = Math.max(1, quantity - 1);
  updateCart();
});
document.querySelector('[data-quantity="plus"]')?.addEventListener('click', () => {
  quantity = Math.min(10, quantity + 1);
  updateCart();
});
document.querySelector('[data-remove]')?.addEventListener('click', () => {
  quantity = 0;
  updateCart();
  showToast('Your card was removed from the local preview.');
});

document.querySelectorAll('[data-platform]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-platform]').forEach((item) => item.classList.remove('is-active'));
    button.classList.add('is-active');
    const note = document.querySelector('.platform-note');
    if (note) {
      note.textContent = button.dataset.platform === 'android'
        ? 'The app will provision the Google finding path.'
        : 'The app will provision the Apple finding path.';
    }
  });
});

document.querySelector('[data-checkout]')?.addEventListener('click', () => {
  if (quantity === 0) {
    quantity = 1;
    updateCart();
  }
  showToast('Local preview ready — connect this button to Stripe Checkout when you are ready.');
});

document.querySelector('.signup-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = form.parentElement.querySelector('.signup-message');
  message.textContent = 'You’re on the early-access list.';
  form.reset();
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

document.querySelector('#year').textContent = new Date().getFullYear();
updateCart();
