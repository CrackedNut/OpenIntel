/**
 * Light guard for the dashboard's mobile responsiveness. Not a layout test —
 * just ensures the phone app-bar CSS isn't accidentally stripped (the panel
 * was unusable on mobile until the sticky top-bar + scrollable nav landed).
 */
import { describe, it, expect } from 'bun:test';
import { PANEL_HTML } from './ui.js';

describe('PANEL_HTML mobile responsiveness', () => {
  it('declares a viewport meta tag', () => {
    expect(PANEL_HTML).toContain('name="viewport"');
    expect(PANEL_HTML).toContain('width=device-width');
  });

  it('has a phone breakpoint that turns the sidebar into a top app-bar', () => {
    expect(PANEL_HTML).toContain('@media (max-width: 760px)');
    // the app-bar layout: brand/actions on top, nav strip below
    expect(PANEL_HTML).toContain('"brand actions"');
    expect(PANEL_HTML).toContain('"nav nav"');
  });

  it('keeps the action buttons collapsible to icons (label spans present)', () => {
    expect(PANEL_HTML).toContain('class="rico"');
    expect(PANEL_HTML).toContain('class="lbl"');
  });
});
