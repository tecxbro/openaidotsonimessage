# Your dot. In iMessage.

60-second silent-first technical motion graphic. 1920 × 1080, 60 fps. Original editorial typography, diagram assets, and phone illustration. This is an architecture explainer, not a recording of a live phone test.

## Storyboard and caption script

### 01 · 0–6.5 seconds · Your dot. In iMessage.

Visual: An illustrative phone conversation appears beside the title. A familiar interface, connected through Photon.

Caption script: Your dot, in iMessage. A familiar conversation with an active agent behind it.

### 02 · 6.5–14 seconds · Reuse the existing bridge

Visual: Three cards connect iPhone, Photon Spectrum and the existing Bun runtime. The TLS / gRPC transport stays in place.

Caption script: iPhone to Photon Spectrum to the existing runtime. Keep the transport; connect it to the active task.

### 03 · 14–22 seconds · Save it before you process it

Visual: Messages move into a durable inbox. Persist, batch, and claim appear in sequence.

Caption script: Messages become saved batches the active task can claim. A single owner holds an expiring claim.

### 04 · 22–30 seconds · dot owns the response

Visual: A bounded active-task panel separates saved inbound work from the outbound queue. An explicit limitation remains on screen.

Caption script: The active dot task reads the batch and authors the reply. There is no separate model in the listener and no automatic platform wake.

### 05 · 30–38 seconds · Back to the same conversation

Visual: The authorized reply moves from outbox through Photon to the original iMessage thread. Queue, provider acceptance, and read receipt are shown as distinct states.

Caption script: The reply leaves through the existing outbound queue. Queued, provider-accepted, and read-receipt states stay distinct.

### 06 · 38–46 seconds · Voice becomes work for dot

Visual: An original animated waveform passes through the local Moonshine pipeline and becomes a transcript.

Caption script: The local Moonshine pipeline converts audio to text. The local audio path is verified; the phone-to-dot voice check is still pending.

### 07 · 46–53 seconds · A working bridge. Clear boundaries.

Visual: The evidence panel distinguishes the initial text exchange, verified local audio conversion and transcription, and pending rich phone checks.

Caption script: An initial text test verified inbound, reply, and read receipt. Local audio is verified. Full phone checks are still required; the bridge and dot task must be running.

### 08 · 53–60 seconds · iMessage is the interface. dot stays the agent.

Visual: The complete path resolves into a clean system line with a returning reply. Hold the final title through the last frame.

Caption script: Photon carries the messages. dot authors the response.

## Evidence boundary

Architecture frozen September 30, 2026. The existing repository runtime is connected to Photon Spectrum and reuses the existing message flow. The active dot task reads the durable local inbox, claims batches, and authors authorized outbound work. The listener does not call a second model.

The initial minimal text test established inbound, reply, and read receipt. It is separate from the newly integrated full runtime, whose fresh phone text and voice checks remain pending at this editorial freeze. The local Moonshine audio path is verified. Publicly hosted Live Mini surfaces and always-on automatic task activation are not claimed.

No phone numbers, inbox contents, credentials, project identifiers, or private screenshots are included. The example conversation is fictional and labeled illustrative.
