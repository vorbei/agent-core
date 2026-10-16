# Agent rules

- This package (`packages/agent-core` in the X Gardener monorepo) is the single source of the
  code shared by pi-do (`packages/pi-do`) and X Gardener (the repository root). Both import it as
  the `agent-core` package (a local `file:` dependency); a fix is made here once, in the same commit as whatever
  either product needs, and the X Gardener monorepo's local gate runs both products against
  it. A standalone agent-core repository is a one-way mirror; never change it there.
- Imports: this package's own files, `node:` built-ins and the packages its `package.json` declares
  (peer dependencies only: `@earendil-works/pi-coding-agent` and `typebox` at the versions both products
  pin, so the core and its consumer run one Pi; `react`, `react-dom` and `marked` for the chat UI;
  `@mozilla/readability` and `linkedom` for the web layer's page reads);
  never a path or a package from the monorepo outside `packages/agent-core`.
- No runtime dependencies, no build step: ESM `.js` with JSDoc; each layer's types are in a
  handwritten `index.d.ts` beside its `index.js`, which is the layer's whole public surface. The
  one exception is `ui/`: its components are JSX (`.jsx`, entry `index.jsx`), compiled by the
  consumer's bundler; its non-visual modules stay plain `.js`. One responsive component set serves
  every width; class names are `chat-*` and colors and sizes `--chat-*` tokens.
- No product- or site-specific code: no X/Twitter, no Gardener or pi-do contracts or imports.
  Whatever a product decides (prose shown to the model, storage tables, CDP method allowlists,
  window and group titles) is passed in by the consumer. Prose both products send for the same
  core behaviour is written once in `guidance/`, with each product's tool names passed in; a rule
  only one product sends stays in that product.
- One role per file, stated in its header comment. No pass-through layers.
- Errors carry a stable `code`. Tests (`npm test`, `node:test`) exercise observable behavior with
  fake CDP, fake storage, a fake model or a fake ChatClient (the chat rendered into a linkedom
  document); they do not pin prose, file layout or CSS values.
- Record what was adapted from where in `NOTICE.md`; update `ARCHITECTURE.md` when an extension
  point changes.
