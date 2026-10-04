// voice-io: single-process echo-cancelling audio helper for pi-voice.
//
// AVAudioEngine with voice processing enabled on the input node (AEC +
// noise suppression + AGC). Capture and playback live in this one process
// so AEC sees the playback reference.
//
// Capture: tap on inputNode at hardware format, AVAudioConverter to
// 16 kHz mono Int16, raw s16le written to stdout per tap callback.
//
// Playback: AVAudioPlayerNode attached to the same engine; PLAY payloads
// are 24 kHz mono s16le converted to the player format and scheduled.
//
// stdin control protocol: frames of
//   [1 byte type][4 bytes little-endian payload length][payload]
// Types: 0x01 PLAY, 0x02 FINISH, 0x03 STOP, 0x04 QUIT. EOF on stdin = QUIT.
//
// Events: JSON lines on file descriptor 3:
//   {"event":"ready","inputSampleRate":N,"voiceProcessing":bool,
//    "duckingLevel":N,"advancedDucking":bool}
//    (ducking keys: macOS 14+ with --voice-processing on only; they report
//    the applied configuration, so they are absent otherwise)
//   {"event":"drained"} {"event":"stopped"}
//   {"event":"error","code":"permission"|"device"|"engine","message":S}
//   {"event":"playback-error","code":"playback","message":S}
//     Playback-only failure: capture keeps running. The host reports it
//     to sink waiters (PLAY/FINISH) without touching the live source.
//   {"event":"route-change"}
//
// Compile: xcrun swiftc -O -o voice-io native/voice-io.swift

import AVFoundation
import CoreAudio
import Darwin
import Foundation

/// Ignore SIGPIPE so a broken stdout pipe surfaces as an EPIPE write error
/// instead of killing the process silently. Installed at startup before any
/// capture write can run.
_ = signal(SIGPIPE, SIG_IGN)

/// Best-effort fd3 error report for contexts (like the capture tap) where
/// taking EventSink's lock is unsafe. Uses raw write(2) and never throws.
private func emitRawError(code: String, message: String) {
    let line = "{\"event\":\"error\",\"code\":\"\(code)\",\"message\":\"\(message)\"}\n"
    line.withCString { ptr in
        var left = strlen(ptr)
        var cur = ptr
        while left > 0 {
            let n = write(3, cur, left)
            if n < 0 {
                if errno == EINTR { continue }
                return
            }
            if n == 0 { return }
            left -= n
            cur += n
        }
    }
}

/// Write capture bytes to stdout, detecting a broken pipe. On failure the
/// audio stream is gone, so report on fd 3 (best effort), stop the engine,
/// and exit non-zero instead of running on silently.
private func writeCaptureOrDie(engine: AVAudioEngine) -> Never {
    emitRawError(code: "engine", message: "stdout closed")
    engine.stop()
    _exit(3)
}

private func writeStdoutFully(_ data: Data, engine: AVAudioEngine) {
    let ok: Bool = data.withUnsafeBytes { raw in
        guard var cur = raw.baseAddress else { return true }
        var left = data.count
        while left > 0 {
            let n = write(STDOUT_FILENO, cur, left)
            if n < 0 {
                if errno == EINTR { continue }
                return false
            }
            if n == 0 { return false }
            left -= n
            cur += n
        }
        return true
    }
    if !ok {
        writeCaptureOrDie(engine: engine)
    }
}

private let kCaptureSampleRate: Double = 16000
private let kPlaybackSampleRate: Double = 24000

private enum FrameType: UInt8 {
    case play = 0x01
    case finish = 0x02
    case stop = 0x03
    case quit = 0x04
}

private final class EventSink {
    private let handle: FileHandle
    private let lock = NSLock()

    init() {
        handle = FileHandle(fileDescriptor: 3, closeOnDealloc: false)
    }

    func emit(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
            let line = String(data: data, encoding: .utf8)
        else { return }
        guard let out = (line + "\n").data(using: .utf8) else { return }
        lock.lock()
        defer { lock.unlock() }
        try? handle.write(contentsOf: out)
    }
}

private let events = EventSink()

private func emitError(code: String, message: String) -> Never {
    events.emit(["event": "error", "code": code, "message": message])
    _exit(2)
}

private func inputDeviceID(named name: String) -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else {
        return nil
    }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else {
        return nil
    }
    for id in ids {
        var nameAddr = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var cf: CFString? = nil
        var sz = UInt32(MemoryLayout<CFString?>.size)
        if AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &sz, &cf) == noErr,
            let cf
        {
            if (cf as String) == name {
                return id
            }
        }
    }
    return nil
}

private func listInputDeviceNames() -> [String] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else {
        return []
    }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else {
        return []
    }
    var names: [String] = []
    for id in ids {
        var streamsSize: UInt32 = 0
        var streamsAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        AudioObjectGetPropertyDataSize(id, &streamsAddr, 0, nil, &streamsSize)
        if streamsSize == 0 { continue }
        var nameAddr = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var cf: CFString? = nil
        var sz = UInt32(MemoryLayout<CFString?>.size)
        if AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &sz, &cf) == noErr, let cf {
            names.append(cf as String)
        }
    }
    return names
}

final class VoiceIo {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let input: AVAudioInputNode
    let voiceProcessing: Bool
    let stdoutHandle = FileHandle.standardOutput
    var captureFormat: AVAudioFormat?
    var playerFormat: AVAudioFormat?
    /// Serializes every engine/player mutation and every
    /// check-then-play sequence. AVAudioEngineConfigurationChange
    /// arrives on an arbitrary thread while PLAY frames are parsed
    /// on stdin's thread; without serialization a route change can
    /// pull the player's connection between the connected-check and
    /// play(), and play() on a disconnected player raises an
    /// uncaught NSException (SIGABRT), which Swift cannot catch.
    /// The capture tap never touches this queue (realtime thread).
    private let audioQueue = DispatchQueue(label: "voice-io.audio")
    let state = NSLock()
    var pendingBuffers = 0
    var finishPending = false
    var stopped = false

    init(voiceProcessing: Bool) {
        self.voiceProcessing = voiceProcessing
        input = engine.inputNode
    }

    /// Apply kAudioOutputUnitProperty_CurrentDevice to the input node's
    /// audio unit. Must run AFTER setVoiceProcessingEnabled (which swaps
    /// in the VoiceProcessingIO unit) and BEFORE prepare/start, or the set
    /// fails with -10849 kAudioUnitErr_Initialized. Device goes on the
    /// input bus (element 1); both buses are enabled first.
    private func applyDevice(named name: String) {
        if let message = selectInputDevice(input, named: name) {
            events.emit(["event": "error", "code": "device", "message": message])
            _exit(2)
        }
    }

    /// Shared device selection for the capture path and --probe-channels.
    /// Returns an error message, or nil on success.
    private func selectInputDevice(_ input: AVAudioInputNode, named name: String) -> String? {
    guard let deviceID = inputDeviceID(named: name) else {
        return "Input device not found: \(name)"
    }
    guard let unit = input.audioUnit else {
        return "Input audio unit unavailable"
    }
    var id = deviceID
    var enableIn: UInt32 = 1
    _ = AudioUnitSetProperty(
        unit,
        kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Input,
        1,
        &enableIn,
        UInt32(MemoryLayout<UInt32>.size))
    var enableOut: UInt32 = 1
    _ = AudioUnitSetProperty(
        unit,
        kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Output,
        0,
        &enableOut,
        UInt32(MemoryLayout<UInt32>.size))
    let status = AudioUnitSetProperty(
        unit,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        1,
        &id,
        UInt32(MemoryLayout<AudioDeviceID>.size))
    if status != noErr {
        return "Failed to select input device \(name) (OSStatus \(status))"
    }
    return nil
    }

    var deviceName: String?
    var agcEnabled = false
    var bypassEnabled = false

    func start() {
        if voiceProcessing {
            do {
                try input.setVoiceProcessingEnabled(true)
            } catch {
                emitError(code: "engine", message: "Failed to enable voice processing: \(error.localizedDescription)")
            }
            // AGC defaults ON in the VP unit; speaker embeddings want stable
            // levels, so default it off here (re-enable with --agc on).
            input.isVoiceProcessingAGCEnabled = agcEnabled
            // Bypass is diagnostic only (A/B processed vs raw on one helper).
            input.isVoiceProcessingBypassed = bypassEnabled
        }
        if let name = deviceName {
            applyDevice(named: name)
        }
        // Ducking must be configured after setVoiceProcessingEnabled(true)
        // swaps in the VoiceProcessingIO unit, and before prepare/start.
        // The property is a struct value type: mutate a copy and assign it
        // back, or the write is lost and default ducking stays in effect.
        // macOS 14+ per AVAudioIONode.h; older systems keep Apple defaults.
        if voiceProcessing {
            if #available(macOS 14.0, *) {
                var duck = input.voiceProcessingOtherAudioDuckingConfiguration
                duck.enableAdvancedDucking = false
                duck.duckingLevel = .min
                input.voiceProcessingOtherAudioDuckingConfiguration = duck
            }
        }

        let hwFormat = input.outputFormat(forBus: 0)
        guard let target = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: kCaptureSampleRate, channels: 1, interleaved: true)
        else {
            emitError(code: "engine", message: "Failed to create capture format")
        }
        captureFormat = target

        engine.attach(player)
        // NOTE: with voice processing the player is connected AFTER
        // engine.start(): connecting anything to the mixer before start
        // breaks VoiceProcessingIO init (-10875 kAUInitialize on the
        // output node). Audio rendered through the engine post-start
        // still feeds the AEC reference. Without voice processing the
        // reverse holds: an engine started with no output connections
        // never wires a player connected post-start, and play() then
        // raises an uncaught NSException, so connect before start.
        if !voiceProcessing {
            engine.connect(player, to: engine.mainMixerNode, format: nil)
        }

        input.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { [weak self] buffer, _ in
            self?.handleTap(buffer: buffer)
        }

        do {
            engine.prepare()
            try engine.start()
        } catch {
            let msg = error.localizedDescription
            if msg.localizedCaseInsensitiveContains("permission") || msg.localizedCaseInsensitiveContains("not permitted") {
                emitError(code: "permission", message: msg)
            } else {
                emitError(code: "engine", message: msg)
            }
        }

        NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.handleRouteChange()
        }

        // Capture is live once the engine runs with the tap installed, so
        // report ready immediately. The player is set up lazily and
        // asynchronously below: on some machines the output connection
        // is not ready the instant the engine starts, and that must never
        // fail capture. Playback problems surface as playback-error
        // events to PLAY/FINISH waiters only.
        // Read the ducking configuration back so the applied values are
        // observable on the event channel. duckingLevel/advancedDucking
        // are present only where the property exists (macOS 14+) AND voice
        // processing is enabled: below macOS 14, or with --voice-processing
        // off, the configuration above is never applied, so reporting it
        // would describe state that was never set.
        // level 10 is AVAudioVoiceProcessingOtherAudioDuckingLevelMin.
        var readyEvent: [String: Any] = [
            "event": "ready", "inputSampleRate": Int(kCaptureSampleRate), "voiceProcessing": voiceProcessing,
        ]
        if voiceProcessing {
            if #available(macOS 14.0, *) {
                let applied = input.voiceProcessingOtherAudioDuckingConfiguration
                readyEvent["duckingLevel"] = applied.duckingLevel.rawValue
                readyEvent["advancedDucking"] = applied.enableAdvancedDucking.boolValue
            }
        }
        events.emit(readyEvent)
        audioQueue.async { [weak self] in
            self?.setupPlayback()
        }
    }

    /// Bring the player online without blocking capture. Retries on a
    /// short delay because the output connection may not be ready the
    /// instant the engine starts, and again after configuration changes.
    /// Gives up silently: PLAY/FINISH report playback-error on demand.
    /// Must run on audioQueue.
    private func setupPlayback(attempt: Int = 0) {
        if ensurePlayerConnection() {
            playerFormat = player.outputFormat(forBus: 0)
            if safePlay() { return }
        }
        guard attempt < 20 else {
            fputs("voice-io: playback unavailable; capture continues\n", stderr)
            return
        }
        audioQueue.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self else { return }
            // The engine can still be settling after start; nudge it back
            // without touching the capture tap.
            if !self.engine.isRunning { try? self.engine.start() }
            self.setupPlayback(attempt: attempt + 1)
        }
    }

    /// Playback-only failure report. Never fatal: capture keeps running.
    private func emitPlaybackError() {
        events.emit([
            "event": "playback-error", "code": "playback",
            "message":
                "Playback unavailable: player has no output connection (engineRunning: \(engine.isRunning), connections: \(connectionCount())). Capture continues; check the output device.",
        ])
    }

    private func handleTap(buffer: AVAudioPCMBuffer) {
        guard let target = captureFormat else { return }
        // Channel strategy: with voice processing the tap exposes N channels
        // (9 on this hardware) where channel 0 is the processed voice and the
        // rest are raw/reference. Averaging ALL channels dilutes the voice
        // with unprocessed energy (the embedding inconsistency). Select
        // channel 0 via the converter's channelMap. Without VP, average a
        // plain multichannel tap to mono (legacy behavior).
        let channels = Int(buffer.format.channelCount)
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }
        if voiceProcessing && channels > 1 {
            let (conv, mapOK) = directConverter(from: buffer.format, to: target)
            if mapOK {
                streamConvert(buffer, conv: conv, engine: engine)
                return
            }
            // channelMap rejected: copy channel 0 to mono on the host.
            guard let ch0 = copyChannel(buffer, channel: 0) else { return }
            streamConvert(ch0, conv: monoConverter(from: ch0.format, to: target), engine: engine)
            return
        }
        let mono: AVAudioPCMBuffer
        if channels == 1 {
            mono = buffer
        } else {
            guard let srcCh = buffer.floatChannelData,
                let monoFmt = AVAudioFormat(
                    commonFormat: .pcmFormatFloat32, sampleRate: buffer.format.sampleRate,
                    channels: 1, interleaved: false),
                let mix = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: buffer.frameLength),
                let dst = mix.floatChannelData
            else { return }
            mix.frameLength = buffer.frameLength
            for i in 0 ..< n {
                var sum: Float = 0
                for c in 0 ..< channels { sum += srcCh[c][i] }
                dst[0][i] = sum / Float(max(channels, 1))
            }
            mono = mix
        }
        let conv = monoConverter(from: mono.format, to: target)
        streamConvert(mono, conv: conv, engine: engine)
    }

    /// Stream one tap buffer through a persistent converter, draining any
    /// leftover (`.inputRanDry`) instead of dropping it. The converter
    /// instance persists across tap buffers so SRC state carries over and no
    /// boundary frames are lost.
    private func streamConvert(_ source: AVAudioPCMBuffer, conv: AVAudioConverter, engine: AVAudioEngine) {
        guard let target = captureFormat else { return }
        let ratio = kCaptureSampleRate / max(source.format.sampleRate, 1)
        let frames = AVAudioFrameCount(Double(source.frameLength) * ratio) + 128
        var pending: AVAudioPCMBuffer? = source
        var status: AVAudioConverterOutputStatus = .haveData
        var iterations = 0
        while (status == .haveData || status == .inputRanDry) && iterations < 8 {
            iterations += 1
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: frames) else { return }
            var error: NSError?
            status = conv.convert(to: out, error: &error) { _, outStatus in
                if let p = pending {
                    pending = nil
                    outStatus.pointee = AVAudioConverterInputStatus.haveData
                    return p
                }
                outStatus.pointee = AVAudioConverterInputStatus.noDataNow
                return nil
            }
            guard status != .error, let ptr = out.int16ChannelData else { return }
            if out.frameLength > 0 {
                let bytes = Data(bytes: ptr[0], count: Int(out.frameLength) * 2)
                writeStdoutFully(bytes, engine: engine)
            }
        }
    }

    /// Direct tap-format converter with channelMap [0]: output mono is the
    /// processed voice channel. Falls back to a plain converter (plus
    /// host-side ch0 copy) if the map cannot be verified.
    private var cachedDirectConverter: (AVAudioConverter, AVAudioFormat, Bool)?

    private func directConverter(from: AVAudioFormat, to: AVAudioFormat) -> (AVAudioConverter, Bool) {
        if let (conv, fmt, ok) = cachedDirectConverter, fmt == from {
            return (conv, ok)
        }
        let conv = AVAudioConverter(from: from, to: to)!
        conv.channelMap = [0 as NSNumber]
        let ok = conv.channelMap.count == 1 && conv.channelMap[0].intValue == 0
        cachedDirectConverter = (conv, from, ok)
        if !ok {
            fputs("voice-io: channelMap [0] rejected, falling back to host ch0 copy\n", stderr)
        }
        return (conv, ok)
    }

    /// Host-side copy of one channel of a tap buffer into a mono buffer.
    private func copyChannel(_ buffer: AVAudioPCMBuffer, channel: Int) -> AVAudioPCMBuffer? {
        let n = Int(buffer.frameLength)
        guard n > 0, channel < Int(buffer.format.channelCount),
            let src = buffer.floatChannelData,
            let monoFmt = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: buffer.format.sampleRate,
                channels: 1, interleaved: false),
            let mono = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: buffer.frameLength),
            let dst = mono.floatChannelData
        else { return nil }
        mono.frameLength = buffer.frameLength
        memcpy(dst[0], src[channel], n * MemoryLayout<Float>.size)
        return mono
    }

    private var cachedMonoConverter: (AVAudioConverter, AVAudioFormat)?

    private func monoConverter(from: AVAudioFormat, to: AVAudioFormat) -> AVAudioConverter {
        if let (conv, fmt) = cachedMonoConverter, fmt == from {
            return conv
        }
        let conv = AVAudioConverter(from: from, to: to)!
        cachedMonoConverter = (conv, from)
        return conv
    }

    /// True when the player is attached and has at least one output
    /// connection in the engine. Must run on audioQueue.
    private func isPlayerConnected() -> Bool {
        guard player.engine != nil else { return false }
        return connectionCount() > 0
    }

    private func connectionCount() -> Int {
        guard player.engine != nil else { return 0 }
        return engine.outputConnectionPoints(for: player, outputBus: 0).count
    }

    /// Reconnect the player to the mixer when the engine is running.
    /// A connect issued while the engine is stopped leaves the player
    /// disconnected, so report false and let the caller surface an
    /// engine error instead of crashing in play(). Must run on audioQueue.
    @discardableResult
    private func ensurePlayerConnection() -> Bool {
        guard engine.isRunning else { return false }
        if !isPlayerConnected() {
            engine.connect(player, to: engine.mainMixerNode, format: nil)
        }
        return isPlayerConnected()
    }

    /// play() raises an uncaught ObjC exception (SIGABRT) unless the
    /// player is attached, connected, and the engine is running.
    /// Returns false instead of calling play() when that is not the
    /// case. Must run on audioQueue so a route change cannot pull the
    /// connection between the check and the call.
    @discardableResult
    private func safePlay() -> Bool {
        guard engine.isRunning, isPlayerConnected() else { return false }
        player.play()
        return true
    }

    func playPCM(_ data: Data) {
        guard !data.isEmpty else { return }
        let scheduled: Bool = audioQueue.sync {
            guard ensurePlayerConnection(), safePlay() else {
                emitPlaybackError()
                return false
            }
            guard scheduleLocked(data) else {
                emitPlaybackError()
                return false
            }
            return true
        }
        if !scheduled {
            // The engine may still have been settling; retry the player
            // connection in the background. Capture keeps running.
            audioQueue.async { [weak self] in
                self?.setupPlayback()
            }
        }
    }

    /// Convert 24 kHz mono s16le to the player format and schedule it.
    /// Must run on audioQueue (engine/player state is settled there).
    /// Returns false when the payload cannot be scheduled.
    private func scheduleLocked(_ data: Data) -> Bool {
        let frames = data.count / 2
        guard frames > 0, let dst = playerFormat else { return false }
        guard
            let srcFmt = AVAudioFormat(
                commonFormat: .pcmFormatInt16, sampleRate: kPlaybackSampleRate, channels: 1, interleaved: true),
            let inBuf = AVAudioPCMBuffer(pcmFormat: srcFmt, frameCapacity: AVAudioFrameCount(frames)),
            let inCh = inBuf.int16ChannelData
        else { return false }
        inBuf.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { raw in
            guard let s16 = raw.bindMemory(to: Int16.self).baseAddress else { return }
            for i in 0 ..< frames {
                inCh[0][i] = s16[i]
            }
        }
        let ratio = dst.sampleRate / kPlaybackSampleRate
        let cap = AVAudioFrameCount(Double(frames) * ratio) + 16
        guard
            let outBuf = AVAudioPCMBuffer(pcmFormat: dst, frameCapacity: cap),
            let conv = AVAudioConverter(from: srcFmt, to: dst)
        else { return false }
        var supplied = false
        var err: NSError?
        let status: AVAudioConverterOutputStatus = conv.convert(to: outBuf, error: &err) { _, s in
            if supplied {
                s.pointee = AVAudioConverterInputStatus.noDataNow
                return nil
            }
            supplied = true
            s.pointee = AVAudioConverterInputStatus.haveData
            return inBuf
        }
        guard status != .error, outBuf.frameLength > 0 else { return false }
        state.lock()
        pendingBuffers += 1
        state.unlock()
        player.scheduleBuffer(outBuf) { [weak self] in
            guard let self else { return }
            self.state.lock()
            self.pendingBuffers -= 1
            let done = self.finishPending && self.pendingBuffers <= 0
            if done { self.finishPending = false }
            self.state.unlock()
            if done {
                events.emit(["event": "drained"])
            }
        }
        return true
    }

    func finish() {
        state.lock()
        let empty = pendingBuffers <= 0
        if !empty { finishPending = true }
        state.unlock()
        if !empty { return }
        // Nothing queued: only claim drained when playback is actually
        // up. Otherwise fail this FINISH with a playback-only error so
        // the sink caller sees it, while capture keeps running.
        let ready: Bool = audioQueue.sync {
            ensurePlayerConnection() && playerFormat != nil
        }
        if ready {
            events.emit(["event": "drained"])
        } else {
            emitPlaybackError()
            audioQueue.async { [weak self] in
                self?.setupPlayback()
            }
        }
    }

    func stopPlayback() {
        state.lock()
        pendingBuffers = 0
        finishPending = false
        state.unlock()
        audioQueue.sync {
            player.stop()
            player.reset()
            // Best effort: the player stays stopped when the engine is
            // down; the next PLAY frame reconnects and resumes it.
            ensurePlayerConnection()
            safePlay()
        }
        events.emit(["event": "stopped"])
    }

    private func handleRouteChange() {
        events.emit(["event": "route-change"])
        // Async: engine.start() can block, and the notification must
        // not stall the posting thread. Blocks serialize on audioQueue,
        // so every play() below still follows its connected-check.
        audioQueue.async { [weak self] in
            guard let self else { return }
            self.engine.stop()
            do {
                try self.engine.start()
                // Reconnect the player after the restart: the engine
                // drops node connections across a configuration change.
                self.ensurePlayerConnection()
                self.playerFormat = self.player.outputFormat(forBus: 0)
                if !self.player.isPlaying { self.safePlay() }
            } catch {
                events.emit(["event": "error", "code": "engine", "message": "Engine restart failed: \(error.localizedDescription)"])
            }
        }
    }
}

private func readExactly(_ handle: FileHandle, count: Int) -> Data? {
    var out = Data()
    out.reserveCapacity(count)
    while out.count < count {
        guard let chunk = try? handle.read(upToCount: count - out.count), !chunk.isEmpty else {
            return out.isEmpty ? nil : out
        }
        out.append(chunk)
    }
    return out
}

private func runControlLoop(_ vio: VoiceIo) {
    let stdin = FileHandle.standardInput
    while true {
        guard let header = readExactly(stdin, count: 5) else {
            break // EOF on stdin = QUIT
        }
        let type = header[0]
        let len = UInt32(header[1]) | (UInt32(header[2]) << 8) | (UInt32(header[3]) << 16) | (UInt32(header[4]) << 24)
        var payload = Data()
        if len > 0 {
            guard let p = readExactly(stdin, count: Int(len)) else { break }
            payload = p
            if p.count < Int(len) { break }
        }
        switch type {
        case FrameType.play.rawValue:
            vio.playPCM(payload)
        case FrameType.finish.rawValue:
            vio.finish()
        case FrameType.stop.rawValue:
            vio.stopPlayback()
        case FrameType.quit.rawValue:
            vio.engine.stop()
            _exit(0)
        default:
            continue
        }
    }
    vio.engine.stop()
    _exit(0)
}

private func printUsage() {
    fputs("usage: voice-io [--voice-processing on|off] [--input <name>] [--list-devices] [--agc on|off] [--bypass on|off] [--probe-channels <seconds>]\n", stderr)
}

// MARK: - --probe-channels: raw-tap per-channel diagnostics.
//
// Records the untouched tap buffer for N seconds and prints one JSON object
// to stdout: per-channel RMS dBFS, peak, exact-zero fraction, Pearson
// correlation with channel 0, and lag of max normalized cross-correlation
// with channel 0, plus total frames vs wall-clock. Ambient room sound only;
// never plays audio. Exits 0 on success, 2 on setup failure.
private func runProbe(seconds: Double, voiceProcessing: Bool, deviceName: String?, agc: Bool, bypass: Bool) -> Never {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    if voiceProcessing {
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            fputs("voice-io: failed to enable voice processing: \(error.localizedDescription)\n", stderr)
            _exit(2)
        }
        input.isVoiceProcessingAGCEnabled = agc
        input.isVoiceProcessingBypassed = bypass
    }
    if let name = deviceName {
        guard let deviceID = inputDeviceID(named: name) else {
            fputs("voice-io: input device not found: \(name)\n", stderr)
            _exit(2)
        }
        guard let unit = input.audioUnit else {
            fputs("voice-io: input audio unit unavailable\n", stderr)
            _exit(2)
        }
        var id = deviceID
        var enableIn: UInt32 = 1
        _ = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &enableIn, UInt32(MemoryLayout<UInt32>.size))
        var enableOut: UInt32 = 1
        _ = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &enableOut, UInt32(MemoryLayout<UInt32>.size))
        let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 1, &id, UInt32(MemoryLayout<AudioDeviceID>.size))
        if status != noErr {
            fputs("voice-io: failed to select input device \(name) (OSStatus \(status))\n", stderr)
            _exit(2)
        }
    }
    let hw = input.outputFormat(forBus: 0)
    let channels = max(Int(hw.channelCount), 1)
    let rate = max(hw.sampleRate, 1)
    let lock = NSLock()
    var bufs = [[Float]](repeating: [], count: channels)
    var frames = 0
    input.installTap(onBus: 0, bufferSize: 4096, format: hw) { buffer, _ in
        let n = Int(buffer.frameLength)
        guard n > 0, let src = buffer.floatChannelData, Int(buffer.format.channelCount) == channels else { return }
        var chunk = [UnsafeBufferPointer<Float>]()
        chunk.reserveCapacity(channels)
        for c in 0 ..< channels { chunk.append(UnsafeBufferPointer(start: src[c], count: n)) }
        lock.lock()
        for c in 0 ..< channels { bufs[c].append(contentsOf: chunk[c]) }
        frames += n
        lock.unlock()
    }
    do {
        try engine.start()
    } catch {
        fputs("voice-io: engine start failed: \(error.localizedDescription)\n", stderr)
        _exit(2)
    }
    let wallStart = Date()
    Thread.sleep(forTimeInterval: seconds)
    let wall = Date().timeIntervalSince(wallStart)
    engine.stop()
    input.removeTap(onBus: 0)
    lock.lock()
    let snap = bufs
    let totalFrames = frames
    lock.unlock()

    let ref = snap[0]
    let prefix = min(48_000, totalFrames)
    var chanStats: [[String: Any]] = []
    for c in 0 ..< channels {
        let a = snap[c]
        var sumSq = 0.0
        var peak: Float = 0
        var zeros = 0
        for v in a {
            let d = Double(v)
            sumSq += d * d
            let av = abs(v)
            if av > peak { peak = av }
            if v == 0 { zeros += 1 }
        }
        let count = Double(max(a.count, 1))
        let rms = sqrt(sumSq / count)
        let db: Double = rms > 0 ? 20 * log10(rms) : -120
        var corr = 1.0
        if c > 0 {
            let m = min(a.count, ref.count)
            var sx = 0.0, sy = 0.0, sxx = 0.0, syy = 0.0, sxy = 0.0
            for i in 0 ..< m {
                let x = Double(ref[i]), y = Double(a[i])
                sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y
            }
            let md = Double(max(m, 1))
            let denom = sqrt(max((sxx - sx * sx / md) * (syy - sy * sy / md), 0))
            corr = denom > 0 ? (sxy - sx * sy / md) / denom : 0
        }
        var bestLag = 0
        var bestCorr = 0.0
        if c > 0 && prefix > 128 {
            var lag = -64
            while lag <= 64 {
                let lo = max(0, -lag)
                let hi = min(prefix, prefix - lag)
                var num = 0.0, exx = 0.0, eyy = 0.0
                var i = lo
                while i < hi {
                    let x = Double(ref[i]), y = Double(a[i + lag])
                    num += x * y; exx += x * x; eyy += y * y
                    i += 1
                }
                let den = sqrt(exx * eyy)
                let r = den > 0 ? num / den : 0
                if abs(r) > abs(bestCorr) { bestCorr = r; bestLag = lag }
                lag += 1
            }
        } else if c == 0 {
            bestCorr = 1.0
        }
        chanStats.append([
            "channel": c,
            "samples": a.count,
            "rmsDbfs": db,
            "peak": Double(peak),
            "zeroFraction": Double(zeros) / count,
            "corrWithCh0": corr,
            "bestLagSamples": bestLag,
            "bestLagCorr": bestCorr,
        ])
    }
    let report: [String: Any] = [
        "mode": "probe-channels",
        "voiceProcessing": voiceProcessing,
        "agc": agc,
        "bypass": bypass,
        "device": deviceName ?? "",
        "sampleRate": rate,
        "channels": channels,
        "requestedSeconds": seconds,
        "wallSeconds": wall,
        "totalFrames": totalFrames,
        "expectedFrames": Int(wall * rate),
        "framesPerSecond": Double(totalFrames) / max(wall, 1e-6),
        "channelStats": chanStats,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]),
        let s = String(data: data, encoding: .utf8) {
        print(s)
        fflush(stdout)
    } else {
        fputs("voice-io: failed to encode probe report\n", stderr)
        _exit(2)
    }
    _exit(0)
}

private var argVoiceProcessing = true
private var argInput: String?
private var argListDevices = false
private var argAgc = false
private var argBypass = false
private var argProbeSeconds: Double?

private var i = 1
while i < CommandLine.arguments.count {
    let a = CommandLine.arguments[i]
    switch a {
    case "--voice-processing":
        guard i + 1 < CommandLine.arguments.count else { printUsage(); _exit(2) }
        let v = CommandLine.arguments[i + 1]
        if v == "on" { argVoiceProcessing = true } else if v == "off" { argVoiceProcessing = false } else { printUsage(); _exit(2) }
        i += 2
    case "--input":
        guard i + 1 < CommandLine.arguments.count else { printUsage(); _exit(2) }
        argInput = CommandLine.arguments[i + 1]
        i += 2
    case "--list-devices":
        argListDevices = true
        i += 1
    case "--agc":
        guard i + 1 < CommandLine.arguments.count else { printUsage(); _exit(2) }
        let agcVal = CommandLine.arguments[i + 1]
        if agcVal == "on" { argAgc = true }
        else if agcVal == "off" { argAgc = false }
        else { printUsage(); _exit(2) }
        i += 2
    case "--bypass":
        guard i + 1 < CommandLine.arguments.count else { printUsage(); _exit(2) }
        let bypassVal = CommandLine.arguments[i + 1]
        if bypassVal == "on" { argBypass = true }
        else if bypassVal == "off" { argBypass = false }
        else { printUsage(); _exit(2) }
        i += 2
    case "--probe-channels":
        guard i + 1 < CommandLine.arguments.count, let probeSecs = Double(CommandLine.arguments[i + 1]), probeSecs > 0, probeSecs <= 30 else { printUsage(); _exit(2) }
        argProbeSeconds = probeSecs
        i += 2
    case "-h", "--help":
        printUsage()
        _exit(0)
    default:
        printUsage()
        _exit(2)
    }
}

if argListDevices {
    let names = listInputDeviceNames()
    if let data = try? JSONSerialization.data(withJSONObject: names),
        let s = String(data: data, encoding: .utf8)
    {
        print(s)
    } else {
        print("[]")
    }
    fflush(stdout)
    _exit(0)
}

/// Require microphone access before touching the engine. A fresh binary
/// has no TCC grant yet, so the first run prompts; denial (or a
/// restriction) is reported as a permission error, never worked around.
private func ensureRecordPermission() {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return
    case .denied, .restricted:
        events.emit(["event": "error", "code": "permission", "message": "Microphone access denied. Grant the terminal app Microphone access in System Settings > Privacy & Security > Microphone, then restart."])
        _exit(2)
    case .notDetermined:
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { g in
            granted = g
            sem.signal()
        }
        sem.wait()
        if !granted {
            events.emit(["event": "error", "code": "permission", "message": "Microphone access denied. Grant the terminal app Microphone access in System Settings > Privacy & Security > Microphone, then restart."])
            _exit(2)
        }
    @unknown default:
        return
    }
}

ensureRecordPermission()

if let secs = argProbeSeconds {
    runProbe(seconds: secs, voiceProcessing: argVoiceProcessing, deviceName: argInput, agc: argAgc, bypass: argBypass)
}

let vio = VoiceIo(voiceProcessing: argVoiceProcessing)
vio.deviceName = argInput
vio.agcEnabled = argAgc
vio.bypassEnabled = argBypass
vio.start()
runControlLoop(vio)
