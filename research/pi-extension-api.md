# Code Context

## Files Retrieved
1. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (lines 1–250) – extension lifecycle, discovery, registration, and events.
2. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/slash-commands.md` (lines 1–110) – slash command definition, arguments, autocompletion.
3. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md` (lines 1–80) – package structure, manifest `pi` key, dependency management.
4. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (lines 780–840, 1120–1210, 1400–1450) – exact TypeScript interfaces for `ExtensionAPI`, `ExtensionContext`, `RegisteredCommand`, `ExtensionUIContext`, and lifecycle events.
5. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts` (lines 560–630) – `AssistantMessageEvent` stream event definitions (`text_delta`, `thinking_delta`, `toolcall_delta`).
6. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/send-user-message.ts` (lines 1–55) – `pi.sendUserMessage` usage and steering behavior.
7. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/with-deps/` (`package.json`, `index.ts`) – dependency layout for extensions.
8. `/Users/rhinesharar/.pi/agent/extensions/disable-askclaude.ts` (lines 1–16) – local user extension conventions.

---

## 1. Extension Entry Shape, Discovery, Dependencies & TS Loading

### Entry Shape
Default exported factory function receiving `ExtensionAPI` (can be `async` or sync):
```typescript
// cite: docs/extensions.md:19-29
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // register commands, listeners, tools
}
```

### Discovery Locations
- **Personal / Global**: `~/.pi/agent/extensions/` (scans `.ts`, `.js`, or subdirs with `index.ts`/`index.js`).
- **Project**: `.pi/extensions/` within repo root.
- **Installed Packages**: Installed via `pi install <source>` or `npm/git/local-path`. Manifest entry declared in `package.json` under `"pi"` key:
```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "pi": {
    "extensions": ["./dist/index.js"]
  }
}
```
*(cite: `docs/packages.md:35-50`)*
- **CLI Flag**: `pi --extension ./path/to/ext.ts`.

### Extensions with npm Dependencies (`with-deps` pattern)
Self-contained folder with its own `package.json` and `node_modules`:
```
~/.pi/agent/extensions/voice-ext/
├── package.json
├── node_modules/
└── index.ts
```
*(cite: `examples/extensions/with-deps/package.json`)*:
```json
{
  "name": "voice-extension",
  "private": true,
  "type": "module",
  "dependencies": {
    "node-record-lpcm16": "^1.0.1"
  }
}
```

### TypeScript Loading & Compilation
- Uses `jiti` under the hood (`core/extensions/jiti-loader.d.ts`). Local `.ts` files execute directly without prior `tsc` build step.

### `/reload` Behavior
- `/reload` re-instantiates runtime.
- Tears down prior session and invokes `session_shutdown`. Code running past reload must not hold stale state references.

---

## 2. Command Registration (`registerCommand`)

### Signature & Interfaces
Defined in `dist/core/extensions/types.d.ts:1120-1160`:
```typescript
registerCommand(name: string, definition: RegisteredCommand): void;

export interface RegisteredCommand {
  description: string;
  args?: RegisteredCommandArg[];
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | Promise<AutocompleteItem[]> | null;
}
```

### Argument Completion
Implement `getArgumentCompletions`:
```typescript
getArgumentCompletions: async (prefix: string) => {
  const options = ["start", "stop", "status", "voice"];
  return options
    .filter(opt => opt.startsWith(prefix))
    .map(opt => ({ value: opt, label: opt, description: `Voice action: ${opt}` }));
}
```

### Handler Context (`ctx.ui`)
`ExtensionCommandContext` provides `ctx.ui` (`dist/core/extensions/types.d.ts:1395-1440`):
- `ctx.hasUI`: boolean check if interactive terminal available (`false` in RPC/print mode).
- `ctx.ui.notify(message: string, level?: "info" | "warning" | "error")`: popup toast/notification.
- `ctx.ui.input(prompt: string, defaultValue?: string): Promise<string | undefined>`: modal prompt input.
- `ctx.ui.confirm(prompt: string): Promise<boolean>`: yes/no prompt.
- `ctx.ui.select(prompt: string, options: string[]): Promise<string | undefined>`: pick list.
- `ctx.ui.setStatus(key: string, value: string | undefined)`: updates bottom status bar widget.
- `ctx.ui.setWidget(id: string, lines: string[] | undefined, placement?: "top" | "bottom")`: renders inline widget lines above/below prompt.

---

## 3. Programmatic User Prompt Submission & State Inspection

### Submitting Prompts (`pi.sendUserMessage`)
Signature (`dist/core/extensions/types.d.ts:1175-1195`):
```typescript
pi.sendUserMessage(
  message: string | UserContent[],
  options?: {
    deliverAs?: "steer" | "followUp";
    source?: string;
  }
): Promise<void>;
```
- When agent running:
  - `deliverAs: "steer"`: injects immediately into currently executing turn/step.
  - `deliverAs: "followUp"`: queues after current turn completes.
*(cite: `examples/extensions/send-user-message.ts:25-45`)*

### Checking Status & Aborting
From `ExtensionAPI` (`dist/core/extensions/types.d.ts:1170-1210`):
- `pi.isBusy()`: `true` if model executing or tool run in progress; `false` when idle.
- `pi.abort()`: requests immediate abort of current turn/stream.

---

## 4. Events for Streaming Assistant Output

### Event Subscription
Subscribe via `pi.on(eventName, handler)`.

### Lifecycle Events (`dist/core/extensions/types.d.ts:780-840`)
- `"agent_start"`: `({ runId: string }) => void`
- `"turn_start"`: `({ turnId: string }) => void`
- `"turn_end"`: `({ turnId: string, message: AssistantMessage }) => void`
- `"agent_end"`: `({ runId: string, messages: AssistantMessage[] }) => void`
- `"message_end"`: `(event: { message: Message }) => Promise<Message | void> | void`

### Streaming Deltas (`message_update`)
Fires continuously as tokens stream:
```typescript
pi.on("message_update", (event: MessageUpdateEvent) => {
  // event.message: current state of AssistantMessage
  // event.assistantMessageEvent: incremental delta from provider stream
});
```

### Distinguishing Text vs. Thinking vs. Tool Calls
`assistantMessageEvent` is typed as `AssistantMessageEvent` from `@earendil-works/pi-ai/dist/types.d.ts:563-605`:
```typescript
export type AssistantMessageEvent =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number }
  | { type: "toolcall_start"; contentIndex: number; toolCallId: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string } // partial JSON string
  | { type: "toolcall_end"; contentIndex: number };
```
Filter for TTS streaming:
```typescript
pi.on("message_update", ({ assistantMessageEvent }) => {
  if (assistantMessageEvent?.type === "text_delta") {
    const chunk = assistantMessageEvent.delta;
    elevenLabsTtsStream.write(chunk);
  }
});
```

---

## 5. Persistence, State & Lifecycle Cleanup

### Session Storage
- `pi.appendEntry(customType: string, data: unknown)`: persists non-context custom JSON object to active `.pi-session` log (`docs/session-format.md:40-60`).

### Global Extension Settings Persistence
- No dedicated `pi.storage` API exists in `ExtensionAPI`.
- Pi agent config directory helper: `pi.getAgentDir()` (resolves `~/.pi/agent`).
- Recommended persistence: write custom JSON/KV config to `~/.pi/agent/voice-config.json` or subpath under `pi.getAgentDir()`.

### Lifecycle Clean-Up
- `"session_start"`: setup mic audio stream, spawn ffmpeg listener, register timers.
- `"session_shutdown"`: kill child processes (`ffmpeg.kill()`), release audio handles.
- `ctx.signal`: `AbortSignal` passed into command/tool execution context; abort background ops when cancelled.

---

## 6. Terminal UI (TUI) Integration & Push-to-Talk

### Status Bar & Widgets (`ctx.ui`)
```typescript
// Status line footer icon/text
ctx.ui.setStatus("voice_status", "🎙️ Listening");
ctx.ui.setStatus("voice_status", undefined); // removes

// Multi-line widget above or below prompt
ctx.ui.setWidget("voice_transcript", ["Speaking: 'Hey Pi, check git status'"], "bottom");
```

### Push-to-Talk Shortcuts (`registerShortcut`)
`ExtensionAPI` exposes `registerShortcut` (`dist/core/extensions/types.d.ts:1145-1155`):
```typescript
pi.registerShortcut("ctrl+v", {
  description: "Toggle voice recording",
  handler: async (ctx) => {
    toggleVoiceRecording(ctx);
  }
});
```

---

## 7. Execution Restrictions & Mode Detection

### Checking Environment & UI Capabilities
```typescript
if (!ctx.hasUI) {
  // Running in RPC mode (`pi --mode rpc`) or print mode (`pi -p "query"`)
  // Do not show interactive pickers, dialogs, or widgets.
}
```
*(cite: `dist/core/extensions/types.d.ts:1401`)*

---

## 8. Local Environment Conventions

### User Extensions Directory (`~/.pi/agent/extensions/`)
- `disable-askclaude.ts`
- `disable-antigravity-websearch.ts`
- `llamacpp-schema-compat.ts`
- `review.ts`
- `suppress-startup-messages.ts`
- `tools-manager.ts`

### Example Existing User Extension (`disable-askclaude.ts`)
```typescript
// /Users/rhinesharar/.pi/agent/extensions/disable-askclaude.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Disables the AskClaude tool from pi-claude-bridge while keeping
 * the rest of that extension (models, provider) fully functional.
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    const all = pi.getAllTools();
    const filtered = all
      .map((t) => t.name)
      .filter((name) => name !== "AskClaude");
    pi.setActiveTools(filtered);
  });
}
```

---

## Architecture

```
[ Microphone Input ]
        │
        ▼ (ffmpeg / PCM capture)
[ Wake-word: 'hey Pi' ]
        │
        ▼
[ ElevenLabs STT ] ──────────────► pi.sendUserMessage(text, { deliverAs: "steer" })
                                                  │
                                                  ▼
                                            [ Agent Loop ]
                                                  │
                                                  ▼ (message_update text_delta)
[ ElevenLabs Streaming TTS ] ◄────────────────────┘
        │
        ▼ (ffplay stdout pipe)
   [ Speakers ]
```

---

## Start Here
Open `examples/extensions/send-user-message.ts` and `examples/extensions/status-line.ts` to inspect baseline message submission and footer UI wiring.