# Session condition coverage

This template contains eight implemented self-contained conditions and one pending declaration described in [the sessions coverage record](../sessions/coverage.md#conditions-established-by-the-operation-itself). It consumes a live foreground Gateway handle and only the persona keys each operation uses. It has no shared ambient-session setup: historical exports missing the rolling-main trait can still execute independent search and first-send observations.

Every operation records JSON responses. Browser conditions additionally record screenshots and video paths. A product refusal, timeout, false indexing flag, retained placement or missing reply is recorded as an observation; inability to establish the condition or restore its owned resources is a command failure. No observation alone certifies complete differential execution.

The broad sessions template retains the rest of the session journeys. Its global setup requirements are unchanged.

`event-worker-cancel-followup` remains declared but is withheld because its `session-worker-cancel` catalogue entry is `toWrite`. Paired-worker cancellation and cleanup proof are pending; this template does not yet provide that implementation or claim that coverage.
