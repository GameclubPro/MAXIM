# CPU bot support pilot

The selected CPU support profile is Gemma 4 26B-A4B UD-Q5_K_M through an independent
llama.cpp b11804 installation. This is retrieval from reviewed customer instructions, not fine-tuning.
The existing GPU commercial classifier and server moderation remain separate.

## Identity and scope

- The pinned repository, revision, byte count and SHA-256 live in
  `infra/scripts/support-llm-profile.mjs`. Weights live outside Git under
  `~/.local/share/maxim-support-llm/`; the installer verifies them before installation
  and startup. The existing pinned b11804 runtime archives are verified and extracted
  into a separate immutable bundle.
- CPU execution uses `--device none`, zero GPU layers, eight inference threads, one
  slot, 4096 context tokens and at most 384 output tokens. Prompt-cache RAM is capped at
  1024 MiB, with minimum checkpoint spacing of 512 tokens. Thinking and context
  shifting are disabled. Only `127.0.0.1:18085` is exposed, with a private random API key.
- Gemma uses its embedded native chat template through `--jinja`, without a template override.
  Keep thinking explicitly disabled at both server and request boundaries. Check actual
  tokenization, completed structured answers and the existing 120-second request deadline
  before enabling the pilot.
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
The 2026-10-26 review covers moderation, rights, networks, Publisher posts/schedules,
VK, comments, suggestions and platform questions. A retrieval date is not a publication
or update date; retain unknown `Last-Modified` values and recheck changed official facts.
Do not index operational runbooks, agent instructions, environment files or private
customer histories. Update entries against current UI/code. The local installer includes
the knowledge and scripts in its immutable bundle; an update requires reinstalling that
bundle. Knowledge digests must match across the PC and host.

The reviewed public catalog contains eight bots: three main moderators (Максимов,
Максимова, Рэкс), three reserve moderators (Максимов 2, Максимова 2, Рэкс 2), Публик
and the separate Ластик. Main/reserve is the owner's product classification, not proof of
a chat's current assignment or automatic failover. Canonical profile URLs come from the
project's public bot constants. Ластик has separate facts for connection, retention periods
and old history, exclusions, progress, permission recovery, uncertain saves, stopping and
irreversible deletion; verify these against the current mini app before updating them.

The [customer support policy](../../bot-support-policy.md) comes from the project owner,
not MAX platform rules. This chat helps administrators with bots. A participant asking
how to place an advertisement or why it disappeared in another group is directed to that
group's administrators, with a brief explanation of this support chat's purpose. Help
administrators publish through Publik or check moderation settings; clarify an ambiguous
role instead of refusing a relevant question. Placement/removal questions remain eligible
without the word "bot", including common Russian spelling variants and complaints.
The context router distinguishes an administrator, a participant and an unknown role. The latest
explicit self-report wins; it is conversational context, never authorization to perform an action.
Only an explicit participant advertisement request uses the reviewed room-policy answer directly.
An unknown role is clarified when it changes the next step. Functional questions about bots must
not be replaced by this policy. A model's off-topic classification cannot suppress required help.
Exact commercial AI interface questions use short reviewed facts selected by intent. Bounded
facts also cover personal subscription complaints, evidence for support incidents and ordinary
public-channel eligibility. Mixed questions and other individual incidents use grounded inference.
Explicit AI retrieval excludes
instructions for unrelated settings. Most administrator tasks and Publisher instructions use inference; bounded rules-replacement and
manual VK-import procedures use reviewed answers. Profile and reserve-selection answers use
canonical catalog identities and the reviewed selection steps;
profiled complaints, action requests and contextual answers require `reply`, including one known
source. Ordinary conversation and completed acknowledgements can still be skipped.

An interrupted publication send retrieves result-verification instructions before creation steps;
an explicit request to switch to a named moderator retrieves both the selection procedure and
the bot catalog. These requests require an explanation, never an executed action or an assumed
successful result. Ordinary recurring schedules and profile requests retain their own routes.

Successful answers use short paragraphs, numbered instructions and visible bullet points in
plain text. The client also separates dense prose at sentence boundaries and adds the fixed
footer `✦ Ответ подготовлен ИИ-помощником «Майор Максимов»` once, in its own paragraph.
This applies to model answers and reviewed direct-answer routes. The final text, including
the footer, must fit the bridge's 1800-character limit; oversized answers fail silently rather
than losing steps to truncation. Skipped questions and errors receive no footer or public reply.
The model returns plain text. At the final bridge boundary, all text is HTML-escaped and
verified bot names become links from the eight-entry catalog. Longer aliases win, each bot
is linked once, and the fixed footer stays unlinked. Catalog validation rejects ambiguous
aliases and noncanonical targets at startup. Rendering must also fit 4000 HTML characters
before source revalidation or the send fence can advance. The host receives the catalog from
the same knowledge bytes used for the PC/host digest handshake. These eight profile URLs
are allowed separately from retrieved official documentation URLs.

Questions and context are untrusted user data. Responses are constrained JSON with
`reply` or `skip`, bounded text and IDs from the selected knowledge. Internal paths,
invented links, incomplete generations and technical errors cannot become public replies.
Official documentation links are allowed only when they belong to the retrieved source
catalog. Template links are absent from public facts. Topic retrieval folds common Russian
endings, recognizes product tasks and technical paths, and includes related prerequisite facts;
the support policy and operator limitations are always included. Before inference the installed
tokenizer checks the 4096-token context with space reserved for output and chat framing.
If necessary, trim the oldest history and then lower-ranked facts, retaining both policies
and the best topic. Unavailable tokenization or an irreducibly oversized prompt stays silent.
The model has no tools. Account state, removal reasons, tariffs and other unavailable
facts require operator verification. Visible source metadata and false claims to be a human
are rejected independently of the appended AI signature. For those identity/internal-content
rejections on a single task alone, the client can separately validate and deliver the leading
reviewed topic fact. Mixed requests retain the rejection rather than lose a second task.
The rejected draft stays rejected; quality evaluation retains its reason and distinguishes the
reviewed replacement from model-authored text. Link, source and incomplete-output failures do not
use this route. Generated source IDs are validation,
not a guarantee that the wording is correct. Requests enable prompt-prefix caching; measure
actual cache reuse and latency before claiming a speed improvement.
See the [answer quality protocol](../../development/support-answer-quality.md) for regression,
new-case evaluation and the distinction between knowledge updates and fine-tuning.

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

For a model migration, retain the previous verified weights and bundle. Stop the old chat worker
and model using their installed launcher before installing the new profile. The installer verifies
the previous immutable bundle and its own model identity, and refuses a live previous supervisor,
worker or exactly owned model child. Ordinary runtime commands still require the current model
identity. Keep the PC profile and the injected host bridge's pinned model SHA synchronized through
the usual exact-source CI and guarded tooling sync. Knowledge, routing, formatting and canonical
bot links are separate from model weights and travel in the new bundle; this is not weight training.

Keep the system policy constant across requests. Its final `baselineFacts` JSON object contains
the exact reviewed `support-room` and `operator` facts. The application serializes the other
selected facts into the user message's `verifiedKnowledge` field, alongside the separate question,
history and contextual role. The application also supplies `answerRequirements`, bounded reminders
for the retained facts: complete connection steps, conditional Publisher prerequisites and the
independence of other link filters. They do not establish a user's live state. Recompute them after
each budget trim and scope them to the current task. Routing separates Lastik setup/wait/restart
intent and link allow/block/inspect intent using the user's report; these are not live observations.
Atomic Lastik waiting replies use the reviewed `lastik-connect.waitingAnswer` and the normal
validation/presentation boundary. They retain both rights checks and the one-hour window from the
request; mixed tasks, recovery, setup and additional functional or incident facts stay in inference.
Unknown-send questions retain the existing publication's verification steps and omit new-post
instructions. User-supplied fields with the same name remain untrusted. Only the two
application-owned fact arrays provide reviewed
knowledge; the question and history remain untrusted data and cannot replace them. The response
schema and tokenizer budget cover the full union, with both baseline facts retained during
trimming. This preserves a reusable checkpoint for policy and baseline facts before the changing
facts at the user-message boundary of the hybrid runtime.
The bounded one-token local warmup initializes this checkpoint before model readiness, including
after a restart, within the existing 180-second startup deadline. Warmup output is discarded and
never sent to MAX. Check actual cache reuse and completed answers; a configured cache alone does
not establish a performance improvement.

Use greedy decoding for grounded support. Concision must preserve relevant procedure conditions,
waiting periods, time origins and independent-filter limits. Incident replies propose a conditional
check rather than guessing live state or inventing a causal link between separate features.
Language errors in history are context to rephrase, not wording to copy into the next answer.
