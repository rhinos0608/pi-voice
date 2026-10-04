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
//   {"event":"ready","inputSampleRate":N,"voiceProcessing":bool}
//   {"event":"drained"} {"event":"stopped"}
//   {"event":"error","code":"permission"|"device"|"engine","message":S}
//   {"event":"route-change"}
//
// Compile: xcrun swiftc -O -o voice-io native/voice-io.swift

import AVFoundation
import CoreAudio
import Foundation

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
        guard let deviceID = inputDeviceID(named: name) else {
            events.emit(["event": "error", "code": "device", "message": "Input device not found: \(name)"])
            _exit(2)
        }
        guard let unit = input.audioUnit else {
            events.emit(["event": "error", "code": "device", "message": "Input audio unit unavailable"])
            _exit(2)
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
            events.emit(["event": "error", "code": "device", "message": "Failed to select input device \(name) (OSStatus \(status))"])
            _exit(2)
        }
    }

    var deviceName: String?

    func start() {
        if voiceProcessing {
            do {
                try input.setVoiceProcessingEnabled(true)
            } catch {
                emitError(code: "engine", message: "Failed to enable voice processing: \(error.localizedDescription)")
            }
        }
        if let name = deviceName {
            applyDevice(named: name)
        }
        if #available(macOS 13.0, *) {
            var duck = input.voiceProcessingOtherAudioDuckingConfiguration
            duck.enableAdvancedDucking = false
            duck.duckingLevel = .min
        }

        let hwFormat = input.outputFormat(forBus: 0)
        guard let target = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: kCaptureSampleRate, channels: 1, interleaved: true)
        else {
            emitError(code: "engine", message: "Failed to create capture format")
        }
        captureFormat = target

        engine.attach(player)
        // NOTE: the player is connected AFTER engine.start(). Connecting
        // anything to the mixer before start breaks VoiceProcessingIO
        // init (-10875 kAUInitialize on the output node). Audio rendered
        // through the engine post-start still feeds the AEC reference.

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
        engine.connect(player, to: engine.mainMixerNode, format: nil)
        playerFormat = player.outputFormat(forBus: 0)
        player.play()

        NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.handleRouteChange()
        }

        events.emit(["event": "ready", "inputSampleRate": Int(kCaptureSampleRate), "voiceProcessing": voiceProcessing])
    }

    private func handleTap(buffer: AVAudioPCMBuffer) {
        guard let target = captureFormat else { return }
        // Manual downmix: the VP tap can expose 9 channels, and
        // AVAudioConverter's default multichannel-to-mono map yields
        // silence. Average to mono float first, then resample/quantize.
        let channels = Int(buffer.format.channelCount)
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }
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
        let ratio = kCaptureSampleRate / max(mono.format.sampleRate, 1)
        let frames = AVAudioFrameCount(Double(n) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: frames) else { return }
        var supplied = false
        var error: NSError?
        let status: AVAudioConverterOutputStatus = conv.convert(to: out, error: &error) { _, outStatus in
            if supplied {
                outStatus.pointee = AVAudioConverterInputStatus.noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = AVAudioConverterInputStatus.haveData
            return mono
        }
        guard status != .error, out.frameLength > 0, let ptr = out.int16ChannelData else { return }
        let bytes = Data(bytes: ptr[0], count: Int(out.frameLength) * 2)
        try? stdoutHandle.write(contentsOf: bytes)
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

    func playPCM(_ data: Data) {
        guard !data.isEmpty else { return }
        let frames = data.count / 2
        guard frames > 0, let dst = playerFormat else { return }
        guard
            let srcFmt = AVAudioFormat(
                commonFormat: .pcmFormatInt16, sampleRate: kPlaybackSampleRate, channels: 1, interleaved: true),
            let inBuf = AVAudioPCMBuffer(pcmFormat: srcFmt, frameCapacity: AVAudioFrameCount(frames)),
            let inCh = inBuf.int16ChannelData
        else { return }
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
        else { return }
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
        guard status != .error, outBuf.frameLength > 0 else { return }
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
    }

    func finish() {
        state.lock()
        let empty = pendingBuffers <= 0
        if !empty { finishPending = true }
        state.unlock()
        if empty {
            events.emit(["event": "drained"])
        }
    }

    func stopPlayback() {
        state.lock()
        pendingBuffers = 0
        finishPending = false
        state.unlock()
        player.stop()
        player.reset()
        player.play()
        events.emit(["event": "stopped"])
    }

    private func handleRouteChange() {
        events.emit(["event": "route-change"])
        engine.stop()
        do {
            try engine.start()
            playerFormat = player.outputFormat(forBus: 0)
            if !player.isPlaying { player.play() }
        } catch {
            events.emit(["event": "error", "code": "engine", "message": "Engine restart failed: \(error.localizedDescription)"])
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
    fputs("usage: voice-io [--voice-processing on|off] [--input <name>] [--list-devices]\n", stderr)
}

private var argVoiceProcessing = true
private var argInput: String?
private var argListDevices = false

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

let vio = VoiceIo(voiceProcessing: argVoiceProcessing)
vio.deviceName = argInput
vio.start()
runControlLoop(vio)
