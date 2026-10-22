# Compute pooling: using both machines' CPU and RAM (design draft)

Status: draft for discussion. Nothing here is built. Items marked **(verify)** are from background knowledge and must
be checked before relying on them. Companion to [INPUT_SHARING.md](INPUT_SHARING.md),
[INPUT_SHARING_SECURITY.md](INPUT_SHARING_SECURITY.md) and the Remote files feature (`src/main/remotefs.ts`).

## 1. Goal and what is out of scope

Goal: let one machine use the other's spare CPU and RAM for real work, so the two feel like one stronger computer.

**Out of scope: merging RAM into one memory space.** RAM answers in ~100 ns; even wired Ethernet takes ~200 µs and
Wi-Fi several ms, so remote memory would be 10^3 to 10^5 times slower than local. The Mac (Apple Silicon, arm64) and
the PC (usually x86-64) also have different instruction sets and different kernels, so a single system image across
them does not exist for consumer hardware. Research systems that do pooling need identical machines and special
interconnects. What works is **moving work to where the resources are**, plus **splitting work that is naturally
parallel or layered** (builds, test shards, AI model layers).

## 2. Is SSH the answer?

SSH is only a transport for "run this command over there". It pools nothing by itself, and it needs Remote Login
(macOS) or the OpenSSH Server (Windows) enabled and a second set of credentials. DevLink already has an authenticated,
encrypted, paired channel, so the better path is a small **worker** inside DevLink that uses that channel. SSH stays
available as a fallback (the Shortcuts tab already suggests `ssh user@ip`) and as a transport that existing tools
(Docker contexts, rsync) can use.

## 3. Architecture

```
 machine A (requester)                          machine B (worker)
 ┌──────────────────────┐   encrypted, paired   ┌─────────────────────────────┐
 │ jobs.ts  JobClient   │ ◀───── job-* ───────▶ │ jobs.ts  JobWorker           │
 │  "Run on <peer>"     │   (own connection,    │  - capacity + consent         │
 │  devlink run -- ...  │    see 6.3)           │  - sandbox (container / user) │
 └──────────┬───────────┘                       │  - resource limits, logs      │
            │ project files                     └──────────────┬──────────────┘
            ▼                                                  ▼
   Remote files share (src/main/remotefs.ts)           workspace on B
```

* **Discovery** already exists: mDNS finds devices and `status.ts` shares cores, free RAM and which tools are
  installed. Add a `capacity` message (cores free, RAM free, on battery or not, arch, OS, container runtime present,
  `acceptJobs` on or off) so a requester can pick the best machine and show why.
* **Worker** is the only new moving part. It never accepts a shell string. A job is an argument vector, a working
  directory inside an approved workspace, an environment allow-list, and limits.
* **Workspace**: the job needs the project files. Phase 1 uses a one-way snapshot sync from the requester into a
  per-job directory on the worker (fast, no live coupling). Later, mount the requester's share through Remote files for
  jobs that must see edits as they happen.

## 4. What gets built, in order

| phase | feature | pools | notes |
|---|---|---|---|
| 1 | **Run on other machine**: `devlink run -- npm test`, plus a button | CPU, RAM of the worker | stream stdout/stderr back, exit code, cancel, per-job limits |
| 2 | **Containers**: run the job inside a container on the worker | CPU, RAM | needs Docker/WSL2 on Windows, Colima/Docker Desktop on Mac; images must be multi-arch or run under emulation (slow) |
| 3 | **Build and test sharding**: split a test suite or build across both, share a cache | CPU | integrate with existing tools (remote caches such as sccache or Gradle/Bazel remote cache) instead of inventing one **(verify per tool)** |
| 4 | **AI model split**: put some layers of a large model on each machine | RAM (model weights) | integrate an existing project rather than build; llama.cpp has an RPC backend and exo targets this use case **(verify current status)**. Each token waits on the network, so it needs Ethernet/Thunderbolt to be pleasant |
| later | Wake a sleeping worker; keep-awake "work together" mode | n/a | see section 7 |

Phase 1 alone delivers most of the practical "one bigger computer" feeling for developers: start a heavy job from
either machine and have the stronger one run it while you keep working.

## 5. Wire protocol sketch (`job-` prefix)

| message | direction | purpose |
|---|---|---|
| `job-capacity` | worker → requester | cores/RAM free, arch, OS, runtime, accepting jobs |
| `job-submit` | requester → worker | `{id, argv[], cwd, env{}, limits{cpu,mem,wallSec}, workspace}` |
| `job-ack` / `job-deny` | worker → requester | consent result, reason |
| `job-out` | worker → requester | `{id, stream, chunk}` (size-capped, rate-limited) |
| `job-exit` | worker → requester | `{id, code, signal, usage}` |
| `job-cancel` | requester → worker | stop a job now |

All requester input is untrusted by the worker: validate every field, cap argv length and count, reject paths outside
the job workspace, and never pass anything through a shell.

## 6. Security (this is the hard part)

Letting another device run programs on your machine is equal in power to letting it type on your keyboard. Rules:

1. **Separate permission, off by default** ("Let paired devices run jobs on this machine"). Not implied by files,
   clipboard or Remote files. Same standard the user chose for shared input: **confirm every session**, held in
   memory only and cleared when the connection drops.
2. **Per-job transparency**: the worker shows what is running, for whom, with CPU/RAM use, and a one-click stop. Keep
   an audit log (peer, command line, start, end, exit code).
3. **Containment**: run as an unprivileged user or in a container with no access to the user's home folder, no network
   unless the job asks and the user allowed it, CPU/RAM/wall-clock limits, a fresh workspace per job that is deleted
   afterwards. Phase 1 without a container must say clearly that the job runs as the logged-in user.
4. **Environment scrubbing**: never forward the requester's environment wholesale (tokens, keys). Allow-list only.
5. **Output limits**: cap bytes and rate of `job-out` so a runaway job cannot flood the link or the UI.
6. **No elevation**: the worker never runs jobs elevated. A job that needs admin rights fails.
7. **Mutual trust**: both machines are trusted by the user, but a stolen or compromised paired device is the threat
   model. Everything above assumes the requester may be hostile.

### 6.3 Use a separate connection for jobs

All traffic now shares one TCP connection per peer. A large job output or file sync would delay input events and
clipboard, and `sock.pause()` flow control used by file receiving stalls everything (see INPUT_SHARING_SECURITY.md,
2.7). Jobs should use their own authenticated connection (same handshake, a `channel: "jobs"` marker), so a busy job
cannot freeze the cursor and the reverse.

## 7. Sleep, wake and "work together" mode

A sleeping machine cannot run DevLink, so something must wake it first.

* **Wake-on-LAN**: store the worker's MAC address at pairing and send a magic packet from the awake machine. Reliable
  for a PC on Ethernet once the BIOS and adapter allow it. Unreliable over Wi-Fi (WoWLAN support varies).
* **Mac**: "Wake for network access" can wake a Mac on Wi-Fi via the Bonjour sleep proxy on the network, but not
  reliably with the lid closed on battery **(verify)**.
* **Both on Wi-Fi (the user's current setup)**: waking will be unreliable, so the practical feature is a **"work
  together" mode**: while it is on, both machines hold a keep-awake assertion (macOS power assertion, Windows
  execution state), and DevLink shows who is awake and why. Turn it off and they sleep normally.

## 8. Network reality

Over Wi-Fi expect roughly tens to a couple of hundred Mbit/s and several ms of latency, with jitter. Phase 1 and 3
(batch work, results at the end) tolerate that well. Phase 4 (model split) and live mounts do not. A direct Ethernet or
Thunderbolt cable between the two machines is the single biggest improvement for pooling, bigger than any software.

## 9. Test plan

* Fake-process worker for the protocol and consent state machine, as in the input tests.
* Property tests on `job-submit` validation (argv length, env, cwd traversal, symlinks out of the workspace).
* Limits: a job that spins CPU, allocates memory, prints without end, or ignores cancel must be contained.
* Consent: no job without session approval; approval cleared on disconnect; deny paths leave no workspace behind.
* Manual: run a real test suite on the other machine over Wi-Fi and measure start-up, throughput and cancel time.

## 10. Open questions for the user

1. Which jobs matter most day to day: test runs, builds, Docker/servers, AI models, something else?
2. Is a container runtime (Docker Desktop, Colima, WSL2) acceptable to require on the worker for phase 2?
3. Should a job be allowed to use the network on the worker?
4. Which machine is usually the stronger one, and can they ever be connected by cable?
5. Should "work together" mode keep the screen locked or off while both stay awake?
