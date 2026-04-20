# ADR 0002: Unified date/time protocol

## Status
Accepted

## Context
Date/time handling was duplicated across extension, services, bot relay, and dashboard code. This caused inconsistent parsing/display behavior and ambiguity.

## Decision
1. Canonical storage format is UTC ISO-8601 (`...Z`).
2. Natural-language parsing and day-range normalization are centralized in `src/time/protocol.ts`.
3. Components should use shared utilities for:
   - `resolveTimeExpression(...)`
   - `resolveDayRange(...)`
   - `isIsoDateTime(...)`
   - `nowIso()`
   - `formatDisplayDateTime(...)`
4. API accepts either:
   - explicit ISO datetime values, or
   - `timeExpression` + timezone (resolved server-side when supported).

## Consequences
### Positive
- consistent interpretation of natural language time inputs,
- fewer DST/timezone bugs from ad-hoc conversions,
- simpler testing and refactoring.

### Trade-offs
- strict input validation may reject previously tolerated values,
- consumers must be explicit about timezone where relevant.

## Follow-up
- add tests for DST transitions and ambiguous phrases,
- add `timezone`-aware display helpers to dashboard UI,
- document API datetime expectations in `docs/protocol.md` and OpenAPI.
