import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IconButton, Tooltip, panelTabStep } from './ui';

describe('icon button tooltip', () => {
  // The bell and the ⋯ menu switch their tooltip off while open. A different
  // root element for "no tooltip" made React remount the focused button, and
  // focus fell to <body> (review 2026-10-17).
  const markup = (tooltip?: string | false) =>
    renderToStaticMarkup(createElement(IconButton, { label: 'More actions', icon: null, tooltip }));

  it('renders the same element tree with the tooltip on, off or defaulted', () => {
    expect(markup(false)).toBe(markup('More actions'));
    expect(markup(undefined)).toBe(markup('More actions'));
    expect(markup(false)).toMatch(/^<span class="tooltip-anchor[^"]*"><button[^>]*aria-label="More actions"/);
  });

  it('keeps the wrapper when a tooltip has nothing to say', () => {
    const children = createElement('button', { type: 'button' }, 'x');
    const empty = renderToStaticMarkup(createElement(Tooltip, { content: '', children }));
    const full = renderToStaticMarkup(createElement(Tooltip, { content: 'Why', children }));
    const off = renderToStaticMarkup(createElement(Tooltip, { content: 'Why', disabled: true, children }));
    expect(empty).toBe(full);
    expect(off).toBe(full);
  });
});

describe('Tab inside a popover panel', () => {
  const step = (count: number, before: number, after: number, inMenu: boolean, backward: boolean) =>
    panelTabStep({ count, before, after, inMenu }, backward);

  it('leaves past either end of the panel', () => {
    expect(step(3, 2, 0, false, false)).toBe('leave');   // Tab on the last stop
    expect(step(3, 0, 2, false, true)).toBe('leave');    // Shift+Tab on the first stop
  });

  it('leaves a panel with nothing to focus (the bell with no exceptions)', () => {
    expect(step(0, 0, 0, false, false)).toBe('leave');
    expect(step(0, 0, 0, false, true)).toBe('leave');
  });

  it('lets the browser move between stops inside the panel', () => {
    expect(step(3, 1, 1, false, false)).toBe('native');
    expect(step(3, 1, 1, false, true)).toBe('native');
    // The panel itself has focus: Tab goes to its first stop, Shift+Tab out.
    expect(step(2, 0, 2, false, false)).toBe('native');
    expect(step(2, 0, 2, false, true)).toBe('leave');
  });

  it('treats a menu as one stop: Tab leaves it from any item', () => {
    // A menu alone in its panel (the ⋯ menu, a rail flyout): out either way.
    expect(step(4, 0, 0, true, false)).toBe('leave');
    expect(step(4, 0, 0, true, true)).toBe('leave');
    // The account menu: the theme switch (stop 0) above three menu items.
    expect(step(4, 1, 0, true, true)).toBe(0);
    expect(step(4, 1, 0, true, false)).toBe('leave');
    // A stop after the menu is the next one, not the next item.
    expect(step(5, 1, 1, true, false)).toBe(4);
  });
});
