# ADR 0001: Backbone/API boundary and extension runtime delivery

## Status
Accepted

## Context
The project currently bundles the todo-reminders extension with the deployment and allows extension code to directly instantiate backbone services.

That tight coupling makes it harder to:
- update extension behavior without redeploying the server image,
- evolve backbone internals safely,
- support multiple extension versions against a stable API.

## Decision
1. The deployed server is the **backbone runtime**:
   - SQLite DB
   - migrations
   - service layer
   - HTTP API

2. The pi extension is treated as an **API client**:
   - extension must call `/api/*` endpoints
   - extension must not import or instantiate `createBackbone()`

3. Extension delivery is runtime-managed:
   - `npm run extension:sync` runs at startup
   - extension source can be controlled via env (`PI_EXTENSION_GIT_URL`, `PI_EXTENSION_REF`)

## Consequences
### Positive
- extension behavior can change independently from backbone deployment cycle,
- clearer contract boundary between orchestration (pi) and data/backend (backbone),
- easier future split into separate services/processes.

### Trade-offs
- API surface must stay stable and versioned,
- additional operational concern: extension sync/update process,
- extension now depends on network/API availability.

## Follow-up
- add API version prefix (`/api/v1`) before public externalization,
- add extension compatibility check endpoint (`/api/meta/capabilities`),
- optional hot-reload of pi RPC process when extension sync changes files.
