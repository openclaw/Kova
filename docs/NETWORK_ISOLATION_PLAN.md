# Network Frontage

Kova implements optional loopback frontage in
[src/network-frontage.mjs](../src/network-frontage.mjs) and
[support/network-frontage-proxy.mjs](../support/network-frontage-proxy.mjs).
OCM still owns disposable environments and gateway ports; Kova adds a worker
frontage and records the mapping in reports.

## Modes

`port` is the default. OCM supplies environment-scoped gateway ports while workers
share the host's network namespace.

`loopback-frontage` adds a worker-specific loopback address and a proxy to the
OCM-reported gateway port. `--network-frontage loopback` is its CLI alias. Use
`--worker-id` to assign distinct workers explicitly; `KOVA_WORKER_ID` is consulted
only when frontage is enabled.

```sh
kova run --target runtime:stable --scenario fresh-install --network-frontage loopback --worker-id 7 --json
```

This is a dry-run preview. Follow [Agent Usage](AGENT_USAGE.md) before adding
`--execute`.

## Boundaries

Frontage is a routing boundary, not an operating-system network namespace. It
preserves macOS-native execution but does not prevent arbitrary processes on the
host from accessing other loopback listeners. Container and VM isolation from
the original design are not Kova frontage modes.

Kova resolves endpoints from OCM metadata and rejects fixed localhost URLs in
frontage-enabled scenario commands. Support helpers receive the active frontage
endpoint. Reports retain the worker/environment identity, internal gateway,
frontage, proxy, validation, and cleanup evidence; see
[Report Schema](REPORT_SCHEMA.md).

Matrix execution currently rejects frontage with `--parallel > 1`. Use a
sequential matrix or separate workers with distinct IDs. Allocating a frontage
per parallel matrix entry remains a design decision, not an implemented feature.

Proxy cleanup belongs to Kova's lifecycle and must complete before disposable
environment cleanup is considered finished. A healthy proxy alone does not
establish healthy OpenClaw behavior: readiness, service identity, product
commands, and collected evidence still determine the result.
