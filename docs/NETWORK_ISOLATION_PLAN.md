# Network Isolation Plan

Kova already isolates OpenClaw state through OCM envs, unique env names, and
env-scoped gateway ports. That is enough to avoid ordinary state collisions,
but it is not a namespaced network boundary. Parallel QA runs can still share
the host loopback namespace, and a hardcoded or misrouted localhost client can
talk to the wrong gateway if the harness is careless.

This plan adds a network isolation layer without changing the core Kova model:
Kova remains the OpenClaw scenario and evidence engine, OCM remains the env and
runtime control plane, and an outer worker layer owns network frontage.

## Goal

Run multiple OpenClaw QA workers on the same macOS host without network-layer
crosstalk, while preserving macOS fidelity for macOS validation.

Each worker should be able to run OpenClaw normally, so from inside the worker
the product can still use `127.0.0.1`. From the host/control plane, each worker
is addressed through a distinct loopback frontage such as:

```text
127.0.1.11 -> worker 1
127.0.1.12 -> worker 2
127.0.1.13 -> worker 3
```

This is intentionally different from moving macOS QA into Linux containers.
Linux containers or Linux VMs are useful for Linux validation, but they are not
faithful evidence for macOS-specific OpenClaw service, process, filesystem, or
launcher behavior.

## Non-Goals

- Do not replace Kova scenarios with Docker-specific test scripts.
- Do not use Linux network namespaces as proof of macOS behavior.
- Do not require OpenClaw itself to bind to worker-specific host aliases.
- Do not target a user's live OpenClaw gateway by fixed URL during matrix runs.

## Proposed Architecture

```text
host control plane
  -> worker A
       OCM env: kova-...
       OpenClaw sees: 127.0.0.1:<gateway-port>
       Host frontage: 127.0.1.11:<stable-or-worker-port>
  -> worker B
       OCM env: kova-...
       OpenClaw sees: 127.0.0.1:<gateway-port>
       Host frontage: 127.0.1.12:<stable-or-worker-port>
```

On macOS, there is no Linux-style per-process loopback namespace. The practical
macOS-faithful implementation is therefore a per-worker frontage/proxy layer:

1. Kova/OCM starts a disposable env with its normal gateway port.
2. The worker records the env name, gateway port, and run id.
3. The isolation layer allocates a host loopback frontage IP.
4. A per-worker proxy forwards only that frontage to the worker gateway.
5. External inspectors and orchestration clients use the frontage address.
6. Kova's internal support commands continue to use OCM env metadata.

## Required Kova Changes

- Add an optional isolation mode, for example `--network-frontage loopback`.
- Add a worker allocation contract with:
  - `workerId`
  - `envName`
  - `frontageHost`
  - `frontagePort`
  - `gatewayHost`
  - `gatewayPort`
  - `proxyPid` or service identifier
- Include the allocation in `kova.report.v1` and summary JSON.
- Add cleanup that tears down proxies and loopback aliases before env destroy
  completes.
- Fail fast if a scenario in isolation mode tries to use a fixed external
  `127.0.0.1:<port>` target instead of resolved env metadata.
- Add a validation check that the frontage reaches the expected env/build, not
  just any healthy OpenClaw gateway.

## Proxy Requirements

The proxy should be deliberately small and auditable:

- bind only to the allocated loopback frontage
- forward only to the OCM-reported gateway port
- support HTTP and websocket traffic
- expose liveness for cleanup diagnostics
- log bind failures and target connection failures as harness blockers
- shut down on normal cleanup and on interrupted runs

The proxy must not become the acceptance surface for OpenClaw behavior. Kova
should still evaluate OpenClaw using scenario evidence, gateway health, logs,
metrics, and artifacts.

## Isolation Levels

`port`

The current lightweight model. OCM assigns unique envs and gateway ports.
Fastest, but all workers share host loopback.

`loopback-frontage`

Recommended macOS QA model. Each worker gets a unique host loopback frontage
and proxy while OpenClaw continues to run as normal macOS processes. Prevents
ordinary network crosstalk and keeps macOS process/service fidelity.

`container-netns`

Optional Linux validation model. Runs workers inside container network
namespaces with bind-mounted artifacts/repos. Strong network isolation, but
not macOS-fidelity evidence.

`vm`

Strongest boundary. Use macOS VMs for macOS validation only when the cost is
acceptable; use Linux VMs for Linux validation. Heavyweight and slower, but
cleanest isolation.

## Open Questions

- Which proxy implementation should Kova use by default on macOS?
- Should frontage ports be stable per worker or mirror the internal gateway
  port?
- Should Kova own loopback alias creation, or should an outer orchestrator
  provide preallocated frontages?
- How should browser automation artifacts record internal versus frontage
  URLs?
- Should `matrix run --parallel` eventually allocate one frontage per scenario
  entry? Current Kova rejects `--network-frontage loopback` with
  `--parallel > 1`; use sequential matrix runs or separate workers with distinct
  `--worker-id` values.

## Acceptance Criteria

- Two parallel workers can both run a gateway on their own OCM envs without
  any client request hitting the wrong env.
- The report records the internal gateway and external frontage mapping.
- A deliberate misrouting test fails with a clear harness error.
- Cleanup removes proxies and aliases even when the scenario fails.
- macOS runs continue to execute OpenClaw as macOS processes, not Linux
  container processes, unless the target platform is explicitly Linux.
