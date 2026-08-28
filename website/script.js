const body = document.body;
const navToggle = document.querySelector('.nav-toggle');
const mobileNav = document.querySelector('.mobile-nav');
const drawer = document.querySelector('.cart-drawer');
const toast = document.querySelector('.toast');
const price = 14.99;
let quantity = 1;
let cartQuantity = 0;
let toastTimer;

function formatPrice(value) {
  return `€${value.toFixed(2)}`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

function setDrawer(open) {
  body.classList.toggle('drawer-open', open);
  drawer.setAttribute('aria-hidden', String(!open));
}

function setMobileNav(open) {
  navToggle.classList.toggle('is-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  mobileNav.classList.toggle('is-open', open);
}

function updateCart() {
  document.querySelectorAll('[data-product-quantity-value]').forEach((element) => {
    element.textContent = quantity;
  });
  document.querySelectorAll('[data-cart-quantity-value]').forEach((element) => {
    element.textContent = cartQuantity;
  });
  document.querySelectorAll('[data-drawer-subtotal]').forEach((element) => {
    element.textContent = formatPrice(price * cartQuantity);
  });
  document.querySelectorAll('[data-cart-count]').forEach((element) => {
    element.textContent = cartQuantity;
  });
  drawer.classList.toggle('is-empty', cartQuantity === 0);
}

navToggle?.addEventListener('click', () => setMobileNav(!mobileNav.classList.contains('is-open')));
mobileNav?.querySelectorAll('a, button').forEach((element) => element.addEventListener('click', () => setMobileNav(false)));

document.querySelectorAll('[data-open-cart]').forEach((button) => {
  button.addEventListener('click', () => {
    setMobileNav(false);
    setDrawer(true);
  });
});
document.querySelectorAll('[data-add-to-cart]').forEach((button) => {
  button.addEventListener('click', () => {
    cartQuantity = quantity;
    updateCart();
    setMobileNav(false);
    setDrawer(true);
  });
});
document.querySelectorAll('[data-close-cart]').forEach((button) => button.addEventListener('click', () => setDrawer(false)));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setDrawer(false);
    setMobileNav(false);
  }
});

document.querySelectorAll('[data-product-quantity="minus"]').forEach((button) => {
  button.addEventListener('click', () => {
    quantity = Math.max(1, quantity - 1);
    updateCart();
  });
});
document.querySelectorAll('[data-product-quantity="plus"]').forEach((button) => {
  button.addEventListener('click', () => {
    quantity = Math.min(10, quantity + 1);
    updateCart();
  });
});
document.querySelectorAll('[data-cart-quantity="minus"]').forEach((button) => {
  button.addEventListener('click', () => {
    cartQuantity = Math.max(1, cartQuantity - 1);
    updateCart();
  });
});
document.querySelectorAll('[data-cart-quantity="plus"]').forEach((button) => {
  button.addEventListener('click', () => {
    cartQuantity = Math.min(10, cartQuantity + 1);
    updateCart();
  });
});

document.querySelectorAll('[data-gallery-image]').forEach((button) => {
  button.addEventListener('click', () => {
    const image = document.querySelector('#gallery-main-image');
    document.querySelectorAll('[data-gallery-image]').forEach((item) => item.classList.remove('is-active'));
    button.classList.add('is-active');
    image.classList.add('is-swapping');
    setTimeout(() => {
      image.src = button.dataset.galleryImage;
      image.alt = button.dataset.galleryAlt;
      image.classList.remove('is-swapping');
    }, 140);
  });
});

document.querySelector('[data-remove]')?.addEventListener('click', () => {
  cartQuantity = 0;
  updateCart();
  showToast('The card was removed from your cart.');
});

document.querySelector('[data-checkout]')?.addEventListener('click', () => {
  if (cartQuantity === 0) {
    showToast('Your cart is empty.');
    return;
  }
  showToast('Local preview only — connect this button to Stripe Checkout when you are ready.');
});

document.querySelector('#year').textContent = new Date().getFullYear();
updateCart();
