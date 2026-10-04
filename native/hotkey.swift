// hotkey: global push-to-talk key listener via Carbon RegisterEventHotKey.
//
// No Accessibility/Input Monitoring permission is required: Carbon hotkeys
// deliver kEventHotKeyPressed/kEventHotKeyReleased to a registered target.
//
// Constraints (verified against CarbonEvents.h, Apple DTS thread 707680,
// sindresorhus/KeyboardShortcuts):
// - Register on the main thread and run NSApplication.shared.run() with
//   activation policy .prohibited (no dock icon, no windows). A bare
//   CFRunLoopRun does not dispatch Carbon hotkey targets.
// - Modifier-only keys (Fn, Right Option alone) cannot be registered; the
//   host validates combos before spawning this helper.
//
// CLI: hotkey --key <virtualKeyCode> --mods <carbonModifierMask>
// stdout line protocol: `ready`, `down`, `up`, `error <code> <message>`.
// `down` is emitted once per press (repeats while held are suppressed).
// stdin EOF ends the process with exit 0 so it never outlives Node.
//
// Compile: xcrun swiftc -O -o hotkey native/hotkey.swift

import Carbon
import Cocoa
import Foundation

private func printLine(_ s: String) {
    print(s)
    fflush(stdout)
}

private func fail(code: Int, message: String) -> Never {
    printLine("error \(code) \(message)")
    _exit(1)
}

private var argKey: UInt32?
private var argMods: UInt32?

private var i = 1
while i < CommandLine.arguments.count {
    let a = CommandLine.arguments[i]
    if a == "--key", i + 1 < CommandLine.arguments.count, let v = UInt32(CommandLine.arguments[i + 1]) {
        argKey = v
        i += 2
    } else if a == "--mods", i + 1 < CommandLine.arguments.count, let v = UInt32(CommandLine.arguments[i + 1]) {
        argMods = v
        i += 2
    } else if a == "-h" || a == "--help" {
        fputs("usage: hotkey --key <virtualKeyCode> --mods <carbonModifierMask>\n", stderr)
        _exit(0)
    } else {
        fputs("usage: hotkey --key <virtualKeyCode> --mods <carbonModifierMask>\n", stderr)
        _exit(2)
    }
}

guard let keyCode = argKey, let mods = argMods else {
    fputs("usage: hotkey --key <virtualKeyCode> --mods <carbonModifierMask>\n", stderr)
    _exit(2)
}

// Watch stdin on a background thread: EOF means the Node parent went away
// (or closed us), so exit promptly with 0.
Thread.detachNewThread {
    var buf = [UInt8](repeating: 0, count: 64)
    while true {
        let n = read(STDIN_FILENO, &buf, buf.count)
        if n <= 0 { _exit(0) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

var isDown = false

private func emitDown() {
    if !isDown {
        isDown = true
        printLine("down")
    }
}

private func emitUp() {
    if isDown {
        isDown = false
        printLine("up")
    } else {
        // Always report release even if the press predated registration.
        printLine("up")
    }
}

let handler: EventHandlerUPP = { _, event, _ in
    var hkID = EventHotKeyID()
    let err = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hkID
    )
    if err != noErr { return noErr }
    let kind = GetEventKind(event)
    if kind == UInt32(kEventHotKeyPressed) {
        emitDown()
    } else if kind == UInt32(kEventHotKeyReleased) {
        emitUp()
    }
    return noErr
}

var eventTypePressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
var eventTypeReleased = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))
var eventTypes = [eventTypePressed, eventTypeReleased]
var handlerRef: EventHandlerRef?
let installStatus = InstallEventHandler(
    GetApplicationEventTarget(),
    handler,
    2,
    &eventTypes,
    nil,
    &handlerRef
)
if installStatus != noErr {
    fail(code: Int(installStatus), message: "failed to install hotkey handler (\(installStatus))")
}

var hotKeyRef: EventHotKeyRef?
let hkID = EventHotKeyID(signature: OSType(0x5049564B), id: 1) // 'PIVK'
var mutableID = hkID
let regStatus = RegisterEventHotKey(keyCode, mods, mutableID, GetApplicationEventTarget(), 0, &hotKeyRef)
if regStatus != noErr {
    if regStatus == eventHotKeyExistsErr {
        fail(code: Int(regStatus), message: "combo already taken (\(regStatus))")
    }
    fail(code: Int(regStatus), message: "failed to register hotkey (\(regStatus))")
}

printLine("ready")
app.run()
