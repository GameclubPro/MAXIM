# Local commercial-ad model in shadow mode

The optional `gemma-commercial-shadow` service runs the text-only Gemma 4 26B-A4B
Q4_K_M model alongside MAXIM, Svyazka and Karavan. It supplies observations only.
The model never owns a MAX token, database, Redis connection, message deletion or
publication permission. Do not treat successful synthetic JSON as evidence of
Russian advertisement-classification accuracy.

## Isolation and immutable identity

- The official llama.cpp CPU image is pinned by its linux/amd64 manifest digest,
  upstream revision and Docker image ID in
  `infra/scripts/commercial-llm-runtime.mjs`. The production Compose contract and
  focused tests bind the same identity.
  Production Docker 29 uses its containerd image store, where the image ID is
  the pinned OCI manifest digest. The distinct config-blob digest is not a Docker
  image ID on this host. Installation checks the exact descriptor, repository
  digest, platform, upstream revision and version before creating the container.
- Text weights are exactly 17,074,419,072 bytes, SHA-256
  `a8bdd07a49b895083bb1420bb895ad9ab3e3b8f7d5cc42c7582ca0fa765eede2`.
  The official Google chat template and Apache 2.0 license are independently pinned
  and checked. The vision projector and draft model are omitted.
- The runtime has a 4 CPU quota, 4 inference and prompt threads, low CPU shares,
  24 GiB memory including swap, 128 PIDs, one inference slot and a 4096-token
  context. Generation is capped at 128 tokens. Thinking, context shifting, tools,
  the web UI and slot inspection are disabled. Oversized prompts must fail as a
  technical error rather than silently dropping message context.
- The service has no host ports. Its only network is the internal
  `infra_commercial_llm_internal` network; only `api-moderation-background` may
  share it. The API role retains its ordinary network separately. The model
  cannot use this internal network for Internet access.
- Model and template mounts are read-only. The process runs as UID/GID 1000,
  with a read-only root, a 64 MiB temporary directory, dropped capabilities and
  no new privileges. It receives no project env file or secrets.
- Artifacts and its atomic provenance receipt live under
  `/var/lib/maxim-deploy/commercial-llm`, outside Git and application store
  volumes. The auxiliary has its own receipt; it is not a fifteenth API role or
  a fourth application release component. Normal API releases preserve it.

## First delivery

Finish local checks, push through the standard staged commit helper and require
successful `Required` and `Analyze JavaScript and TypeScript` on the exact selected
SHA. Keep the release checkout unchanged while a wrapper uses it.

Run these operations sequentially from that clean, green checkout:

```bash
./infra/scripts/vps-connect.sh deploy main --plan
./infra/scripts/vps-connect.sh commercial-llm install
./infra/scripts/vps-connect.sh commercial-llm install --apply
./infra/scripts/vps-connect.sh commercial-llm status
./infra/scripts/vps-connect.sh commercial-llm enable --apply
./infra/scripts/vps-connect.sh deploy main --auto
```

The plan synchronizes the reviewed tools without replacing runtime containers.
Installation and flag changes independently require that exact clean remote
checkout and a valid ordinary application release manifest. Each mutation holds
the persistent protected deploy lock and obeys recovery/maintenance gates. The
installation never builds the API or starts, recreates or clears stores.

Installation checks available RAM of at least 32 GiB and free space for all
remaining artifacts plus the unlowerable 10 GiB application floor and a 2 GiB
image reserve on both the model and Docker filesystems. These readings are
admission snapshots, not peak-load acceptance. It downloads through HTTPS with a
16 MiB/s ceiling, a one-hour deadline and a 30-second heartbeat carrying the last
observed file size. An interrupted `.partial` file is retained and resumed only
under the same pinned checksum. Existing complete artifacts are always checked.
Image pulling has a separate 15-minute deadline.

The container must become healthy within three minutes, pass exact identity,
network and containment checks, then return complete constrained JSON for a
closed synthetic greeting. Only then is the immutable model/image/source receipt
written. A failed or missing sample is not a successful install. A different or drifted container, or any present malformed/foreign receipt, is
refused. An interrupted unrecorded singleton may be recovered only after all
pinned artifacts and its exact image, command, resource, network and mount
boundaries are rechecked. Recovery waits for and smokes that same generation
before writing a success receipt; it never fabricates an earlier successful
installation.

`enable` atomically changes only `COMMERCIAL_LLM_SHADOW_ENABLED=true` in the root
dotenv. It preserves other settings and refuses duplicate keys. It requires the
installed healthy model, its matching receipt and the closed synthetic smoke.
It does **not** change running API containers. The subsequent ordinary deploy
delivers the previously unreleased API/Compose change to all 14 roles under the
existing webhook fence and strict application/native smokes. Keep the original
code release pending until after installation and flag staging, so one normal
deployment activates the background consumer.

The model service does not gate ordinary API readiness. Model timeouts, malformed
JSON, full queues or host pressure must shed shadow work and preserve existing
moderation behavior. Observe the independently bounded shadow polling, technical
errors, drop reasons and host impact after deployment. Accuracy acceptance needs
independent human labels and separate false-positive/false-negative measures.

## Readback, stopping and rollback

```bash
./infra/scripts/vps-connect.sh commercial-llm status
./infra/scripts/vps-connect.sh commercial-llm smoke
./infra/scripts/vps-connect.sh commercial-llm check-client
./infra/scripts/vps-connect.sh commercial-llm disable --apply
./infra/scripts/vps-connect.sh commercial-llm stop --apply
```

Status reports only allowlisted provenance, limits, health and restart counts;
it never prints message text, prompts or secrets. Smoke sends only its fixed
synthetic input directly inside the model container and does not contact MAX.
The schema fixes the expected response, so this is a transport/grammar check,
not a semantic model evaluation. `check-client` binds the active shared API image
and the background role, then runs only the compiled standalone
`commercial-llm-shadow-smoke.js` script there. Its two closed synthetic classifier
cases exercise the actual prompt, parser and shared inference admission lease;
it does not contact MAX or write moderation outcomes. Its output is limited to
pass counts, model/prompt hashes and the two known synthetic case classifications
and durations. This is still not a representative accuracy
evaluation.

Disable stages the flag as false for the next ordinary API deployment. Stopping
the model releases its resources immediately and preserves weights, receipts,
queues and the running API. A still-enabled client must fail open and shed its
shadow work. `install --apply` can restart the same attested stopped generation
after a fresh capacity check, artifact checks and smoke. It can also finish an
interrupted unrecorded install under those same exact checks. `stop --apply` may
stop that captured unrecorded generation only after complete containment and
artifact verification, and reports `unrecorded_generation_stopped` without
creating a successful-install receipt. Both paths recheck the container ID and
refuse generation replacement; neither removes a different generation to force
success. Model, template and license hashing each have a two-minute deadline.

Application rollback stays component-scoped through the normal release wrapper.
The optional inference service is independent; leaving it stopped does not
relax any installed API rollback reader floor. A model/image/template upgrade
needs new immutable pins, capacity admission, focused tests and its own reviewed
install procedure; never replace the pinned files or use a floating image tag.

Do not fine-tune on this shared host. Start with the pinned instruction model,
collect independent labels and consider an externally trained adapter only when
repeatable errors remain after prompt and example improvements.

## Focused validation

```bash
node --test infra/scripts/commercial-llm-runtime.test.mjs
```

The tests exercise the actual rendered Compose network/resource contract, reject
public exposure and containment drift, preserve unrelated dotenv bytes, reject
insufficient independent capacity, validate receipts and reject incomplete or
unexpected synthetic JSON. Run the planner-selected infrastructure checks and
normal exact-SHA CI before production operations.
