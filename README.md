# agent-core

The shared core of two browser-agent products by the same author:

- **pi-do-browser-ext**: the core packaged as a standalone Chrome side-panel agent.
- **X Gardener**: the same core plus X/Twitter and connectors on top (Routines are the core's).

A fix lands here once and reaches both projects in the same step. Plain ESM JavaScript with JSDoc
and handwritten `.d.ts` files, zero runtime dependencies, no build step (the chat UI's JSX is
compiled by each product's bundler), no product- or site-specific code. `ARCHITECTURE.md` describes the layout and the extension points.

## Consuming it

agent-core lives in the X Gardener repository as `packages/agent-core`, next to `packages/pi-do`;
both depend on it as a local `file:` package (no npm workspaces) and import it by package name,
one layer at a time:

```js
import { hitTest } from "agent-core/browser";
import { MEMORY_SCHEMA } from "agent-core/memory";
import { createTurnBudget } from "agent-core/runtime";
import { mountChat } from "agent-core/ui";   // JSX: bundled by the product (Vite, esbuild)
import "agent-core/ui/chat.css";
```

Nothing is vendored or synced. X Gardener's `tests/source-boundaries.test.js` fails on a path
import into `packages/`, on a local copy of a core export in Gardener, and on a core file that
imports anything outside the core or names a product.

A standalone copy of this package is a one-way mirror split from the X Gardener monorepo;
changes are not accepted on the mirror.

### From the standalone repository

agent-core is not published to npm. A product depends on a checkout of it, as pi-do does with
`"agent-core": "file:../agent-core"` and the repository cloned next to its own. To run the tests
of a standalone checkout (Node 22.18+; the peer dependencies are installed as well):

```sh
git clone https://github.com/vorbei/agent-core.git
cd agent-core && npm install && npm test
```

## Changing it

1. Change it in `packages/agent-core`, together with whatever Gardener or pi-do needs for the
   change, in one commit.
2. `npm test` here (Node 22.18+; in the monorepo the tests use the root's installed packages), then the X Gardener monorepo's local gate,
   which runs this package's tests, pi-do's `check` and Gardener's checks against the change.
3. Bump `version` in `package.json` when a release of either product ships a core change.

## License

MIT (`LICENSE`). Adapted and third-party pieces are listed in `NOTICE.md`.
