import { Component } from '@theme/component';

import {
  fetchConfig,
  preloadImage,
  onAnimationEnd,
  yieldToMainThread,
  parseIntOrDefault,
  debounce,
  isDesktopBreakpoint,
  mediaQueryLarge,
  center,
  closest,
  clamp,
  prefersReducedMotion,
  preventDefault,
  viewTransition,
  scheduler,
  isMobileBreakpoint,
  getIOSVersion,
} from '@theme/utilities';

import { morph } from '@theme/morph';

import {
  StandardEvents,
  ProductSelectEvent,
  CartLinesUpdateEvent,
  CartErrorEvent,
} from '@shopify/events';

import { cartPerformance } from '@theme/performance';
import { resolveVariantId } from '@theme/variant-resolution';

import { OverflowList } from '@theme/overflow-list';
import VariantPicker from '@theme/variant-picker';
import { ProductComponent } from '@theme/view-event-elements';

import { SlideshowSelectEvent, ThemeEvents } from '@theme/events';

import { Scroller, scrollIntoView } from '@theme/scrolling';

import { DialogComponent, DialogCloseEvent } from '@theme/dialog';


// The threshold for determining visibility of slides.
const SLIDE_VISIBLITY_THRESHOLD = 0.7;


/**
 * A custom element that allows the user to select a quantity.
 *
 * This component follows a pure event-driven architecture where quantity changes
 * are broadcast via QuantitySelectorUpdateEvent. Parent components that contain
 * quantity selectors listen for these events and handle them according to their
 * specific needs, with event filtering ensuring each parent only processes events
 * from its own quantity selectors to prevent conflicts between different cart
 * update strategies.
 *
 * @typedef {Object} Refs
 * @property {HTMLInputElement} quantityInput
 * @property {HTMLButtonElement} minusButton
 * @property {HTMLButtonElement} plusButton
 *
 * @extends {Component<Refs>}
 */
export class UsfQuantitySelectorComponent extends Component {
  serverDisabledMinus = false;
  serverDisabledPlus = false;
  initialized = false;

  connectedCallback() {
     this.waitForRefs();
  }
  waitForRefs() {
  if (this.tryInit()) return;

  this._observer = new MutationObserver(() => {
    if (this.tryInit()) {
      this._observer.disconnect();
      this._observer = null;
    }
  });

  this._observer.observe(this, {
    childList: true,
    subtree: true,
  });
}

tryInit() {
  const quantityInput = this.querySelector('[rtef="quantityInput"]');
  const minusButton = this.querySelector('[rtef="minusButton"]');
  const plusButton = this.querySelector('[rtef="plusButton"]');

  if (!quantityInput || !minusButton || !plusButton) {
    return false;
  }

  this.refs = { quantityInput, minusButton, plusButton };
  this.initCard();
  return true;
}
  initCard(){
    super.connectedCallback();


    this.refs = {
      quantityInput: this.querySelector('[rtef="quantityInput"]'),
      minusButton: this.querySelector('[rtef="minusButton"]'),
      plusButton: this.querySelector('[rtef="plusButton"]'),
    };
    

    // Capture server-disabled state on first load
    const { minusButton, plusButton } = this.refs;

    if (minusButton.disabled) {
      this.serverDisabledMinus = true;
    }
    if (plusButton.disabled) {
      this.serverDisabledPlus = true;
    }

    this.initialized = true;
    this.updateButtonStates();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
  }

  /**
   * Updates cart quantity and refreshes component state
   * @param {number} cartQty - The quantity currently in cart for this variant
   */
  setCartQuantity(cartQty) {
    this.refs.quantityInput.setAttribute('data-cart-quantity', cartQty.toString());
    this.updateCartQuantity();
  }

  /**
   * Checks if the current quantity can be added to cart without exceeding max
   * @returns {{canAdd: boolean, maxQuantity: number|null, cartQuantity: number, quantityToAdd: number}} Validation result
   */
  canAddToCart() {
    const { max, cartQuantity, value } = this.getCurrentValues();
    const quantityToAdd = value;
    const wouldExceedMax = max !== null && cartQuantity + quantityToAdd > max;

    return {
      canAdd: !wouldExceedMax,
      maxQuantity: max,
      cartQuantity,
      quantityToAdd,
    };
  }

  /**
   * Gets the current quantity value
   * @returns {string} The current value
   */
  getValue() {
    return this.refs.quantityInput.value;
  }

  /**
   * Sets the current quantity value
   * @param {string} value - The value to set
   */
  setValue(value) {
    this.refs.quantityInput.value = value;
  }

  /**
   * Updates min/max/step constraints and snaps value to valid increment
   * @param {string} min - Minimum value
   * @param {string|null} max - Maximum value (null if no max)
   * @param {string} step - Step increment
   */
  updateConstraints(min, max, step) {
    const { quantityInput } = this.refs;
    const currentValue = parseInt(quantityInput.value) || 0;

    quantityInput.min = min;
    if (max) {
      quantityInput.max = max;
    } else {
      quantityInput.removeAttribute('max');
    }
    quantityInput.step = step;

    const newMin = parseIntOrDefault(min, 1);
    const newStep = parseIntOrDefault(step, 1);
    const effectiveMax = this.getEffectiveMax();

    // Snap to valid increment if not already aligned
    let newValue = currentValue;
    if ((currentValue - newMin) % newStep !== 0) {
      // Snap DOWN to closest valid increment
      newValue = newMin + Math.floor((currentValue - newMin) / newStep) * newStep;
    }

    // Ensure value is within bounds
    newValue = Math.max(newMin, Math.min(effectiveMax ?? Infinity, newValue));

    if (newValue !== currentValue) {
      quantityInput.value = newValue.toString();
    }

    this.updateButtonStates();
  }

  /**
   * Gets current values from DOM (fresh read every time)
   * @returns {{min: number, max: number|null, step: number, value: number, cartQuantity: number}}
   */
  getCurrentValues() {
    const { quantityInput } = this.refs;

    return {
      min: parseIntOrDefault(quantityInput.min, 1),
      max: parseIntOrDefault(quantityInput.max, null),
      step: parseIntOrDefault(quantityInput.step, 1),
      value: parseIntOrDefault(quantityInput.value, 0),
      cartQuantity: parseIntOrDefault(quantityInput.getAttribute('data-cart-quantity'), 0),
    };
  }

  /**
   * Gets the effective maximum value for this quantity selector
   * Product page: max - cartQuantity (how many can be added)
   * Override in subclass for different behavior
   * @returns {number | null} The effective max, or null if no max
   */
  getEffectiveMax() {
    const { max, cartQuantity, min } = this.getCurrentValues();
    if (max === null) return null;
    // Product page: can only add what's left
    return Math.max(max - cartQuantity, min);
  }

  /**
   * Updates button states based on current value and limits
   */
  updateButtonStates() {
    const { minusButton, plusButton } = this.refs;
    const { min, value } = this.getCurrentValues();
    const effectiveMax = this.getEffectiveMax();

    // Only manage buttons that weren't server-disabled
    if (!this.serverDisabledMinus) {
      minusButton.disabled = value <= min;
    }

    if (!this.serverDisabledPlus) {
      plusButton.disabled = effectiveMax !== null && value >= effectiveMax;
    }
  }

  /**
   * Updates quantity by a given step
   * @param {number} stepMultiplier - Positive for increase, negative for decrease
   */
  updateQuantity(stepMultiplier) {
    const { quantityInput } = this.refs;
    const { min, step, value } = this.getCurrentValues();
    const effectiveMax = this.getEffectiveMax();

    const newValue = Math.min(effectiveMax ?? Infinity, Math.max(min, value + step * stepMultiplier));

    quantityInput.value = newValue.toString();
    this.onQuantityChange();
    this.updateButtonStates();
  }

  /**
   * Handles the quantity increase event.
   * @param {Event} event - The event.
   */
  increaseQuantity(event) {
    if (!(event.target instanceof HTMLElement)) return;
    event.preventDefault();
    this.updateQuantity(1);
  }

  /**
   * Handles the quantity decrease event.
   * @param {Event} event - The event.
   */
  decreaseQuantity(event) {
    if (!(event.target instanceof HTMLElement)) return;
    event.preventDefault();
    this.updateQuantity(-1);
  }

  /**
   * When our input gets focused, we want to fully select the value.
   * @param {FocusEvent} event
   */
  selectInputValue(event) {
    const { quantityInput } = this.refs;
    if (!(event.target instanceof HTMLInputElement) || document.activeElement !== quantityInput) return;

    quantityInput.select();
  }

  /**
   * Handles the quantity set event (on blur).
   * Validates and snaps to valid values.
   * @param {Event} event - The event.
   */
  setQuantity(event) {
    if (!(event.target instanceof HTMLInputElement)) return;

    event.preventDefault();
    const { quantityInput } = this.refs;
    const { min, step } = this.getCurrentValues();
    const effectiveMax = this.getEffectiveMax();

    // Snap to bounds
    const quantity = Math.min(effectiveMax ?? Infinity, Math.max(min, parseInt(event.target.value) || 0));

    // Validate step increment
    if ((quantity - min) % step !== 0) {
      // Set the invalid value and trigger native HTML validation
      quantityInput.value = quantity.toString();
      quantityInput.reportValidity();
      return;
    }

    quantityInput.value = quantity.toString();
    this.onQuantityChange();
    this.updateButtonStates();
  }

  /**
   * Handles the quantity change event.
   */
  onQuantityChange() {
    const { quantityInput } = this.refs;
    const newValue = parseInt(quantityInput.value);

    this.dispatchEvent(new QuantitySelectorUpdateEvent(newValue, Number(quantityInput.dataset.cartLine) || undefined));
  }

  /**
   * Updates the cart quantity from data attribute and refreshes button states
   * Called when cart is updated from external sources
   */
  updateCartQuantity() {
    const { quantityInput } = this.refs;
    const { min, value } = this.getCurrentValues();
    const effectiveMax = this.getEffectiveMax();

    // Clamp value to new effective max if necessary
    const clampedValue = Math.min(effectiveMax ?? Infinity, Math.max(min, value));

    if (clampedValue !== value) {
      quantityInput.value = clampedValue.toString();
    }

    this.updateButtonStates();
  }

  /**
   * Gets the quantity input.
   * @returns {HTMLInputElement} The quantity input.
   */
  get quantityInput() {
    if (!this.refs.quantityInput) {
      throw new Error('Missing <input ref="quantityInput" /> inside <quantity-selector-component />');
    }

    return this.refs.quantityInput;
  }
}

if (!customElements.get('usf-quantity-selector-component')) {
  customElements.define('usf-quantity-selector-component', UsfQuantitySelectorComponent);
}



/**
 * A custom element that displays a product card.
 *
 * @typedef {object} Refs
 * @property {HTMLAnchorElement} productCardLink - The product card link element.
 * @property {import('slideshow').Slideshow} [slideshow] - The slideshow component.
 * @property {import('quick-add').QuickAddComponent} [quickAdd] - The quick add component.
 * @property {HTMLElement} [cardGallery] - The card gallery component.
 *
 * @extends {Component<Refs>}
 */
export class UsfProductCard extends Component {
  requiredRefs = ['productCardLink'];

  get productPageUrl() {
    return this.refs.productCardLink.href;
  }

  /**
   * Gets the currently selected variant ID from the product card
   * @returns {string | null} The variant ID or null if none selected
   */
  getSelectedVariantId() {
    const checkedInput = /** @type {HTMLInputElement | null} */ (
      this.querySelector('input[type="radio"]:checked[data-variant-id]')
    );

    return checkedInput?.dataset.variantId || null;
  }

  /**
   * Gets the product card link element
   * @returns {HTMLAnchorElement | null} The product card link or null
   */
  getProductCardLink() {
    return this.refs.productCardLink || null;
  }

  #fetchProductPageHandler = () => {
    this.refs.quickAdd?.fetchProductPage(this.productPageUrl);
  };

  /**
   * Navigates to a URL link. Respects modifier keys for opening in new tab/window.
   * @param {Event} event - The event that triggered the navigation.
   * @param {URL} url - The URL to navigate to.
   */
  #navigateToURL = (event, url) => {
    // Check for modifier keys that should open in new tab/window (only for mouse events)
    const shouldOpenInNewTab =
      event instanceof MouseEvent && (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1);

    if (shouldOpenInNewTab) {
      event.preventDefault();
      window.open(url.href, '_blank');
      return;
    } else {
      window.location.href = url.href;
    }
  };

  connectedCallback() {
    requestAnimationFrame(() => this.initCard());
  }
  initCard(){
    
    this.querySelectorAll('[rtef]').forEach(el => {
      this.refs[el.getAttribute('rtef')] = el;
      el.setAttribute('ref',el.getAttribute('rtef'))
    });
    super.connectedCallback();
    const link = this.refs.productCardLink;
    if (!(link instanceof HTMLAnchorElement)) throw new Error('Product card link not found');
    this.#handleQuickAdd();

    this.addEventListener(ThemeEvents.variantUpdate, this.#handleVariantUpdate);
    this.addEventListener(ThemeEvents.variantSelected, this.#handleVariantSelected);
    this.addEventListener(SlideshowSelectEvent.eventName, this.#handleSlideshowSelect);
    mediaQueryLarge.addEventListener('change', this.#handleQuickAdd);

    this.addEventListener('click', this.navigateToProduct);

    // Preload the next image on the slideshow to avoid white flashes on previewImage
    setTimeout(() => {
      if (this.refs.slideshow?.isNested) {
        this.#preloadNextPreviewImage();
      }
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('click', this.navigateToProduct);
  }

  #preloadNextPreviewImage() {
    const currentSlide = this.refs.slideshow?.slides?.[this.refs.slideshow?.current];
    currentSlide?.nextElementSibling?.querySelector('img[loading="lazy"]')?.removeAttribute('loading');
  }

  /**
   * Handles the quick add event.
   */
  #handleQuickAdd = () => {
    this.removeEventListener('pointerenter', this.#fetchProductPageHandler);
    this.removeEventListener('focusin', this.#fetchProductPageHandler);

    if (isDesktopBreakpoint()) {
      this.addEventListener('pointerenter', this.#fetchProductPageHandler);
      this.addEventListener('focusin', this.#fetchProductPageHandler);
    }
  };

  /**
   * Handles the variant selected event.
   * @param {VariantSelectedEvent} event - The variant selected event.
   */
  #handleVariantSelected = (event) => {
    if (event.target !== this.variantPicker) {
      this.variantPicker?.updateSelectedOption(event.detail.resource.id);
    }
  };

  /**
   * Handles the variant update event.
   * Updates price, checks for unavailable variants, and updates product URL.
   * @param {VariantUpdateEvent} event - The variant update event.
   */
  #handleVariantUpdate = (event) => {
    // Stop the event from bubbling up to the section, variant updates triggered from product cards are fully handled
    // by this component and should not affect anything outside the card.
    event.stopPropagation();

    this.updatePrice(event);
    this.#isUnavailableVariantSelected(event);
    this.#updateProductUrl(event);
    this.refs.quickAdd?.fetchProductPage(this.productPageUrl);

    if (event.target !== this.variantPicker) {
      this.variantPicker?.updateVariantPicker(event.detail.data.html);
    }

    this.#updateVariantImages();
    this.#previousSlideIndex = null;

    // Remove attribute after re-rendering since a variant selection has been made
    this.removeAttribute('data-no-swatch-selected');

    // Force overflow list to reflow after variant update
    // This fixes an issue where the overflow counter doesn't update properly in some browsers
    this.#updateOverflowList();
  };

  /**
   * Forces the overflow list to recalculate by dispatching a reflow event.
   * This ensures the overflow counter displays correctly after variant updates.
   */
  #updateOverflowList() {
    // Find the overflow list in the variant picker
    const overflowList = this.querySelector('usf-swatches-variant-picker-component overflow-list');
    const isActiveOverflowList = overflowList?.querySelector('[slot="overflow"]') ? true : false;
    if (!overflowList || !isActiveOverflowList) return;

    // Use requestAnimationFrame to ensure DOM has been updated
    requestAnimationFrame(() => {
      // Dispatch a reflow event to trigger recalculation
      overflowList.dispatchEvent(
        new CustomEvent('reflow', {
          bubbles: true,
          detail: {},
        })
      );
    });
  }

  /**
   * Updates the DOM with a new price.
   * @param {VariantUpdateEvent} event - The variant update event.
   */
  updatePrice(event) {
    const priceContainer = this.querySelectorAll(`usf-product-price [ref='priceContainer']`)[1];
    const newPriceElement = event.detail.data.html.querySelector(`usf-product-price [ref='priceContainer']`);

    if (newPriceElement && priceContainer) {
      morph(priceContainer, newPriceElement);
    }
  }

  /**
   * Updates the product URL based on the variant update event.
   * @param {VariantUpdateEvent} event - The variant update event.
   */
  #updateProductUrl(event) {
    const anchorElement = event.detail.data.html?.querySelector('usf-product-card a');
    const featuredMediaUrl = event.detail.data.html
      ?.querySelector('product-card-link')
      ?.getAttribute('data-featured-media-url');

    // If the product card is inside a product link, update the product link's featured media URL
    if (featuredMediaUrl && this.closest('product-card-link'))
      this.closest('product-card-link')?.setAttribute('data-featured-media-url', featuredMediaUrl);

    if (anchorElement instanceof HTMLAnchorElement) {
      // If the href is empty, don't update the product URL eg: unavailable variant
      if (anchorElement.getAttribute('href')?.trim() === '') return;

      const productUrl = anchorElement.href;
      const { productCardLink, productTitleLink, cardGalleryLink } = this.refs;

      productCardLink.href = productUrl;
      if (cardGalleryLink instanceof HTMLAnchorElement) {
        cardGalleryLink.href = productUrl;
      }
      if (productTitleLink instanceof HTMLAnchorElement) {
        productTitleLink.href = productUrl;
      }
    }
  }

  /**
   * Checks if an unavailable variant is selected.
   * @param {VariantUpdateEvent} event - The variant update event.
   */
  #isUnavailableVariantSelected(event) {
    const allVariants = /** @type {NodeListOf<HTMLInputElement>} */ (
      event.detail.data.html.querySelectorAll('input:checked')
    );

    for (const variant of allVariants) {
      this.#toggleAddToCartButton(variant.dataset.optionAvailable === 'true');
    }
  }

  /**
   * Toggles the add to cart button state.
   * @param {boolean} enable - Whether to enable or disable the button.
   */
  #toggleAddToCartButton(enable) {
    const addToCartButton = this.querySelector('.add-to-cart__button button');

    if (addToCartButton instanceof HTMLButtonElement) {
      addToCartButton.disabled = !enable;
    }
  }

  /**
   * Hide the variant images that are not for the selected variant.
   */
  #updateVariantImages() {
    const { slideshow } = this.refs;
    if (!this.variantPicker?.selectedOption) {
      return;
    }

    const selectedImageId = this.variantPicker?.selectedOption.dataset.optionMediaId;

    if (slideshow && selectedImageId) {
      const { slides = [] } = slideshow.refs;

      for (const slide of slides) {
        if (slide.getAttribute('variant-image') == null) continue;

        slide.hidden = slide.getAttribute('slide-id') !== selectedImageId;
      }

      slideshow.select({ id: selectedImageId }, undefined, { animate: false });
    }
  }

  /**
   * Gets all variant inputs.
   * @returns {NodeListOf<HTMLInputElement>} All variant input elements.
   */
  get allVariants() {
    return this.querySelectorAll('input[data-variant-id]');
  }

  /**
   * Gets the variant picker component.
   * @returns {VariantPicker | null} The variant picker component.
   */
  get variantPicker() {
    return this.querySelector('usf-swatches-variant-picker-component');
  }
  /** @type {number | null} */
  #previousSlideIndex = null;

  /**
   * Handles the slideshow select event.
   * @param {SlideshowSelectEvent} event - The slideshow select event.
   */
  #handleSlideshowSelect = (event) => {
    if (event.detail.userInitiated) {
      this.#previousSlideIndex = event.detail.index;
    }
  };

  /**
   * Previews a variant.
   * @param {string} id - The id of the variant to preview.
   */
  previewVariant(id) {
    const { slideshow } = this.refs;

    if (!slideshow) return;

    this.resetVariant.cancel();
    slideshow.select({ id }, undefined, { animate: false });
  }

  /**
   * Previews the next image.
   * @param {PointerEvent} event - The pointer event.
   */
  previewImage(event) {
    if (event.pointerType !== 'mouse') return;

    const { slideshow } = this.refs;

    if (!slideshow) return;

    this.resetVariant.cancel();

    if (this.#previousSlideIndex != null && this.#previousSlideIndex > 0) {
      slideshow.select(this.#previousSlideIndex, undefined, { animate: false });
    } else {
      slideshow.next(undefined, { animate: false });
      setTimeout(() => this.#preloadNextPreviewImage());
    }
  }

  /**
   * Resets the image to the variant image.
   * @param {PointerEvent} event - The pointer event.
   */
  resetImage(event) {
    if (event.pointerType !== 'mouse') return;

    const { slideshow } = this.refs;

    if (!this.variantPicker) {
      if (!slideshow) return;
      slideshow.previous(undefined, { animate: false });
    } else {
      this.#resetVariant();
    }
  }

  /**
   * Resets the image to the variant image.
   */
  #resetVariant = () => {
    const { slideshow } = this.refs;

    if (!slideshow) return;

    // If we have a selected variant, always use its image
    if (this.variantPicker?.selectedOption) {
      const id = this.variantPicker.selectedOption.dataset.optionMediaId;
      if (id) {
        slideshow.select({ id }, undefined, { animate: false });
        return;
      }
    }

    // No variant selected - use initial slide if it's valid
    const initialSlide = slideshow.initialSlide;
    const slideId = initialSlide?.getAttribute('slide-id');
    if (initialSlide && slideshow.slides?.includes(initialSlide) && slideId) {
      slideshow.select({ id: slideId }, undefined, { animate: false });
      return;
    }

    // No valid initial slide or selected variant - go to previous
    slideshow.previous(undefined, { animate: false });
  };

  /**
   * Intercepts the click event on the product card anchor, we want
   * to use this to add an intermediate state to the history.
   * This intermediate state captures the page we were on so that we
   * navigate back to the same page when the user navigates back.
   * In addition to that, it captures the product card anchor so that we
   * have the specific product card in view.
   *
   * A product card can have other interactive elements like variant picker,
   * so we do not navigate if the click was on one of those elements.
   *
   * @param {Event} event
   */
  navigateToProduct = (event) => {
    if (!(event.target instanceof Element)) return;

    // Don't navigate if this product card is marked as no-navigation (e.g., in theme editor)
    if (this.hasAttribute('data-no-navigation')) return;

    const interactiveElement = event.target.closest('button, input, label, select, [tabindex="1"]');

    // If the click was on an interactive element, do nothing.
    if (interactiveElement) {
      return;
    }

    const link = this.refs.productCardLink;
    if (!link.href) return;
    const linkURL = new URL(link.href);

    const productCardAnchor = link.getAttribute('id');
    if (!productCardAnchor) return;

    const infiniteResultsList = this.closest('results-list[infinite-scroll="true"]');
    if (!window.Shopify.designMode && infiniteResultsList) {
      const url = new URL(window.location.href);
      const parent = this.closest('li');
      url.hash = productCardAnchor;
      if (parent && parent.dataset.page) {
        url.searchParams.set('page', parent.dataset.page);
      }

      yieldToMainThread().then(() => {
        history.replaceState({}, '', url.toString());
      });
    }

    const targetLink = event.target.closest('a');
    // Let the native navigation handle the click if it was on a link.
    if (!targetLink) {
      this.#navigateToURL(event, linkURL);
    }
  };

  /**
   * Resets the variant.
   */
  resetVariant = debounce(this.#resetVariant, 100);
}

if (!customElements.get('usf-product-card')) {
  customElements.define('usf-product-card', UsfProductCard);
}

/**
 * @extends {VariantPicker<SwatchesRefs>}
 */
class UsfSwatchesVariantPickerComponent extends VariantPicker {

   connectedCallback() {
   requestAnimationFrame(() => this.initCard());
  }

   initCard(){
    super.connectedCallback();

    // Cache the parent product card
    this.parentProductCard = this.closest('usf-product-card');

    // Listen for variant updates to apply pending URL changes
    this.addEventListener(ThemeEvents.variantUpdate, this.#handleCardVariantUrlUpdate.bind(this));
   }

  /**
   * Updates the card URL when a variant is selected.
   */
  #handleCardVariantUrlUpdate() {
    if (this.pendingVariantId && this.parentProductCard instanceof ProductCard) {
      const currentUrl = new URL(this.parentProductCard.refs.productCardLink.href);
      currentUrl.searchParams.set('variant', this.pendingVariantId);
      this.parentProductCard.refs.productCardLink.href = currentUrl.toString();
      this.pendingVariantId = null;
    }
  }

  /**
   * Override the variantChanged method to handle unavailable swatches with available alternatives.
   * @param {Event} event - The variant change event.
   */
  variantChanged(event) {
    if (!(event.target instanceof HTMLElement)) return;

    // Check if this is a swatch input
    const isSwatchInput = event.target instanceof HTMLInputElement && event.target.name?.includes('-swatch');
    const clickedSwatch = event.target;
    const availableCount = parseInt(clickedSwatch.dataset.availableCount || '0');
    const firstAvailableVariantId = clickedSwatch.dataset.firstAvailableOrFirstVariantId;

    // For swatch inputs, check if we need special handling
    if (isSwatchInput && availableCount > 0 && firstAvailableVariantId) {
      // If this is an unavailable variant but there are available alternatives
      // Prevent the default handling
      event.stopPropagation();

      // Update the selected option visually
      this.updateSelectedOption(clickedSwatch);

      // Build request URL with the first available variant
      const productUrl = this.dataset.productUrl?.split('?')[0];

      if (!productUrl) return;

      const url = new URL(productUrl, window.location.origin);
      url.searchParams.set('variant', firstAvailableVariantId);
      url.searchParams.set('section_id', 'section-rendering-product-card');

      const requestUrl = url.href;

      // Store the variant ID we want to apply to the URL
      this.pendingVariantId = firstAvailableVariantId;

      // Use parent's fetch method
      this.fetchUpdatedSection(requestUrl);
      return;
    }

    // For all other cases, use the default behavior
    super.variantChanged(event);
  }

  /**
   * Shows all swatches.
   * @param {Event} [event] - The event that triggered the show all swatches.
   */
  showAllSwatches(event) {
    event?.preventDefault();

    const { overflowList } = this.refs;

    if (overflowList instanceof OverflowList) {
      overflowList.showAll();
    }
  }
}

if (!customElements.get('usf-swatches-variant-picker-component')) {
  customElements.define('usf-swatches-variant-picker-component', UsfSwatchesVariantPickerComponent);
}

/**
 * Shared viewport observer manager for lazy scroll enablement.
 *
 * Limit the number of compositor layers created by slideshows by only enabling scrolling when the slideshow is in the viewport.
 * Resolves known issues with iOS Safari where too many composition layers will crash the page.
 * When a slideshow is NOT in the viewport, it has overflow: hidden (no compositor layer).
 * When a slideshow enters the viewport, the [in-viewport] attribute is added, enabling scrolling.
 */
class SlideshowViewportObserver {
  /** @type {SlideshowViewportObserver | null} */
  static #instance = null;

  /** @type {IntersectionObserver | null} */
  #observer = null;

  /**
   * Gets the singleton instance
   * @returns {SlideshowViewportObserver}
   */
  static getInstance() {
    if (!this.#instance) {
      this.#instance = new SlideshowViewportObserver();
    }
    return this.#instance;
  }

  /**
   * Registers a slideshow to be observed for viewport visibility
   * @param {Slideshow} slideshow - The slideshow to observe
   */
  observe(slideshow) {
    if (!this.#observer) {
      this.#observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const slideshowElement = /** @type {Slideshow} */ (entry.target);
            if (entry.isIntersecting) {
              slideshowElement.setAttribute('in-viewport', '');
            } else {
              slideshowElement.removeAttribute('in-viewport');
            }
          }
        },
        {
          rootMargin: '100px',
        }
      );
    }

    this.#observer.observe(slideshow);
  }

  /**
   * Unregisters a slideshow from viewport observation
   * @param {Slideshow} slideshow - The slideshow to unobserve
   */
  unobserve(slideshow) {
    this.#observer?.unobserve(slideshow);
    slideshow.removeAttribute('in-viewport');
  }
}

/**
 * Slideshow custom element that allows sliding between content.
 *
 * @typedef {Object} Refs
 * @property {HTMLElement} scroller
 * @property {HTMLElement} slideshowContainer
 * @property {HTMLElement[]} [slides]
 * @property {HTMLElement} [current]
 * @property {HTMLElement[]} [thumbnails]
 * @property {HTMLElement[]} [dots]
 * @property {HTMLButtonElement} [previous]
 * @property {HTMLButtonElement} [next]
 *
 * @extends {Component<Refs>}
 */
export class UsfSlideshow extends Component {
  static get observedAttributes() {
    return ['initial-slide'];
  }

  /**
   * @param {string} name
   * @param {string} oldValue
   * @param {string} newValue
   */
  attributeChangedCallback(name, oldValue, newValue) {
    // Collection page filtering will Morph slideshow galleries in place, updating
    // the slideshow[initial-slide] and slideshow-slide[hidden] attributes.
    // We need to re-select() the slide after the morph is complete, but not before
    // slideshow-slide elements have their [hidden] attribute updated.
    if (name === 'initial-slide' && oldValue !== newValue) {
      queueMicrotask(() => {
        // Only select if the component is connected and initialized
        if (!this.isConnected || !this.#scroll || !this.refs.slides) return;
        const index = parseInt(newValue, 10) || 0;
        const slide_id = this.refs.slides[index]?.getAttribute('slide-id');
        if (slide_id) {
          this.select({ id: slide_id }, undefined, { animate: false });
        }
      });
    }
  }

  requiredRefs = ['scroller'];

   connectedCallback() {
   requestAnimationFrame(() => this.initCard());
  }

  async initCard(){
    super.connectedCallback();
    // Register with shared viewport observer for lazy scroll enablement.
    // This prevents iOS Safari crashes caused by too many compositor layers.
    SlideshowViewportObserver.getInstance().observe(this);

    // Wait for any in-progress view transitions to finish
    if (viewTransition.current) {
      await viewTransition.current;
      // It's possible that the slideshow was disconnected before the view transition finished
      if (!this.isConnected) return;
    }

    const slideCount = this.slides?.length || 0;
    slideCount <= 1 ? this.#setupSlideshowWithoutControls() : this.#setupSlideshow();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Unregister from shared viewport observer
    SlideshowViewportObserver.getInstance().unobserve(this);

    if (this.#scroll) {
      const { scroller } = this.refs;
      scroller.removeEventListener('mousedown', this.#handleMouseDown);
      this.#scroll.destroy();
    }

    const slideCount = this.slides?.length || 0;
    if (slideCount > 1) {
      this.removeEventListener('mouseenter', this.suspend);
      this.removeEventListener('mouseleave', this.resume);
      this.removeEventListener('pointerenter', this.#handlePointerEnter);
      document.removeEventListener('visibilitychange', this.#handleVisibilityChange);
    }

    if (this.#resizeObserver) {
      this.#resizeObserver.disconnect();
    }

    if (this.#intersectionObserver) {
      this.#intersectionObserver.disconnect();
      this.#intersectionObserver = null;
    }
  }

  /** Indicates whether the slideshow is nested inside another slideshow. */
  get isNested() {
    return this.parentElement?.closest('usf-slideshow-component') !== null;
  }

  get initialSlide() {
    return this.refs.slides?.[this.initialSlideIndex];
  }

  /**
   * Selects a slide based on the input index.
   * @param {number|string|{id: string}} input - The index or id of the slide to select.
   * @param {Event} [event] - The event that triggered the selection.
   * @param {Object} [options] - The options for the selection.
   * @param {boolean} [options.animate=true] - Whether to animate the selection.
   */
  async select(input, event, options = {}) {
    if (this.#disabled || !this.refs.slides?.length) return;
    if (!this.#scroll) return;

    // Store the actual current slide before any mutations
    const currentSlide = this.slides?.[this.current];

    for (const slide of this.refs.slides) {
      if (slide.hasAttribute('reveal')) {
        slide.removeAttribute('reveal');
        slide.setAttribute('aria-hidden', 'true');
      }
    }

    // Figure out the raw desired index (could be -1 if user is on first slide and clicks prev)
    let requestedIndex = (() => {
      if (typeof input === 'number') return input;
      if (typeof input === 'string') return parseInt(input, 10);
      if ('id' in input) {
        const requestedSlide = this.refs.slides.find((slide) => slide.getAttribute('slide-id') == input.id);

        if (!requestedSlide || !this.slides) return;

        // Force the slide to be revealed if it is hidden
        if (requestedSlide.hasAttribute('hidden')) {
          requestedSlide.setAttribute('reveal', '');
          requestedSlide.setAttribute('aria-hidden', 'false');
        }

        return this.slides.indexOf(requestedSlide);
      }
    })();

    const { current } = this;
    const { slides } = this;

    // Guard checks: no slides, invalid index, or selecting the same slide
    if (!slides?.length || requestedIndex === undefined || isNaN(requestedIndex)) return;

    const requestedSlideElement = slides?.[requestedIndex];
    if (currentSlide === requestedSlideElement) return;

    if (!this.infinite) requestedIndex = clamp(requestedIndex, 0, slides.length - 1);

    event?.preventDefault();

    const { animate = true } = options;
    const lastIndex = slides.length - 1;

    // Decide the actual target index (clamp for infinite loop)
    let index = requestedIndex;
    if (requestedIndex < 0) index = lastIndex;
    else if (requestedIndex > lastIndex) index = 0;

    const isAdjacentSlide = Math.abs(index - current) <= 1 && requestedIndex >= 0 && requestedIndex <= lastIndex;
    const { visibleSlides } = this;
    const instant = prefersReducedMotion() || !animate;

    // If jump is more than 1 or we looped, do the placeholder + reorder trick
    if (!instant && !isAdjacentSlide && visibleSlides.length === 1) {
      this.#disabled = true;
      await this.#scroll.finished; // ensure we're not mid-scroll

      const targetSlide = slides[index];
      if (!targetSlide || !currentSlide) return;

      // Create a placeholder in the original DOM position of targetSlide
      const placeholder = document.createElement('slideshow-slide');
      targetSlide.before(placeholder);

      // Decide whether targetSlide goes before or after currentSlide
      // so that we scroll a short distance in the correct direction
      if (requestedIndex < current) {
        currentSlide.before(targetSlide);
      } else {
        currentSlide.after(targetSlide);
      }

      if (current === 0) this.#scroll.to(currentSlide, { instant: true });

      // Once that scroll finishes, restore the DOM
      queueMicrotask(async () => {
        await this.#scroll.finished;
        this.#disabled = false;

        // Restore the slide back to its original position. This triggers a scroll event.
        placeholder.replaceWith(targetSlide);

        // Instantly scroll to the target slide as its position will have changed
        this.#scroll.to(targetSlide, { instant: true });
        // Force Safari to recalculate the timeline state on timeline refresh (after loop)
        requestAnimationFrame(() => {
          this.setAttribute('refreshing-timeline', '');
          requestAnimationFrame(() => {
            this.removeAttribute('refreshing-timeline');
          });
        });
      });
    }

    const slide = slides[index];
    if (!slide) return;

    const previousIndex = this.current;

    slide.setAttribute('aria-hidden', 'false');

    if (this.#scroll) {
      this.#scroll.to(slide, { instant });
    }

    this.current = this.slides?.indexOf(slide) || 0;

    this.#centerSelectedThumbnail(index, instant ? 'instant' : 'smooth');

    this.dispatchEvent(
      new SlideshowSelectEvent({
        index,
        previousIndex,
        userInitiated: event != null,
        trigger: 'select',
        slide,
        id: slide.getAttribute('slide-id'),
      })
    );
  }

  /**
   * Advances to the next slide.
   * @param {Event} [event] - The event that triggered the next slide.
   * @param {Object} [options] - The options for the next slide.
   * @param {boolean} [options.animate=true] - Whether to animate the next slide.
   */
  next(event, options) {
    event?.preventDefault();
    this.select(this.nextIndex, event, options);
  }

  /**
   * Goes back to the previous slide.
   * @param {Event} [event] - The event that triggered the previous slide.
   * @param {Object} [options] - The options for the previous slide.
   * @param {boolean} [options.animate=true] - Whether to animate the previous slide.
   */
  previous(event, options) {
    event?.preventDefault();
    this.select(this.previousIndex, event, options);
  }

  /**
   * Starts automatic slide playback.
   * @param {number} [interval] - The time interval in seconds between slides.
   */
  play(interval = this.autoplayInterval) {
    if (this.#interval) return;

    this.paused = false;

    this.#interval = setInterval(() => {
      if (this.matches(':hover') || document.hidden) return;

      this.next();
    }, interval);
  }

  /**
   * Pauses automatic slide playback.
   */
  pause() {
    this.paused = true;
    this.suspend();
  }

  get paused() {
    return this.hasAttribute('paused');
  }

  set paused(value) {
    if (value) {
      this.setAttribute('paused', '');
    } else {
      this.removeAttribute('paused');
    }
  }

  /**
   * Suspends automatic slide playback.
   */
  suspend() {
    clearInterval(this.#interval);
    this.#interval = undefined;
  }

  /**
   * Resumes automatic slide playback if autoplay is enabled.
   */
  resume() {
    if (!this.autoplay || this.paused) return;

    this.pause();
    this.play();
  }

  get autoplay() {
    return Boolean(this.autoplayInterval);
  }

  get autoplayInterval() {
    const interval = this.getAttribute('autoplay');
    const value = parseInt(`${interval}`, 10);

    if (Number.isNaN(value)) return undefined;

    return value * 1000;
  }

  /**
   * The current slide index.
   * @type {number}
   */
  #current = 0;

  get current() {
    return this.#current;
  }

  /**
   * Sets the current slide index and update the DOM
   * @type {number}
   */
  set current(value) {
    const { current, thumbnails, dots, slides, previous, next } = this.refs;

    this.#current = value;

    if (current) current.textContent = `${value + 1}`;

    for (const controls of [thumbnails, dots]) {
      controls?.forEach((el, i) => el.setAttribute('aria-selected', `${i === value}`));
    }

    if (previous) previous.disabled = Boolean(!this.infinite && value === 0);
    if (next) next.disabled = Boolean(!this.infinite && slides && this.nextIndex >= slides.length);
  }

  get infinite() {
    return this.getAttribute('infinite') != null;
  }

  get visibleSlides() {
    return this.#visibleSlides;
  }

  get previousIndex() {
    const { current, visibleSlides } = this;
    const modifier = visibleSlides.length > 1 ? visibleSlides.length : 1;

    return current - modifier;
  }

  get nextIndex() {
    const { current, visibleSlides } = this;
    const modifier = visibleSlides.length > 1 ? visibleSlides.length : 1;

    return current + modifier;
  }

  get atStart() {
    const { current, slides } = this;

    return slides?.length ? current === 0 : false;
  }

  get atEnd() {
    const { current, slides } = this;

    return slides?.length ? current === slides.length - 1 : false;
  }

  /**
   * Sets the disabled attribute.
   * @param {boolean} value - The value to set the disabled attribute to.
   */
  set disabled(value) {
    this.setAttribute('disabled', String(value));
  }
  /**
   * Whether the slideshow is disabled.
   * @type {boolean}
   */
  get disabled() {
    return (
      this.getAttribute('disabled') === 'true' || (this.hasAttribute('mobile-disabled') && !mediaQueryLarge.matches)
    );
  }

  /**
   * Indicates whether the slideshow is temporarily disabled (e.g., during infinite loop transition).
   * @type {boolean}
   */
  #disabled = false;

  /**
   * The interval ID for automatic playback.
   * @type {number|undefined}
   */
  #interval = undefined;

  /**
   * The Scroller instance that manages scrolling.
   * @type {Scroller}
   */
  #scroll;

  /**
   * The ResizeObserver instance for monitoring scroller size changes
   * @type {ResizeObserver}
   */
  #resizeObserver;

  /**
   * IntersectionObserver for efficient visibility tracking of slides
   * @type {IntersectionObserver | null}
   */
  #intersectionObserver = null;

  /**
   * Cached visible slides result from IntersectionObserver
   * @type {HTMLElement[]}
   */
  #visibleSlides = [];

  /**
   * Setup the slideshow without controls for zero or one slides
   */
  #setupSlideshowWithoutControls() {
    this.current = 0;
    if (this.hasAttribute('auto-hide-controls')) {
      const { slideshowControls } = this.refs;
      if (slideshowControls instanceof HTMLElement) {
        slideshowControls.hidden = true;
      }
    }

    if (this.refs.slides?.[0]) {
      this.refs.slides[0].setAttribute('aria-hidden', 'false');
    }
  }

  /**
   * Setup the slideshow with controls for when there are multiple slides
   */
  #setupSlideshow() {
    // Setup IntersectionObserver first for efficient visibility tracking
    this.#setupIntersectionObserver();

    // Setup the scroll instance
    const { scroller } = this.refs;
    this.#scroll = new Scroller(scroller, {
      onScroll: this.#handleScroll,
      onScrollStart: this.#onTransitionInit,
      onScrollEnd: this.#onTransitionEnd,
    });

    scroller.addEventListener('mousedown', this.#handleMouseDown);

    this.addEventListener('mouseenter', this.suspend);
    this.addEventListener('mouseleave', this.resume);
    this.addEventListener('pointerenter', this.#handlePointerEnter);
    document.addEventListener('visibilitychange', this.#handleVisibilityChange);

    this.#updateControlsVisibility();

    this.disabled = this.isNested || this.disabled;

    this.resume();

    this.current = this.initialSlideIndex;

    // Batch reads and writes to the DOM
    scheduler.schedule(() => {
      let visibleSlidesAmount = 0;
      const initialSlideId = this.initialSlide?.getAttribute('slide-id');

      // Wait for next frame to ensure layout is fully calculated before setting initial scroll position
      // This prevents race conditions on Safari mobile when section_width is 'full-width'
      requestAnimationFrame(() => {
        if (this.initialSlideIndex !== 0 && initialSlideId) {
          this.select({ id: initialSlideId }, undefined, { animate: false });
          visibleSlidesAmount = 1;
        } else {
          visibleSlidesAmount = this.#updateVisibleSlides();
          if (visibleSlidesAmount === 0) {
            this.select(0, undefined, { animate: false });
            visibleSlidesAmount = 1;
          }
        }
      });

      this.#resizeObserver = new ResizeObserver(async () => {
        if (viewTransition.current) await viewTransition.current;

        if (visibleSlidesAmount > 1) {
          this.#updateVisibleSlides();
        }

        if (this.hasAttribute('auto-hide-controls')) {
          this.#updateControlsVisibility();
        }
      });

      this.#resizeObserver.observe(this.refs.slideshowContainer);
    });
  }

  /**
   * Callback invoked on user initiated scroll to sync the current slide index
   * and emit a slide change event if the index has changed.
   */
  #handleScroll = () => {
    const previousIndex = this.#current;
    const index = this.#sync();

    if (index === previousIndex) return;

    const slide = this.slides?.[index];
    if (!slide) return;

    this.dispatchEvent(
      new SlideshowSelectEvent({
        index,
        previousIndex,
        userInitiated: true,
        trigger: 'scroll',
        slide,
        id: slide.getAttribute('slide-id'),
      })
    );
  };

  #onTransitionInit = () => {
    this.setAttribute('transitioning', '');
  };

  #onTransitionEnd = () => {
    this.#updateVisibleSlides();
    this.removeAttribute('transitioning');
  };

  /**
   * Synchronizes the scroll position and updates the current slide index.
   * @returns {number} The index of the current slide.
   */
  #sync = () => {
    const { slides } = this;
    if (!slides) return (this.current = 0);

    if (!this.#scroll) return (this.current = 0);

    const visibleSlides = this.visibleSlides;

    if (!visibleSlides.length) return this.current;

    const { axis } = this.#scroll;
    const { scroller } = this.refs;
    const centers = visibleSlides.map((slide) => center(slide, axis));
    const referencePoint = visibleSlides.length > 1 ? scroller.getBoundingClientRect()[axis] : center(scroller, axis);
    const closestCenter = closest(centers, referencePoint);
    const closestVisibleSlide = visibleSlides[centers.indexOf(closestCenter)];

    if (!closestVisibleSlide) return (this.current = 0);

    const index = slides.indexOf(closestVisibleSlide);

    return (this.current = index);
  };

  #dragging = false;

  /**
   * Handles the 'mousedown' event to start dragging slides.
   * @param {MouseEvent} event - The mousedown event.
   */
  #handleMouseDown = (event) => {
    const { slides } = this;

    if (!slides || slides.length <= 1) return;
    if (!(event.target instanceof Element)) return;
    if (this.disabled || this.#dragging) return;

    // Check if the event target is within a 3D model interactive element
    // This prevents the slideshow from capturing drag events when interacting with 3D models
    if (event.target.closest('model-viewer')) {
      return;
    }

    event.preventDefault();
    // Store initial position but don't start handling yet
    const { axis } = this.#scroll;
    const startPosition = event[axis];

    const controller = new AbortController();
    const { signal } = controller;
    const startTime = performance.now();
    let previous = startPosition;
    let velocity = 0;
    let moved = false;
    let distanceTravelled = 0;

    this.#dragging = true;

    /**
     * Handles the 'pointermove' event to update the scroll position.
     * @param {PointerEvent} event - The pointermove event.
     */
    const onPointerMove = (event) => {
      const current = event[axis];
      const initialDelta = startPosition - current;

      if (!initialDelta) return;

      if (!moved) {
        moved = true;
        this.setPointerCapture(event.pointerId);

        // Prevent clicks once the user starts dragging
        document.addEventListener('click', preventDefault, { once: true, signal });

        const movingRight = initialDelta < 0;
        const movingLeft = initialDelta > 0;

        // Check if the current slideshow should handle this drag
        const closestSlideshow = this.parentElement?.closest('usf-slideshow-component');
        const isNested = closestSlideshow instanceof UsfSlideshow && closestSlideshow !== this;
        const cannotMoveInDirection = (movingRight && this.atStart) || (movingLeft && this.atEnd);

        // Abort and let the parent slideshow handle the drag if we're moving in a direction where nested slideshow can't move
        if (isNested && cannotMoveInDirection) {
          controller.abort();
          return;
        }

        this.pause();
        this.setAttribute('dragging', '');
      }

      // Stop the event from bubbling up to parent slideshow components
      event.stopImmediatePropagation();

      const delta = previous - current;
      const timeDelta = performance.now() - startTime;
      velocity = Math.round((delta / timeDelta) * 1000);
      previous = current;
      distanceTravelled += Math.abs(delta);

      this.#scroll.by(delta, { instant: true });
    };

    /**
     * Handles the 'pointerup' event to stop dragging slides.
     * @param {PointerEvent} event - The pointerup event.
     */
    const onPointerUp = async (event) => {
      controller.abort();
      const { current, slides } = this;
      const { scroller } = this.refs;

      this.#dragging = false;

      if (!slides?.length || !scroller) return;

      const direction = Math.sign(velocity);
      const next = this.#sync();

      const modifier = current !== next || Math.abs(velocity) < 10 || distanceTravelled < 10 ? 0 : direction;
      const newIndex = clamp(next + modifier, 0, slides.length - 1);

      const newSlide = slides[newIndex];
      const currentIndex = this.current;

      if (!newSlide) throw new Error(`Slide not found at index ${newIndex}`);

      this.#scroll.to(newSlide);

      this.removeAttribute('dragging');
      this.releasePointerCapture(event.pointerId);

      this.#centerSelectedThumbnail(newIndex);

      this.dispatchEvent(
        new SlideshowSelectEvent({
          index: newIndex,
          previousIndex: currentIndex,
          userInitiated: true,
          trigger: 'drag',
          slide: newSlide,
          id: newSlide.getAttribute('slide-id'),
        })
      );

      this.current = newIndex;

      await this.#scroll.finished;

      // It's possible that the user started dragging again before the scroll finished
      if (this.#dragging) return;

      this.#scroll.snap = true;
      this.resume();
    };

    this.#scroll.snap = false;

    document.addEventListener('pointermove', onPointerMove, { signal });
    document.addEventListener('pointerup', onPointerUp, { signal });
    /**
     * pointerDown calls onPointerUp to fix an issue where the first tap-and-drag
     * on the zoom dialog is captured by the pointerMove/pointerUp listeners,
     * sometimes causing the slideshow to change slides unexpectedly
     */
    document.addEventListener('pointerdown', onPointerUp, { signal });
    document.addEventListener('pointercancel', onPointerUp, { signal });
    document.addEventListener('pointercapturelost', onPointerUp, { signal });
  };

  #handlePointerEnter = () => {
    this.setAttribute('actioned', '');
  };

  get slides() {
    return this.refs.slides?.filter((slide) => !slide.hasAttribute('hidden') || slide.hasAttribute('reveal'));
  }

  /**
   * The initial slide index.
   * @type {number}
   */
  get initialSlideIndex() {
    const initialSlide = this.getAttribute('initial-slide');
    if (initialSlide == null) return 0;

    return parseInt(initialSlide, 10);
  }

  /**
   * Pause the slideshow when the page is hidden.
   */
  #handleVisibilityChange = () => (document.hidden ? this.pause() : this.resume());

  #updateControlsVisibility() {
    if (!this.hasAttribute('auto-hide-controls')) return;

    const { scroller, slideshowControls } = this.refs;

    if (!(slideshowControls instanceof HTMLElement)) return;

    slideshowControls.hidden = scroller.scrollWidth <= scroller.offsetWidth;
  }

  /**
   * Setup IntersectionObserver for efficient visibility tracking of slides
   */
  #setupIntersectionObserver() {
    const { slides, scroller } = this.refs;
    if (!slides?.length) return;

    if (this.#intersectionObserver) {
      this.#intersectionObserver.disconnect();
    }

    this.#intersectionObserver = new IntersectionObserver(
      (entries) => {
        const allEntries = [
          ...entries,
          ...(this.#intersectionObserver ? this.#intersectionObserver.takeRecords() : []),
        ];

        for (const entry of allEntries) {
          const slide = /** @type {HTMLElement} */ (entry.target);
          const isCurrentlyVisible = this.#visibleSlides.includes(slide);
          const shouldBeVisible = entry.intersectionRatio >= SLIDE_VISIBLITY_THRESHOLD;

          if (shouldBeVisible && !isCurrentlyVisible) {
            this.#visibleSlides.push(slide);
          } else if (!shouldBeVisible && isCurrentlyVisible) {
            const index = this.#visibleSlides.indexOf(slide);
            if (index > -1) {
              this.#visibleSlides.splice(index, 1);
            }
          }
        }

        this.#visibleSlides.sort((a, b) => slides.indexOf(a) - slides.indexOf(b));
        this.#updateVisibleSlides();
      },
      {
        root: scroller,
        threshold: SLIDE_VISIBLITY_THRESHOLD,
        // Add small margin to account for sub-pixel rendering
        rootMargin: '1px',
      }
    );

    // Observe all slides - observer will fire initial callback asynchronously
    slides.forEach((slide) => {
      this.#intersectionObserver?.observe(slide);
    });
  }

  /**
   * Centers the selected thumbnail in the thumbnails container
   * @param {number} index - The index of the selected thumbnail
   * @param {ScrollBehavior} [behavior] - The scroll behavior.
   */
  #centerSelectedThumbnail(index, behavior = 'smooth') {
    const selectedThumbnail = this.refs.thumbnails?.[index];
    if (!selectedThumbnail) return;

    const { thumbnailsContainer } = this.refs;
    if (!thumbnailsContainer || !(thumbnailsContainer instanceof HTMLElement)) return;

    const { slideshowControls } = this.refs;
    if (!slideshowControls || !(slideshowControls instanceof HTMLElement)) return;

    scrollIntoView(selectedThumbnail, {
      ancestor: thumbnailsContainer,
      behavior,
      block: 'center',
      inline: 'center',
    });
  }

  #updateVisibleSlides() {
    const { slides } = this;
    if (!slides || !slides.length) return 0;

    const visibleSlides = this.visibleSlides;
        // If the IntersectionObserver reports zero visible slides, then the slideshow has intersected, but no slides meet the visibility threshold.
    // Probably that the slideshow's host is mid-animation or zero-layout, like in an animating modal.
    // Don't stamp aria-hidden="true" on every slide. Set the current slide to the first visible slide.
    if (visibleSlides.length === 0) return 0;

    // Batch writes to the DOM
    scheduler.schedule(() => {
      // Update aria-hidden based on visibility
      slides.forEach((slide) => {
        const isVisible = visibleSlides.includes(slide);
        slide.setAttribute('aria-hidden', `${!isVisible}`);
      });
    });

    return visibleSlides.length;
  }
}

if (!customElements.get('usf-slideshow-component')) {
  customElements.define('usf-slideshow-component', UsfSlideshow);
}


export class UsfQuickAddComponent extends Component {
  /** @type {AbortController | null} */
  #abortController = null;
  /** @type {Map<string, Element>} */
  #cachedContent = new Map();
  /** @type {AbortController} */
  #cartUpdateAbortController = new AbortController();

  get productPageUrl() {
    const productCard = /** @type {import('./usf-product-card').UsfProductCard | null} */ (this.closest('usf-product-card'));
    const hotspotProduct = /** @type {import('./product-hotspot').ProductHotspotComponent | null} */ (
      this.closest('product-hotspot-component')
    );
    const productLink = productCard?.getProductCardLink() || hotspotProduct?.getHotspotProductLink();

    if (!productLink?.href) return '';

    const url = new URL(productLink.href);

    if (url.searchParams.has('variant')) {
      return url.toString();
    }

    const selectedVariantId = this.#getSelectedVariantId();
    if (selectedVariantId) {
      url.searchParams.set('variant', selectedVariantId);
    }

    return url.toString();
  }

  /**
   * Gets the currently selected variant ID from the product card
   * @returns {string | null} The variant ID or null
   */
  #getSelectedVariantId() {
    const productCard = /** @type {import('./usf-product-card').UsfProductCard | null} */ (this.closest('usf-product-card'));
    return productCard?.getSelectedVariantId() || null;
  }

  connectedCallback() {
    requestAnimationFrame(() => this.initCard());
  }
  initCard(){
    super.connectedCallback();

    mediaQueryLarge.addEventListener('change', this.#closeQuickAddModal);
    document.addEventListener(ThemeEvents.cartUpdate, this.#handleCartUpdate, {
      signal: this.#cartUpdateAbortController.signal,
    });
    document.addEventListener(ThemeEvents.variantSelected, this.#updateQuickAddButtonState.bind(this));
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    mediaQueryLarge.removeEventListener('change', this.#closeQuickAddModal);
    this.#abortController?.abort();
    this.#cartUpdateAbortController.abort();
    document.removeEventListener(ThemeEvents.variantSelected, this.#updateQuickAddButtonState.bind(this));
  }

  /**
   * Clears the cached content when cart is updated
   */
  #handleCartUpdate = () => {
    this.#cachedContent.clear();
  };

  /**
   * Re-renders the variant picker in the quick-add modal.
   * @param {Element} newHtml - The element to re-render.
   */
  #updateVariantPicker(newHtml) {
    const modalContent = document.getElementById('quick-add-modal-content');
    if (!modalContent) return;
    const variantPicker = /** @type {VariantPicker} */ (modalContent.querySelector('variant-picker'));
    variantPicker.updateVariantPicker(newHtml);
  }

  /**
   * Handles quick add button click
   * @param {Event} event - The click event
   */
  handleClick = async (event) => {
    event.preventDefault();

    const currentUrl = this.productPageUrl;

    // Check if we have cached content for this URL
    let productGrid = this.#cachedContent.get(currentUrl);

    if (!productGrid) {
      // Fetch and cache the content
      const html = await this.fetchProductPage(currentUrl);
      if (html) {
        const gridElement = html.querySelector('[data-product-grid-content]');
        if (gridElement) {
          // Cache the cloned element to avoid modifying the original
          productGrid = /** @type {Element} */ (gridElement.cloneNode(true));
          this.#cachedContent.set(currentUrl, productGrid);
        }
      }
    }

    if (productGrid) {
      // Use a fresh clone from the cache
      const freshContent = /** @type {Element} */ (productGrid.cloneNode(true));
      await this.updateQuickAddModal(freshContent);
      this.#updateVariantPicker(productGrid);
    }

    this.#openQuickAddModal();
  };

  /** @param {QuickAddDialog} dialogComponent */
  #stayVisibleUntilDialogCloses(dialogComponent) {
    this.toggleAttribute('stay-visible', true);

    dialogComponent.addEventListener(DialogCloseEvent.eventName, () => this.toggleAttribute('stay-visible', false), {
      once: true,
    });
  }

  #openQuickAddModal = () => {
    const dialogComponent = document.getElementById('quick-add-dialog');
    //if (!(dialogComponent instanceof QuickAddDialog)) return;

    this.#stayVisibleUntilDialogCloses(dialogComponent);

    dialogComponent.showDialog();
  };

  #closeQuickAddModal = () => {
    const dialogComponent = document.getElementById('quick-add-dialog');
    //if (!(dialogComponent instanceof QuickAddDialog)) return;

    dialogComponent.closeDialog();
  };

  /**
   * Fetches the product page content
   * @param {string} productPageUrl - The URL of the product page to fetch
   * @returns {Promise<Document | null>}
   */
  async fetchProductPage(productPageUrl) {
    if (!productPageUrl) return null;

    // We use this to abort the previous fetch request if it's still pending.
    this.#abortController?.abort();
    this.#abortController = new AbortController();

    try {
      const response = await fetch(productPageUrl, {
        signal: this.#abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch product page: HTTP error ${response.status}`);
      }

      const responseText = await response.text();
      const html = new DOMParser().parseFromString(responseText, 'text/html');

      return html;
    } catch (error) {
      if (error.name === 'AbortError') {
        return null;
      } else {
        throw error;
      }
    } finally {
      this.#abortController = null;
    }
  }

  /**
   * Re-renders the variant picker.
   * @param {Element} productGrid - The product grid element
   */
  async updateQuickAddModal(productGrid) {
    const modalContent = document.getElementById('quick-add-modal-content');

    if (!productGrid || !modalContent) return;

    if (isMobileBreakpoint()) {
      const productDetails = productGrid.querySelector('.product-details');
      const productFormComponent = productGrid.querySelector('usf-product-form-component');
      const variantPicker = productGrid.querySelector('variant-picker');
      const productPrice = productGrid.querySelector('usf-product-price');
      const productTitle = document.createElement('a');
      productTitle.textContent = this.dataset.productTitle || '';

      // Make product title as a link to the product page
      productTitle.href = this.productPageUrl;

      const productHeader = document.createElement('div');
      productHeader.classList.add('product-header');

      productHeader.appendChild(productTitle);
      if (productPrice) {
        productHeader.appendChild(productPrice);
      }
      productGrid.appendChild(productHeader);

      if (variantPicker) {
        productGrid.appendChild(variantPicker);
      }
      if (productFormComponent) {
        productGrid.appendChild(productFormComponent);
      }

      productDetails?.remove();
    }

    morph(modalContent, productGrid);

    this.#syncVariantSelection(modalContent);
  }

  /**
   * Updates the quick-add button state based on whether a swatch is selected
   * @param {VariantSelectedEvent} event - The variant selected event
   */
  #updateQuickAddButtonState(event) {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest('usf-product-card') !== this.closest('usf-product-card')) return;
    const productOptionsCount = this.dataset.productOptionsCount;
    const quickAddButton = productOptionsCount === '1' ? 'add' : 'choose';
    this.setAttribute('data-quick-add-button', quickAddButton);
  }

  /**
   * Syncs the variant selection from the product card to the modal
   * @param {Element} modalContent - The modal content element
   */
  #syncVariantSelection(modalContent) {
    const selectedVariantId = this.#getSelectedVariantId();
    if (!selectedVariantId) return;

    // Find and check the corresponding input in the modal
    const modalInputs = modalContent.querySelectorAll('input[type="radio"][data-variant-id]');
    for (const input of modalInputs) {
      if (input instanceof HTMLInputElement && input.dataset.variantId === selectedVariantId && !input.checked) {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    }
  }
}

if (!customElements.get('usf-quick-add-component')) {
  customElements.define('usf-quick-add-component', UsfQuickAddComponent);
}




// Error message display duration - gives users time to read the message
const ERROR_MESSAGE_DISPLAY_DURATION = 10000;

// Button re-enable delay after error - prevents rapid repeat attempts
const ERROR_BUTTON_REENABLE_DELAY = 1000;

// Success message display duration for screen readers
const SUCCESS_MESSAGE_DISPLAY_DURATION = 5000;

/**
 * @typedef {HTMLElement & {
 *   source: Element,
 *   destination: Element,
 *   useSourceSize: string | boolean
 * }} FlyToCart
 */

/**
 * A custom element that manages an add to cart button.
 *
 * @typedef {object} AddToCartRefs
 * @property {HTMLButtonElement} addToCartButton - The add to cart button.
 * @extends Component<AddToCartRefs>
 */
export class UsfAddToCartComponent extends Component {
  requiredRefs = ['addToCartButton'];

  /** @type {number[] | undefined} */
  #resetTimeouts = /** @type {number[]} */ ([]);


  connectedCallback() {
    requestAnimationFrame(() => this.initCard());
  }
  initCard(){
    super.connectedCallback();

    this.addEventListener('pointerenter', this.#preloadImage);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    if (this.#resetTimeouts) {
      this.#resetTimeouts.forEach(/** @param {number} timeoutId */ (timeoutId) => clearTimeout(timeoutId));
    }
    this.removeEventListener('pointerenter', this.#preloadImage);
  }

  /**
   * Disables the add to cart button.
   */
  disable() {
    this.refs.addToCartButton.disabled = true;
  }

  /**
   * Enables the add to cart button.
   */
  enable() {
    this.refs.addToCartButton.disabled = false;
  }

  /**
   * Handles the click event for the add to cart button.
   * @param {MouseEvent & {target: HTMLElement}} event - The click event.
   */
  handleClick(event) {
    const form = this.closest('form');
    if (!form?.checkValidity()) return;

    // Check if adding would exceed max before animating
    const productForm = /** @type {ProductFormComponent | null} */ (this.closest('usf-product-form-component'));
    const quantitySelector = productForm?.refs.quantitySelector;
    if (quantitySelector?.canAddToCart) {
      const validation = quantitySelector.canAddToCart();
      // Don't animate if it would exceed max
      if (!validation.canAdd) {
        return;
      }
    }
    if (this.refs.addToCartButton.dataset.puppet !== 'true') {
      const animationEnabled = this.dataset.addToCartAnimation === 'true';
      if (animationEnabled && !event.target.closest('.quick-add-modal')) {
        this.#animateFlyToCart();
      }
      this.animateAddToCart();
    }
  }

  #preloadImage = () => {
    const image = this.dataset.productVariantMedia;

    if (!image) return;

    preloadImage(image);
  };

  /**
   * Animates the fly to cart animation.
   */
  #animateFlyToCart() {
    const { addToCartButton } = this.refs;
    const cartIcon = document.querySelector('.header-actions__cart-icon');

    const image = this.dataset.productVariantMedia;

    if (!cartIcon || !addToCartButton || !image) return;

    const flyToCartElement = /** @type {FlyToCart} */ (document.createElement('fly-to-cart'));

    let flyToCartClass = addToCartButton.classList.contains('quick-add__button')
      ? 'fly-to-cart--quick'
      : 'fly-to-cart--main';

    flyToCartElement.classList.add(flyToCartClass);
    flyToCartElement.style.setProperty('background-image', `url(${image})`);
    flyToCartElement.style.setProperty('--start-opacity', '0');
    flyToCartElement.source = addToCartButton;
    flyToCartElement.destination = cartIcon;

    document.body.appendChild(flyToCartElement);
  }

  /**
   * Animates the add to cart button.
   */
  animateAddToCart = async function () {
    const { addToCartButton } = this.refs;

    // Initialize the array if it doesn't exist
    if (!this.#resetTimeouts) {
      this.#resetTimeouts = [];
    }

    // Clear all existing timeouts
    this.#resetTimeouts.forEach(/** @param {number} timeoutId */ (timeoutId) => clearTimeout(timeoutId));
    this.#resetTimeouts = [];

    if (addToCartButton.dataset.added !== 'true') {
      addToCartButton.dataset.added = 'true';
    }

    // The onAnimationEnd can trigger a style recalculation so we yield to the main thread first.
    await yieldToMainThread();
    await onAnimationEnd(addToCartButton);

    // Create new timeout and store it in the array
    const timeoutId = setTimeout(() => {
      addToCartButton.removeAttribute('data-added');

      // Remove this timeout from the array
      const index = this.#resetTimeouts.indexOf(timeoutId);
      if (index > -1) {
        this.#resetTimeouts.splice(index, 1);
      }
    }, 800);

    this.#resetTimeouts.push(timeoutId);
  };
}

if (!customElements.get('usf-add-to-cart-component')) {
  customElements.define('usf-add-to-cart-component', UsfAddToCartComponent);
}

/**
 * A custom element that manages a product form.
 *
 * @typedef {{items: Array<{quantity: number, variant_id: number}>}} Cart
 *
 * @typedef {object} ProductFormRefs
 * @property {HTMLInputElement} variantId - The form input for submitting the variant ID.
 * @property {AddToCartComponent | undefined} addToCartButtonContainer - The add to cart button container element.
 * @property {HTMLElement | undefined} addToCartTextError - The add to cart text error.
 * @property {HTMLElement | undefined} acceleratedCheckoutButtonContainer - The accelerated checkout button container element.
 * @property {HTMLElement} liveRegion - The live region.
 * @property {HTMLElement | undefined} quantityLabelCartCount - The quantity label cart count element.
 * @property {HTMLElement | undefined} quantityRules - The quantity rules element.
 * @property {HTMLElement | undefined} productFormButtons - The product form buttons container.
 * @property {HTMLElement | undefined} volumePricing - The volume pricing component.
 * @property {any | undefined} quantitySelector - The quantity selector component.
 * @property {HTMLElement | undefined} quantitySelectorWrapper - The quantity selector wrapper element.
 * @property {HTMLElement | undefined} quantityLabel - The quantity label element.
 * @property {HTMLElement | undefined} pricePerItem - The price per item component.
 *
 * @extends Component<ProductFormRefs>
 */
class UsfProductFormComponent extends Component {
  requiredRefs = ['variantId', 'liveRegion'];
  #abortController = new AbortController();

  /** @type {number | undefined} */
  #timeout;
 

  /** @type {boolean} */
  #variantChangeInProgress = false;

  /** @type {number} */
  #variantChangeGeneration = 0;

  /**
   * Adds queued while a variant change is in flight. Each entry captures the selection state and
   * generation active when Add was clicked, then resolves that selection at drain time.
   * @type {QueuedAddToCartItem[]}
   */
  #addToCartQueue = [];

  /**
   * The in-flight variant-change section fetch promise. The queue drain awaits this before
   * reading the resolved variant id.
   * @type {Promise<unknown> | null}
   */
  #pendingVariantChange = null;
  connectedCallback() {
    requestAnimationFrame(() => this.initCard());
  }
  initCard(){
        super.connectedCallback();

    const { signal } = this.#abortController;
    const target = this.closest('.shopify-section, dialog, product-card');
    target?.addEventListener(StandardEvents.productSelect, this.#onProductSelect, { signal });

    // Listen for cart updates to sync data-cart-quantity
    document.addEventListener(StandardEvents.cartLinesUpdate, this.#onCartUpdate, { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.#abortController.abort();
  }

  #getVariantIdInput() {
    return /** @type {HTMLInputElement | null} */ (this.querySelector('input[name="id"]'))?.value;
  }

  async #refreshCart() {
    /** @type {import('@theme/component-cart-items').CartItemsComponent | null} */
    const cartItemsComponent = document.querySelector('cart-items-component');

    if (cartItemsComponent) {
      await customElements.whenDefined('cart-items-component');
      return cartItemsComponent.fetchCartData();
    }

    // Fallback for pages without cart-items-component (e.g. page-based cart on product pages)
    return fetch(`${Theme.routes.cart_url}.json`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    }).then((response) => {
      if (!response.ok) throw new Error(`Failed to fetch cart: ${response.status}`);
      return response.json();
    });
  }

  /**
   * Updates quantity selector with cart data for current variant
   * @param {Cart} cart - The cart object with items array
   */
  #updateCartQuantity(cart) {
    const variantIdInput = this.#getVariantIdInput();
    if (!variantIdInput) return;

    const cartItem = cart.items.find(
      /** @param {any} item */
      (item) => item.variant_id.toString() === variantIdInput.toString()
    );
    const cartQty = cartItem ? cartItem.quantity : 0;

    // Use public API to update quantity selector
    const quantitySelector =
      /** @type {import('@theme/component-cart-quantity-selector').CartQuantitySelectorComponent | null} */ (
        this.querySelector('quantity-selector-component')
      );

    if (quantitySelector?.setCartQuantity) {
      quantitySelector.setCartQuantity(cartQty);
    }

    // Update quantity label if it exists
    this.#updateQuantityLabel(cartQty);
  }

  /**
   * Updates data-cart-quantity when cart is updated from elsewhere
   * @param {CartLinesUpdateEvent} event
   */
  #onCartUpdate = async (event) => {
    if (!this.#getVariantIdInput()) return;

    event.promise
      ?.then(({ detail }) => {
        // Skip if this event came from this component
        if (detail?.sourceId === this.id || detail?.source === 'product-form-component') return;

        if (detail?.items) {
          this.#updateCartQuantity(/** @type {Cart} */ ({ items: detail.items }));
        } else {
          this.#refreshCart().then((cart) => this.#updateCartQuantity(cart));
        }
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[product-form] Event promise rejected:', error);
      });
  };

  /** @param {Event} event */
  handleSubmit(event) {
    event.preventDefault();

    if (this.#variantChangeInProgress) {
      this.#addToCartQueue.push(this.#createQueuedAddToCartItem());
      this.refs.addToCartButtonContainer?.animateAddToCart?.();
      return;
    }

    this.#processAddToCart(undefined, undefined, event);
  }

  /** @returns {number} */
  #getQuantity() {
    return Number(this.refs.quantitySelector?.getValue?.()) || Number(this.dataset.quantityDefault) || 1;
  }

  /** @returns {QueuedAddToCartItem} */
  #createQueuedAddToCartItem() {
    const picker = this.#getVariantPicker();
    const selectedOption = picker?.selectedOption;

    return {
      quantity: this.#getQuantity(),
      generation: this.#variantChangeGeneration,
      intendedVariantId: selectedOption?.dataset.variantId ?? null,
      pendingVariantChange: this.#pendingVariantChange,
      variantResolutionUrl: picker && selectedOption ? picker.buildRequestUrl(selectedOption) : null,
    };
  }

  /**
   * @param {string} [overrideVariantId]
   * @param {number} [overrideQuantity]
   * @param {Event} [event]
   */
  #processAddToCart(overrideVariantId, overrideQuantity, event) {
    const { addToCartTextError } = this.refs;

    if (this.#timeout) clearTimeout(this.#timeout);

    const allAddToCartContainers = /** @type {NodeListOf<AddToCartComponent>} */ (
      this.querySelectorAll('add-to-cart-component')
    );

    if (!overrideVariantId) {
      const anyButtonDisabled = Array.from(allAddToCartContainers).some(
        (container) => container.refs.addToCartButton?.disabled
      );
      if (anyButtonDisabled) return;
    }

    const form = this.querySelector('form');
    if (!form) throw new Error('Product form element missing');

    if (!overrideVariantId && this.refs.quantitySelector?.canAddToCart) {
      const validation = this.refs.quantitySelector.canAddToCart();

      if (!validation.canAdd) {
        for (const container of allAddToCartContainers) {
          container.disable();
        }

        const errorTemplate = this.dataset.quantityErrorMax || '';
        const errorMessage = errorTemplate.replace('{{ maximum }}', validation.maxQuantity?.toString() || '');
        if (addToCartTextError) {
          addToCartTextError.classList.remove('hidden');

          const textNode = addToCartTextError.childNodes[2];
          if (textNode) {
            textNode.textContent = errorMessage;
          } else {
            const newTextNode = document.createTextNode(errorMessage);
            addToCartTextError.appendChild(newTextNode);
          }

          this.#setLiveRegionText(errorMessage);

          if (this.#timeout) clearTimeout(this.#timeout);
          this.#timeout = setTimeout(() => {
            if (!addToCartTextError) return;
            addToCartTextError.classList.add('hidden');
            this.#clearLiveRegionText();
          }, ERROR_MESSAGE_DISPLAY_DURATION);
        }

        setTimeout(() => {
          for (const container of allAddToCartContainers) {
            container.enable();
          }
        }, ERROR_BUTTON_REENABLE_DELAY);

        return;
      }
    }

    const formData = new FormData(form);

    if (overrideVariantId) {
      formData.set('id', overrideVariantId);
    }
    if (overrideQuantity !== undefined) {
      formData.set('quantity', overrideQuantity.toString());
    }

    const cartItemsComponents = document.querySelectorAll('cart-items-component');
    let cartItemComponentsSectionIds = [];
    cartItemsComponents.forEach((item) => {
      if (item instanceof HTMLElement && item.dataset.sectionId) {
        cartItemComponentsSectionIds.push(item.dataset.sectionId);
      }
      formData.append('sections', cartItemComponentsSectionIds.join(','));
    });

    const itemCount = Number(formData.get('quantity')) || Number(this.dataset.quantityDefault);
    const deferredEventPromise = CartLinesUpdateEvent.createPromise();

    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: [
          {
            merchandiseId: /** @type {string} */ (formData.get('id')),
            quantity: itemCount,
          },
        ],
        promise: deferredEventPromise.promise,
      })
    );

    const fetchCfg = fetchConfig('javascript', { body: formData });

    fetch(Theme.routes.cart_add_url, {
      ...fetchCfg,
      headers: {
        ...fetchCfg.headers,
        Accept: 'text/html',
      },
    })
      .then((response) => response.json())
      .then(async (response) => {
        if (response.status) {
          this.dispatchEvent(
            new CartErrorEvent({
              error: response.message || 'Add to cart failed',
              code: 'INVALID',
              detail: {
                description: response.description,
                errors: response.errors,
              },
            })
          );

          // Fetch the updated cart to get the actual total quantity for this variant
          this.#refreshCart()
            .then((ajaxCart) =>
              deferredEventPromise.resolve({
                cart: CartLinesUpdateEvent.createCartFromAjaxResponse(ajaxCart),
                detail: {
                  didError: true,
                  items: ajaxCart.items,
                  source: 'product-form-component',
                  sourceId: this.id.toString(),
                  itemCount,
                  productId: this.dataset.productId,
                },
              })
            )
            .catch(deferredEventPromise.reject);

          if (!addToCartTextError) return;
          addToCartTextError.classList.remove('hidden');

          // Reuse the text node if the user is spam-clicking
          const textNode = addToCartTextError.childNodes[2];
          if (textNode) {
            textNode.textContent = response.message;
          } else {
            const newTextNode = document.createTextNode(response.message);
            addToCartTextError.appendChild(newTextNode);
          }

          // Create or get existing error live region for screen readers
          this.#setLiveRegionText(response.message);

          this.#timeout = setTimeout(() => {
            if (!addToCartTextError) return;
            addToCartTextError.classList.add('hidden');

            // Clear the announcement
            this.#clearLiveRegionText();
          }, ERROR_MESSAGE_DISPLAY_DURATION);

          return;
        } else {
          const id = formData.get('id');

          if (addToCartTextError) {
            addToCartTextError.classList.add('hidden');
            addToCartTextError.removeAttribute('aria-live');
          }

          if (!id) throw new Error('Form ID is required');

          // Add aria-live region to inform screen readers that the item was added
          // Get the added text from any add-to-cart button
          const anyAddToCartButton = allAddToCartContainers[0]?.refs.addToCartButton;
          if (anyAddToCartButton) {
            const addedTextElement = anyAddToCartButton.querySelector('.add-to-cart-text--added');
            const addedText = addedTextElement?.textContent?.trim() || Theme.translations.added;

            this.#setLiveRegionText(addedText);

            setTimeout(() => {
              this.#clearLiveRegionText();
            }, SUCCESS_MESSAGE_DISPLAY_DURATION);
          }

          // Fetch the updated cart to get the actual total quantity for this variant
          const cart = await this.#refreshCart()
            .then((ajaxCart) => {
              deferredEventPromise.resolve({
                cart: CartLinesUpdateEvent.createCartFromAjaxResponse(ajaxCart),
                detail: {
                  items: ajaxCart.items,
                  source: 'product-form-component',
                  sourceId: this.id.toString(),
                  itemCount,
                  productId: this.dataset.productId,
                  sections: response.sections,
                  didError: false,
                },
              });

              if (this.#getVariantIdInput()) {
                this.#updateCartQuantity(ajaxCart);
              }

              return ajaxCart;
            })
            .catch(deferredEventPromise.reject);
        }
      })
      .catch((error) => {
        console.error(error);
        deferredEventPromise.reject(error);

        this.dispatchEvent(
          new CartErrorEvent({
            error: error?.message || 'Network error during add to cart',
            code: 'SERVICE_UNAVAILABLE',
          })
        );
      })
      .finally(() => {
        if (event) {
          cartPerformance.measureFromEvent('add:user-action', event);
        }
      });
  }

  /** @param {Array<{variantId: string, quantity: number}>} items */
  #processBatchAddToCart(items) {
    if (items.length === 0) return;

    const { addToCartTextError } = this.refs;

    if (this.#timeout) clearTimeout(this.#timeout);

    const cartItemsComponents = document.querySelectorAll('cart-items-component');
    const cartItemComponentsSectionIds = [];
    for (const item of cartItemsComponents) {
      if (item instanceof HTMLElement && item.dataset.sectionId) {
        cartItemComponentsSectionIds.push(item.dataset.sectionId);
      }
    }

    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const deferredEventPromise = CartLinesUpdateEvent.createPromise();

    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: items.map((item) => ({
          merchandiseId: item.variantId,
          quantity: item.quantity,
        })),
        promise: deferredEventPromise.promise,
      })
    );

    const payload = {
      items: items.map((item) => ({
        id: Number(item.variantId),
        quantity: item.quantity,
      })),
      sections: cartItemComponentsSectionIds.join(','),
    };

    fetch(Theme.routes.cart_add_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    })
      .then((response) => response.json())
      .then(async (response) => {
        if (response.status) {
          this.dispatchEvent(
            new CartErrorEvent({
              error: response.message || 'Add to cart failed',
              code: 'INVALID',
              detail: {
                description: response.description,
                errors: response.errors,
              },
            })
          );

          this.#refreshCart()
            .then((ajaxCart) =>
              deferredEventPromise.resolve({
                cart: CartLinesUpdateEvent.createCartFromAjaxResponse(ajaxCart),
                detail: {
                  didError: true,
                  items: ajaxCart.items,
                  source: 'product-form-component',
                  sourceId: this.id.toString(),
                  itemCount: totalQuantity,
                  productId: this.dataset.productId,
                },
              })
            )
            .catch(deferredEventPromise.reject);

          if (!addToCartTextError) return;
          addToCartTextError.classList.remove('hidden');
          const textNode = addToCartTextError.childNodes[2];
          if (textNode) {
            textNode.textContent = response.message;
          } else {
            addToCartTextError.appendChild(document.createTextNode(response.message));
          }
          this.#setLiveRegionText(response.message);

          this.#timeout = setTimeout(() => {
            addToCartTextError.classList.add('hidden');
            this.#clearLiveRegionText();
          }, ERROR_MESSAGE_DISPLAY_DURATION);

          return;
        }

        if (addToCartTextError) {
          addToCartTextError.classList.add('hidden');
          addToCartTextError.removeAttribute('aria-live');
        }

        const allAddToCartContainers = /** @type {NodeListOf<AddToCartComponent>} */ (
          this.querySelectorAll('add-to-cart-component')
        );
        const anyAddToCartButton = allAddToCartContainers[0]?.refs.addToCartButton;
        if (anyAddToCartButton) {
          const addedTextElement = anyAddToCartButton.querySelector('.add-to-cart-text--added');
          const addedText = addedTextElement?.textContent?.trim() || Theme.translations.added;
          this.#setLiveRegionText(addedText);
          setTimeout(() => this.#clearLiveRegionText(), SUCCESS_MESSAGE_DISPLAY_DURATION);
        }

        const cart = await this.#refreshCart();
        deferredEventPromise.resolve({
          cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
          detail: {
            items: cart.items,
            source: 'product-form-component',
            sourceId: this.id.toString(),
            itemCount: totalQuantity,
            productId: this.dataset.productId,
            sections: response.sections,
            didError: false,
          },
        });
        this.#updateCartQuantity(cart);
      })
      .catch((error) => {
        console.error(error);
        deferredEventPromise.reject(error);

        this.dispatchEvent(
          new CartErrorEvent({
            error: error?.message || 'Network error during add to cart',
            code: 'SERVICE_UNAVAILABLE',
          })
        );
      });
  }

  /**
   * Updates the quantity label with the current cart quantity
   * @param {number} cartQty - The quantity in cart
   */
  #updateQuantityLabel(cartQty) {
    const quantityLabel = this.refs.quantityLabelCartCount;
    if (quantityLabel) {
      const inCartText = quantityLabel.textContent?.match(/\((\d+)\s+(.+)\)/);
      if (inCartText && inCartText[2]) {
        quantityLabel.textContent = `(${cartQty} ${inCartText[2]})`;
      }

      // Show/hide based on quantity
      quantityLabel.classList.toggle('hidden', cartQty === 0);
    }
  }

  /**
   * @param {*} text
   */
  #setLiveRegionText(text) {
    const liveRegion = this.refs.liveRegion;
    liveRegion.textContent = text;
  }

  #clearLiveRegionText() {
    const liveRegion = this.refs.liveRegion;
    liveRegion.textContent = '';
  }

  /**
   * Morphs or removes/adds an element based on current and new element states
   * @param {Element | null | undefined} currentElement - The current element in the DOM
   * @param {Element | null | undefined} newElement - The new element from the server response
   * @param {Element | null} [insertReferenceElement] - Element to insert before if adding new element
   */
  #morphOrUpdateElement(currentElement, newElement, insertReferenceElement = null) {
    if (currentElement && newElement) {
      morph(currentElement, newElement);
    } else if (currentElement && !newElement) {
      currentElement.remove();
    } else if (!currentElement && newElement && insertReferenceElement) {
      insertReferenceElement.insertAdjacentElement('beforebegin', /** @type {Element} */ (newElement.cloneNode(true)));
    }
  }

  /**
   * @param {ProductSelectEvent} event
   */
  #onProductSelect = async (event) => {
    // Skip events from product-cards when this form is at the section level
    const sourceCard = /** @type {Element | null} */ (event.target)?.closest('product-card');
    if (sourceCard && !sourceCard.contains(this)) return;

    // Track generation to prevent a stale (aborted) call from clearing the flag
    // while a newer variant selection is still pending.
    const generation = ++this.#variantChangeGeneration;
    this.#variantChangeInProgress = true;
    // Hold the in-flight section-fetch promise so the queue drain can await it before reading the
    // resolved variant id.
    this.#pendingVariantChange = event.promise;

    try {
      const { detail } = await event.promise;
      if (!detail?.html) return;

      const { html, newProduct, productId, resource } = detail;

      // Update product context if new product loaded (combined listing)
      if (newProduct) {
        this.dataset.productId = newProduct.id;
      } else if (productId && productId !== this.dataset.productId) {
        return;
      }

      const { variantId } = this.refs;
      variantId.value = resource?.id ?? '';

      const { addToCartButtonContainer: currentAddToCartButtonContainer, acceleratedCheckoutButtonContainer } =
        this.refs;
      const currentAddToCartButton = currentAddToCartButtonContainer?.refs.addToCartButton;

      // Update state and text for add-to-cart button
      if (!currentAddToCartButtonContainer || (!currentAddToCartButton && !acceleratedCheckoutButtonContainer)) return;

      // Update the button state
      if (resource == null || resource.available == false) {
        currentAddToCartButtonContainer.disable();
      } else {
        currentAddToCartButtonContainer.enable();
      }

      const newAddToCartButton = html.querySelector('product-form-component [ref="addToCartButton"]');
      if (newAddToCartButton && currentAddToCartButton) {
        morph(currentAddToCartButton, newAddToCartButton);
      }

      if (acceleratedCheckoutButtonContainer) {
        if (resource == null || resource.available == false) {
          acceleratedCheckoutButtonContainer?.setAttribute('hidden', 'true');
        } else {
          acceleratedCheckoutButtonContainer?.removeAttribute('hidden');
        }
      }

      // Set the data attribute for the product variant media if it exists
      if (resource) {
        const productVariantMedia = resource.featured_media?.preview_image?.src;
        if (productVariantMedia) {
          this.refs.addToCartButtonContainer?.setAttribute(
            'data-product-variant-media',
            productVariantMedia + '&width=100'
          );
        }
      }

      // Check if quantity rules, price-per-item, or add-to-cart are appearing/disappearing (causes layout shift)
      const {
        quantityRules,
        pricePerItem,
        quantitySelector,
        productFormButtons,
        quantityLabel,
        quantitySelectorWrapper,
      } = this.refs;

      // Update quantity selector's min/max/step attributes and cart quantity for the new variant
      const newQuantityInput = /** @type {HTMLInputElement | null} */ (
        html.querySelector('quantity-selector-component input[ref="quantityInput"]')
      );

      if (quantitySelector?.updateConstraints && newQuantityInput) {
        quantitySelector.updateConstraints(newQuantityInput.min, newQuantityInput.max || null, newQuantityInput.step);
        // Keep data-quantity-default attribute in sync with new variant's minimum quantity
        this.dataset.quantityDefault = newQuantityInput.min || '1';
      }

      const newQuantityRules = html.querySelector('.quantity-rules');
      const isQuantityRulesChanging = !!quantityRules !== !!newQuantityRules;

      const newPricePerItem = html.querySelector('price-per-item');
      const isPricePerItemChanging = !!pricePerItem !== !!newPricePerItem;

      if ((isQuantityRulesChanging || isPricePerItemChanging) && quantitySelector) {
        // Store quantity value before morphing entire container
        const currentQuantityValue = quantitySelector.getValue?.();

        const newProductFormButtons = html.querySelector('.product-form-buttons');

        if (productFormButtons && newProductFormButtons) {
          morph(productFormButtons, newProductFormButtons);

          // Get the NEW quantity selector after morphing and update its constraints
          const newQuantityInputElement = /** @type {HTMLInputElement | null} */ (
            html.querySelector('quantity-selector-component input[ref="quantityInput"]')
          );

          if (this.refs.quantitySelector?.updateConstraints && newQuantityInputElement && currentQuantityValue) {
            // Temporarily set the old value so updateConstraints can snap it properly
            this.refs.quantitySelector.setValue(currentQuantityValue);
            // updateConstraints will snap to valid increment if needed
            this.refs.quantitySelector.updateConstraints(
              newQuantityInputElement.min,
              newQuantityInputElement.max || null,
              newQuantityInputElement.step
            );
            // Keep data-quantity-default attribute in sync with new variant's minimum quantity
            this.dataset.quantityDefault = newQuantityInputElement.min || '1';
          }
        }
      } else {
        // Update elements individually when layout isn't changing
        /** @type {Array<[string, HTMLElement | undefined, HTMLElement | undefined]>} */
        const morphTargets = [
          ['.quantity-label', quantityLabel, quantitySelector],
          ['.quantity-rules', quantityRules, this.refs.productFormButtons],
          ['price-per-item', pricePerItem, quantitySelectorWrapper],
        ];

        for (const [selector, currentElement, fallback] of morphTargets) {
          this.#morphOrUpdateElement(currentElement, html.querySelector(selector), fallback);
        }
      }

      // Morph volume pricing if it exists
      const currentVolumePricing = this.refs.volumePricing;
      const newVolumePricing = html.querySelector('volume-pricing');
      this.#morphOrUpdateElement(currentVolumePricing, newVolumePricing, this.refs.productFormButtons);

      const hasB2BFeatures =
        quantityRules ||
        newQuantityRules ||
        pricePerItem ||
        newPricePerItem ||
        currentVolumePricing ||
        newVolumePricing;

      if (!hasB2BFeatures) return;

      // Fetch and update cart quantity for the new variant
      this.#refreshCart().then((cart) => this.#updateCartQuantity(cart));
    } finally {
      // Only clear the flag if no newer variant selection has started
      if (generation === this.#variantChangeGeneration) {
        this.#variantChangeInProgress = false;

        // Drain any queued add-to-cart requests that accumulated during the variant change
        await this.#drainAddToCartQueue();
      }
    }
  };

  /**
   * Drains the add-to-cart queue accumulated while a variant change was in flight.
   *
   * Each queued add resolves against the selection and generation that were active when Add was
   * clicked. If no variant resolves, that queued add is aborted so a stale, empty, or maxed
   * variant id is never sent. The add-to-cart button is already disabled for unavailable
   * selections in #onProductSelect, so no further UI change is needed.
   */
  async #drainAddToCartQueue() {
    if (this.#addToCartQueue.length === 0) return;

    const queuedItems = [...this.#addToCartQueue];
    this.#addToCartQueue = [];

    /** @type {Array<{variantId: string, quantity: number}>} */
    const resolvedItems = [];
    for (const item of queuedItems) {
      const resolvedItem = await this.#resolveQueuedAddToCartItem(item);
      if (resolvedItem) {
        resolvedItems.push(resolvedItem);
      }
    }

    this.#processBatchAddToCart(resolvedItems);
  }

  /**
   * @param {QueuedAddToCartItem} item
   * @returns {Promise<{variantId: string, quantity: number} | null>}
   */
  async #resolveQueuedAddToCartItem(item) {
    const { variantId, quantityConstraints } = await this.#resolveQueuedVariant(item);
    if (!variantId) return null;

    return {
      variantId,
      quantity: this.#normalizeQueuedQuantity(item.quantity, quantityConstraints),
    };
  }

  /**
   * @param {QueuedAddToCartItem} item
   * @returns {Promise<{variantId: string | null, quantityConstraints: QuantityConstraints | null}>}
   */
  async #resolveQueuedVariant(item) {
    /** @type {string | null} */
    let resolvedVariantId = null;
    /** @type {boolean | undefined} */
    let available;
    /** @type {QuantityConstraints | null} */
    let quantityConstraints = null;

    if (item.pendingVariantChange) {
      try {
        const result = /** @type {{detail?: {resource?: any, html?: Document | Element}}} */ (
          await item.pendingVariantChange
        );
        const resource = result?.detail?.resource;
        quantityConstraints = this.#getQuantityConstraintsFromHtml(result?.detail?.html);
        if (resource === null) {
          available = false;
        } else if (resource) {
          resolvedVariantId = resource.id != null ? String(resource.id) : null;
          available = resource.available !== false;
        }
      } catch {
        const resolvedVariant = await this.#resolveVariantFromUrl(item.variantResolutionUrl).catch(() => ({
          variantId: null,
          available: false,
          quantityConstraints: null,
        }));
        resolvedVariantId = resolvedVariant.variantId;
        available = resolvedVariant.available;
        quantityConstraints = resolvedVariant.quantityConstraints;
      }
    }

    const isLatestGeneration = item.generation === this.#variantChangeGeneration;
    const variantId = resolveVariantId({
      resolvedVariantId,
      intendedVariantId: item.intendedVariantId,
      hiddenInputValue: isLatestGeneration ? this.#getVariantIdInput() ?? null : null,
      available: available ?? (isLatestGeneration ? !this.#isAddToCartDisabled() : undefined),
    });

    return { variantId, quantityConstraints };
  }

  /**
   * @param {number} quantity
   * @param {QuantityConstraints | null} quantityConstraints
   * @returns {number}
   */
  #normalizeQueuedQuantity(quantity, quantityConstraints) {
    if (!quantityConstraints) return quantity;

    const min = parseIntOrDefault(quantityConstraints.min, 1);
    const max = parseIntOrDefault(quantityConstraints.max, null);
    const step = parseIntOrDefault(quantityConstraints.step, 1);
    const cartQuantity = parseIntOrDefault(quantityConstraints.cartQuantity, 0);
    const effectiveMax = max === null ? null : Math.max(max - cartQuantity, min);

    let normalizedQuantity = quantity;
    if ((quantity - min) % step !== 0) {
      normalizedQuantity = min + Math.floor((quantity - min) / step) * step;
    }

    return Math.max(min, Math.min(effectiveMax ?? Infinity, normalizedQuantity));
  }

  /**
   * @param {Document | Element | null | undefined} html
   * @returns {QuantityConstraints | null}
   */
  #getQuantityConstraintsFromHtml(html) {
    const quantityInput = /** @type {HTMLInputElement | null} */ (
      html?.querySelector?.('quantity-selector-component input[ref="quantityInput"]') ?? null
    );
    if (!quantityInput) return null;

    return {
      min: quantityInput.min,
      max: quantityInput.max || null,
      step: quantityInput.step,
      cartQuantity: quantityInput.getAttribute('data-cart-quantity'),
    };
  }

  /**
   * Resolves a queued selection using the server-side section renderer when the original in-flight
   * request was aborted by a later variant selection.
   * @param {string | null} variantResolutionUrl
   * @returns {Promise<{variantId: string | null, available: boolean | undefined, quantityConstraints: QuantityConstraints | null}>}
   */
  async #resolveVariantFromUrl(variantResolutionUrl) {
    if (!variantResolutionUrl) return { variantId: null, available: undefined, quantityConstraints: null };

    const response = await fetch(variantResolutionUrl, { credentials: 'same-origin' });
    if (!response.ok) return { variantId: null, available: false, quantityConstraints: null };

    const html = new DOMParser().parseFromString(await response.text(), 'text/html');
    const quantityConstraints = this.#getQuantityConstraintsFromHtml(html);
    const textContent = html.querySelector('variant-picker script[type="application/json"]')?.textContent;
    if (!textContent) return { variantId: null, available: false, quantityConstraints };

    const resource = JSON.parse(textContent);
    if (!resource || typeof resource !== 'object') return { variantId: null, available: false, quantityConstraints };

    return {
      variantId: resource.id != null ? String(resource.id) : null,
      available: resource.available !== false,
      quantityConstraints,
    };
  }

  /**
   * @returns {import('@theme/variant-picker').default | null}
   */
  #getVariantPicker() {
    const container = this.closest('product-card') ?? this.closest('dialog') ?? this.closest('.shopify-section');
    const pickers = /** @type {import('@theme/variant-picker').default[]} */ (
      Array.from(container?.querySelectorAll('variant-picker, swatches-variant-picker-component') ?? [])
    );
    const productId = this.dataset.productId;

    if (productId) {
      const matchingPicker = pickers.find((picker) => picker.dataset.productId === productId);
      if (matchingPicker) return matchingPicker;
    }

    return pickers.length === 1 ? pickers[0] ?? null : null;
  }

  /**
   * Whether the current selection's add-to-cart button is disabled (unavailable selection).
   * @returns {boolean}
   */
  #isAddToCartDisabled() {
    const containers = /** @type {NodeListOf<AddToCartComponent>} */ (this.querySelectorAll('add-to-cart-component'));
    return Array.from(containers).some((container) => container.refs.addToCartButton?.disabled);
  }
}

if (!customElements.get('usf-product-form-component')) {
  customElements.define('usf-product-form-component', UsfProductFormComponent);
}




class UsfProductPrice extends HTMLElement {

   connectedCallback() {
    requestAnimationFrame(() => this.initCard());
  }
  initCard(){
    const closestSection = this.closest('.shopify-section, dialog');
    if (!closestSection) return;
    closestSection.addEventListener(ThemeEvents.variantUpdate, this.updatePrice);
  }

  disconnectedCallback() {
    const closestSection = this.closest('.shopify-section, dialog');
    if (!closestSection) return;
    closestSection.removeEventListener(ThemeEvents.variantUpdate, this.updatePrice);
  }

  /**
   * Updates the price and volume pricing note.
   * @param {VariantUpdateEvent} event - The variant update event.
   */
  updatePrice = (event) => {
    if (event.detail.data.newProduct) {
      this.dataset.productId = event.detail.data.newProduct.id;
    } else if (event.target instanceof HTMLElement && event.target.dataset.productId !== this.dataset.productId) {
      return;
    }

    // Find the new product-price element in the updated HTML
    const newProductPrice = event.detail.data.html.querySelector(`usf-product-price[data-block-id="${this.dataset.blockId}"]`);
    if (!newProductPrice) return;

    // Update price container
    const newPrice = newProductPrice.querySelector('[usf-ref="priceContainer"]');
    const currentPrice = this.querySelector('[usf-ref="priceContainer"]');
    if (newPrice && currentPrice) currentPrice.replaceWith(newPrice);

    // Update volume pricing note
    const currentNote = this.querySelector('.volume-pricing-note');
    const newNote = newProductPrice.querySelector('.volume-pricing-note');

    if (!newNote) {
      currentNote?.remove();
    } else if (!currentNote) {
      this.querySelector('[usf-ref="priceContainer"]')?.insertAdjacentElement('afterend', /** @type {Element} */ (newNote.cloneNode(true)));
    } else {
      currentNote.replaceWith(newNote);
    }
  };
}

if (!customElements.get('usf-product-price')) {
  customElements.define('usf-product-price', UsfProductPrice);
}

class UsfProductSkuComponent extends Component {
  requiredRefs = ['skuContainer', 'sku'];

  connectedCallback() {
    requestAnimationFrame(() => this.initCard());
  }
  initCard(){
    super.connectedCallback();
    const target = this.closest('[id*="ProductInformation-"], [id*="QuickAdd-"], usf-product-card');
    if (!target) return;
    target.addEventListener(ThemeEvents.variantUpdate, this.updateSku);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    const target = this.closest('[id*="ProductInformation-"], [id*="QuickAdd-"], usf-product-card');
    if (!target) return;
    target.removeEventListener(ThemeEvents.variantUpdate, this.updateSku);
  }

  /**
   * Updates the SKU.
   * @param {VariantUpdateEvent} event - The variant update event.
   */
  updateSku = (event) => {
    if (event.detail.data.newProduct) {
      this.dataset.productId = event.detail.data.newProduct.id;
    }

    if (event.target instanceof HTMLElement && event.target.dataset.productId !== this.dataset.productId) {
      return;
    }

    // Use the variant data from the event
    // The variant is in event.detail.resource
    if (event.detail.resource) {
      const variantSku = event.detail.resource.sku || '';

      if (variantSku) {
        // Show the component and update the SKU
        this.style.display = 'block';
        this.refs.sku.textContent = variantSku;
      } else {
        // Hide the entire component when SKU is empty
        this.style.display = 'none';
        this.refs.sku.textContent = '';
      }
    }
  };
}

if (!customElements.get('usf-product-sku-component')) {
  customElements.define('usf-product-sku-component', UsfProductSkuComponent);
}
