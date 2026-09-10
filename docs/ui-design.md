# Workspace interface

The workspace uses one shared system of type, shapes and controls across its five
palettes. New browsers start in Daylight; an existing saved theme is preserved.
`styles.css` contains feature layouts and shared type/geometry tokens, `themes.css`
contains palettes and theme controls, and `interface.css` contains the common
visual treatment and responsive behavior. Theme changes do not change typography
or component geometry.

- Self-hosted Noto Sans SC Variable for interface text; system monospace for code
  and paths. The pinned Fontsource package supplies WOFF2 Unicode subsets, loaded
  on demand with `font-display: swap`; no Google Fonts runtime requests. System
  fonts remain fallbacks. The OFL license ships under `/fonts/OFL-NotoSansSC.txt`.
  Main conversation
  text is 1rem, secondary text .875rem, captions .8125rem. Limited timestamps and
  inline metadata use .75rem. Mobile inputs stay at least 1rem to avoid focus zoom.
- Quiet backgrounds and separators, coordinated 10/16/24px control/surface/dialog
  corners, and consistent focus and pressed states. Translucency is confined to
  desktop navigation; content uses solid surfaces. Reduced-motion and
  reduced-transparency preferences are respected.
- Desktop columns prioritize conversation width. Folding the project catalog
  preserves its mounted state, search, and draft behavior. Message content fills
  the available conversation width, including when the catalog is folded.
- At 900px and below, navigation moves to a bottom bar. The attention entry only
  appears when requests are pending or its page is currently open. An open
  conversation fills the screen, with a back control and visible input area.
  Host, catalog and navigation content stays mounted underneath.
- At 660px and below, host cards become single-column rows. The horizontal host
  picker brings the selected host into view. Dialogs use bottom sheets with
  safe-area padding.
- On narrow screens or coarse-pointer devices, Return inserts a new line;
  the Send button submits. Desktop keyboard shortcuts and IME protection remain.
- `useMobileViewport` follows keyboard resizing and panning through VisualViewport,
  leaving pinch zoom alone. The layout falls back to dynamic viewport units when
  VisualViewport is unavailable.
- Infrequent conversation actions are in More. Deletion still opens the existing
  preview/confirmation flow. Model provenance and explanatory text are folded
  separately from editable settings; permission and deletion scope notices remain.

## Validation

Run `NODE_ENV=test npm --prefix apps/web test` and
`npm --prefix apps/web run build`. The explicit test environment is necessary on
hosts whose shell defaults to `NODE_ENV=production`.

Browser checks use isolated API fixtures and never execute actual host commands.
The September 2026 refresh was checked at widths 320, 375, 390, 430, 660, 768, 900,
901, 1024, 1180 and 1440px, plus landscape 844x390. Checks cover document overflow,
visible composer, Chinese/English controls, modal bounds, Return behavior, draft
retention, theme persistence, and navigation. Keyboard viewport resizing is also
simulated and unit-tested; this does not replace testing on physical iOS devices.

Release this as a web-only image using `packaging/Dockerfile.web`. Preserve a known
base image and verify backend and published download checksums before switching
the control-plane container. See [web-only release](web-only-release.md).

Assistant messages render CommonMark and GFM with react-markdown and remark-gfm.
Headings, nested lists, quotes, task lists and tables share the interface type
scale. Wide tables and fenced code scroll within the message; code has an exact
copy action. Raw HTML is ignored and the default URL sanitizer stays enabled.
Markdown images are links; uploaded attachments retain their existing viewer.
User messages, execution logs and the raw view preserve literal text.
