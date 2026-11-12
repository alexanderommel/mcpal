"use client";
// AG Grid Community (MIT), themed with the site's paper / ink / vermilion tokens. The params point at
// CSS variables from globals.css, so the grid follows the site into dark mode without a second theme.
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

export const mcpalGridTheme = themeQuartz.withParams({
  backgroundColor: "var(--card)",
  foregroundColor: "var(--ink)",
  textColor: "var(--ink)",
  accentColor: "var(--accent)",
  borderColor: "var(--line)",
  chromeBackgroundColor: "var(--paper)",
  headerBackgroundColor: "var(--paper)",
  headerTextColor: "var(--muted)",
  headerFontWeight: 500,
  headerFontSize: 12,
  oddRowBackgroundColor: "var(--card)",
  rowHoverColor: "var(--accent-soft)",
  selectedRowBackgroundColor: "var(--accent-soft)",
  inputBackgroundColor: "var(--card)",
  inputBorder: { color: "var(--line)" },
  fontFamily: "var(--font-sans), system-ui, sans-serif",
  fontSize: 13,
  wrapperBorderRadius: 10,
  borderRadius: 6,
  spacing: 6,
  rowHeight: 36,
  headerHeight: 38,
});
