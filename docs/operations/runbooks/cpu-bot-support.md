# CPU bot support pilot

The local PC runs Qwen3.5-35B-A3B Q4_K_M through an independent llama.cpp b11804
installation. This is retrieval from reviewed customer instructions, not fine-tuning.
The existing GPU commercial classifier and server moderation remain separate.

## Identity and scope

- The pinned repository, revision, byte count and SHA-256 live in
  `infra/scripts/support-llm-profile.mjs`. Weights live outside Git under
  `~/.local/share/maxim-support-llm/`; the installer verifies them before installation
  and startup. The existing pinned b11804 runtime archives are verified and extracted
  into a separate immutable bundle.
- CPU execution uses `--device none`, zero GPU layers, eight inference threads, one
  slot, 4096 context tokens and at most 384 output tokens. Thinking and context shifting
  are disabled. Only `127.0.0.1:18085` is exposed, with a private random API key.
- The sole recipient is the designated test **CHAT `-78271094414679`**. The bridge
  selects only its existing fixed, primary or legacy assigned moderator, verifies the
  actual remote entity type and fresh exact bot access, and refuses assignment drift.
  It never changes bot assignments, activation, webhooks or settings.
- The PC initiates strict-key SSH. Application tokens and database/Redis credentials
  remain on the VPS. The host verifies the running `api-action` image against the
  immutable component manifest before running the reviewed bridge inside that container.
  The bridge constructs focused real services without starting application workers.

## Grounding and delivery

`infra/scripts/support-llm-knowledge.json` contains reviewed customer instructions and
source paths, plus an official MAX source catalog with retrieval time and content digests.
The 2026-10-25 review covers moderation, rights, networks, Publisher posts/schedules,
VK, comments, suggestions and platform questions. A retrieval date is not a publication
or update date; retain unknown `Last-Modified` values and recheck changed official facts.
Do not index operational runbooks, agent instructions, environment files or private
customer histories. Update entries against current UI/code. The local installer includes
the knowledge and scripts in its immutable bundle; an update requires reinstalling that
bundle. Knowledge digests must match across the PC and host.

The [customer support policy](../../bot-support-policy.md) comes from the project owner,
not MAX platform rules. This chat helps administrators with bots. A participant asking
how to place an advertisement or why it disappeared in another group is directed to that
group's administrators, with a brief explanation of this support chat's purpose. Help
administrators publish through Publik or check moderation settings; clarify an ambiguous
role instead of refusing a relevant question. Placement/removal questions remain eligible
without the word "bot", including common Russian spelling variants and complaints.
For participant advertisement requests, the client returns the reviewed room-policy answer
directly. A model's off-topic classification cannot suppress that required explanation.
Exact questions about the commercial AI interface also use its reviewed FAQ directly:
CPU evaluation repeatedly invented unavailable mode and sanction controls. Image questions
retain the separate image-capability facts and inference. Explicit AI interface retrieval
excludes instructions for unrelated settings.
Administrator tasks and Publisher instructions use model inference; explicit help requests
and answers to a recent role clarification require a `reply` result. Ordinary conversation
and acknowledgements can still be skipped.

Questions and context are untrusted user data. Responses are constrained JSON with
`reply` or `skip`, bounded text and IDs from the selected knowledge. Internal paths,
invented links, incomplete generations and technical errors cannot become public replies.
Official documentation links are allowed only when they belong to the retrieved source
catalog. Topic retrieval folds common Russian endings and discounts common words; the
support policy and operator limitations are always included. Before inference the installed
tokenizer checks the 4096-token context with space reserved for output and chat framing.
If necessary, trim the oldest history and then lower-ranked facts, retaining both policies
and the best topic. Unavailable tokenization or an irreducibly oversized prompt stays silent.
The model has no tools. Account state, removal reasons, tariffs and other unavailable
facts require operator verification. Generated source IDs are validation, not a guarantee
that the wording is correct; evaluate real Russian support questions before wider use.

Every five seconds the bridge reads at most 30 messages through the ordinary shared MAX
admission/cooldown. It does not use `getUpdates`. Only explicit human messages newer than
session startup and at most three minutes old are eligible. Bot messages and old history
are ignored. A single question is outstanding; ordinary conversation is skipped. Relevant
bot questions and contextual followups do not require a mention.

Before sending, the bridge rechecks the source fingerprint through an exact message GET,
current bot assignment/access, legacy source/user/global holds, the session heartbeat and
the original deadline. The last step atomically changes the separate Redis source fence
from `PREPARED` to `SENDING`. Lost acknowledgements, process crashes and uncertain sends
remain fenced and are never replayed. Source fences last seven days, longer than source
eligibility. Redis owns one short worker lease and an execution-time session switch; do
not delete these keys to retry an answer. A lost PC/session silently stops replies.

## Install and operate

Place the exact pinned GGUF under `~/.local/share/maxim-support-llm/` and the verified
runtime archives under `~/.local/share/maxim-llm/`. The PC needs Node 24, Python 3, `flock`,
`tar` and verified `maxim-vps` SSH access. Keep model memory, the GPU classifier, Windows
and WSL capacity in the resource budget; 64 GB installed RAM does not mean WSL sees it all.

```bash
node infra/scripts/support-llm-workstation.mjs install
~/.local/bin/maxim-support start
~/.local/bin/maxim-support status
~/.local/bin/maxim-support ask 'Как подключить бота в канал?'
```

Run focused client/controller tests and the bridge's actual private Redis races before
the impact-selected commit aggregate. Require green exact-source CI, merge and synchronize
reviewed host tooling through the normal guarded `deploy main --plan` path. These files
do not change the API image or require rebuilding application services. Then:

```bash
./infra/scripts/vps-connect.sh support-chat preview
~/.local/bin/maxim-support chat-start
~/.local/bin/maxim-support chat-status
~/.local/bin/maxim-support chat-stop
~/.local/bin/maxim-support stop
```

The preview posts nothing. Local status is content-free and records exact PID/start identity,
heartbeat and successful reply counts. A connected worker proves transport availability,
not answer correctness or completed delivery. Check local question quality and latency
separately from a real user's fresh question and confirmed reply in the designated chat.
There are no automatic public diagnostics or fallback error messages.

For a knowledge update, finish source review, focused retrieval/policy checks, actual CPU
answer evaluation and exact-source CI first. Merge and synchronize the reviewed host source,
then stop `chat-stop` followed by `stop`, run the installer from that reviewed source and
start the model again. Confirm the new bundle/model identity, run the read-only preview and
start the chat worker. The existing weights are reused; this refreshes retrieval knowledge
and answer policy. Never change a running immutable bundle in place. Reconnects start a
fresh message baseline and participant history, while durable source fences remain intact.
