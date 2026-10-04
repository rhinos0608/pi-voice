// tap-probe.swift — Hardware probe: Core Audio process tap reference stream.
//
// WHAT: Creates a stereo global process tap (macOS 14.2+:
// CATapDescription(stereoGlobalTapButExcludeProcesses:),
// AudioHardwareCreateProcessTap) exposed through a private aggregate device
// (kAudioAggregateDeviceTapListKey), then reads 10 s of audio and prints
// per-second RMS/peak dBFS, zero fraction, first-buffer latency, and format.
//
// WHY: pi-voice wants a reference stream of what other apps play (the Mac's
// speakers) so it can reject wake words coming from local playback. Research
// claims a bare CLI spawned from a terminal (bundle lacks
// NSAudioCaptureUsageDescription) only gets silent all-zero buffers because
// the tap needs kTCCServiceAudioCapture. This probe tests that claim.
//
// NO AUDIO IS WRITTEN TO DISK. Only aggregate statistics leave this process.
// Use --stats-file <path> so a .app-bundle launcher can collect the stats
// (stdout is invisible when launched via `open`).
//
// BUILD (do not run yet — running may trigger a permission prompt):
//   xcrun swiftc -O research/other-audio/tap-probe.swift -o /tmp/tap-probe
//
// RUN (owner, while playing a video at normal volume):
//   /tmp/tap-probe [--duration 10] [--stats-file /tmp/tap-stats.txt]
//
// EXIT: 0 on a completed 10 s capture (even if silent — silence is a result,
// printed as the verdict). Non-zero with a message on stderr for setup errors.

import CoreAudio
import Foundation

// MARK: - CLI args

var durationSeconds: Double = 10
var statsFilePath: String?

var argIndex = 1
while argIndex < CommandLine.argc {
    let arg = CommandLine.arguments[argIndex]
    if arg == "--duration", argIndex + 1 < CommandLine.argc {
        durationSeconds = Double(CommandLine.arguments[argIndex + 1]) ?? 10
        argIndex += 2
    } else if arg == "--stats-file", argIndex + 1 < CommandLine.argc {
        statsFilePath = CommandLine.arguments[argIndex + 1]
        argIndex += 2
    } else {
        fputs("tap-probe: unknown argument: \(arg)\n", stderr)
        fputs("usage: tap-probe [--duration SECONDS] [--stats-file PATH]\n", stderr)
        exit(2)
    }
}

func fail(_ message: String) -> Never {
    fputs("tap-probe ERROR: \(message)\n", stderr)
    exit(1)
}

func check(_ status: OSStatus, _ what: String) {
    if status != noErr {
        fail("\(what) failed (OSStatus \(status)). " +
            "If this mentions a missing entitlement, the process likely lacks " +
            "the kTCCServiceAudioCapture grant — that IS the result to report.")
    }
}

// MARK: - Stats collector (called on the HAL realtime thread)

final class StatsCollector: @unchecked Sendable {
    let lock = NSLock()
    var sumSquares: [Double]
    var peaks: [Double]
    var zeroSamples: [Int]
    var totalSamples: [Int]
    let bucketCount: Int
    var startedAt: DispatchTime = .now()
    var firstCallbackAt: DispatchTime?
    var callbacks = 0

    init(bucketCount: Int) {
        self.bucketCount = bucketCount
        self.sumSquares = Array(repeating: 0, count: bucketCount)
        self.peaks = Array(repeating: 0, count: bucketCount)
        self.zeroSamples = Array(repeating: 0, count: bucketCount)
        self.totalSamples = Array(repeating: 0, count: bucketCount)
    }

    func noteStart() {
        lock.lock()
        startedAt = .now()
        firstCallbackAt = nil
        callbacks = 0
        lock.unlock()
    }

    func add(samples: [Double]) {
        lock.lock()
        let now = DispatchTime.now()
        if firstCallbackAt == nil { firstCallbackAt = now }
        callbacks += 1
        let elapsed = Double(now.uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000_000
        let bucket = min(bucketCount - 1, max(0, Int(elapsed)))
        var ss = 0.0
        var peak = 0.0
        var zeros = 0
        for s in samples {
            ss += s * s
            let a = abs(s)
            if a > peak { peak = a }
            if s == 0.0 { zeros += 1 }
        }
        sumSquares[bucket] += ss
        if peak > peaks[bucket] { peaks[bucket] = peak }
        zeroSamples[bucket] += zeros
        totalSamples[bucket] += samples.count
        lock.unlock()
    }
}

// MARK: - Helpers

func defaultOutputDeviceUID() -> String {
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device)
    check(status, "get default output device")
    if device == kAudioObjectUnknown { fail("no default output device") }

    var uid: Unmanaged<CFString>? = nil
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    let uidStatus = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &uid)
    check(uidStatus, "get default output device UID")
    guard let uidValue = uid?.takeRetainedValue() else {
        fail("default output device has no UID")
    }
    return uidValue as String
}

func nominalSampleRate(of device: AudioObjectID) -> Double {
    var rate = 0.0
    var size = UInt32(MemoryLayout<Double>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    let status = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &rate)
    check(status, "get aggregate device sample rate")
    return rate
}

// Offset of mBuffers within AudioBufferList: one UInt32 (mNumberBuffers)
// precedes the variable-length AudioBuffer array.
let audioBufferArrayOffset = MemoryLayout<UInt32>.size

func audioBufferCount(_ list: UnsafeRawPointer) -> Int {
    Int(list.assumingMemoryBound(to: AudioBufferList.self).pointee.mNumberBuffers)
}

func audioBuffer(at list: UnsafeRawPointer, index: Int) -> AudioBuffer {
    list.advanced(by: audioBufferArrayOffset + index * MemoryLayout<AudioBuffer>.size)
        .assumingMemoryBound(to: AudioBuffer.self).pointee
}

func inputChannelCount(of device: AudioObjectID) -> Int {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size)
    check(status, "get stream configuration size")
    let bufferList = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 1)
    defer { bufferList.deallocate() }
    status = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, bufferList)
    check(status, "get stream configuration")
    let raw = UnsafeRawPointer(bufferList)
    var channels = 0
    for i in 0..<audioBufferCount(raw) {
        channels += Int(audioBuffer(at: raw, index: i).mNumberChannels)
    }
    return channels
}

// MARK: - Setup: tap + private aggregate device

// Empty exclusion list: the probe itself plays no audio, so there is nothing
// of its own to exclude. (Excluding self requires the caller's process object
// ID; irrelevant here.)
let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDescription.name = "PiVoiceTapProbe"

var tapID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateProcessTap(tapDescription, &tapID), "AudioHardwareCreateProcessTap")

let outputUID = defaultOutputDeviceUID()
let aggregateDescription: [String: Any] = [
    kAudioAggregateDeviceNameKey as String: "PiVoiceTapProbe",
    kAudioAggregateDeviceUIDKey as String: "local.pi-voice.tap-probe.aggregate",
    kAudioAggregateDeviceMainSubDeviceKey as String: outputUID,
    kAudioAggregateDeviceClockDeviceKey as String: outputUID,
    kAudioAggregateDeviceIsPrivateKey as String: 1,
    kAudioAggregateDeviceSubDeviceListKey as String: [
        [kAudioSubDeviceUIDKey as String: outputUID],
    ],
    kAudioAggregateDeviceTapListKey as String: [tapDescription.uuid.uuidString],
]

var aggregateDevice = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateDevice),
      "AudioHardwareCreateAggregateDevice")

let sampleRate = nominalSampleRate(of: aggregateDevice)
let channelCount = inputChannelCount(of: aggregateDevice)

// MARK: - Capture

let bucketCount = max(1, Int(durationSeconds.rounded(.up)))
let collector = StatsCollector(bucketCount: bucketCount)

var ioProcID: AudioDeviceIOProcID? = nil
let collectorRef = collector
let ioStatus = AudioDeviceCreateIOProcIDWithBlock(
    &ioProcID, aggregateDevice, nil,
    { _, inputData, _, outputData, _ in
        // Zero the output side so the probe never feeds audio back out.
        let outRaw = UnsafeMutableRawPointer(outputData)
        for i in 0..<audioBufferCount(UnsafeRawPointer(outputData)) {
            let outPtr = outRaw.advanced(by: audioBufferArrayOffset
                + i * MemoryLayout<AudioBuffer>.size)
                .assumingMemoryBound(to: AudioBuffer.self)
            if let ptr = outPtr.pointee.mData {
                memset(ptr, 0, Int(outPtr.pointee.mDataByteSize))
            }
        }
        // Taps deliver Float32 samples. Read each buffer generically.
        var samples: [Double] = []
        samples.reserveCapacity(4096)
        let inRaw = UnsafeRawPointer(inputData)
        for i in 0..<audioBufferCount(inRaw) {
            let buffer = audioBuffer(at: inRaw, index: i)
            guard let ptr = buffer.mData else { continue }
            let frameCount = Int(buffer.mDataByteSize) / MemoryLayout<Float32>.size
            let floats = ptr.bindMemory(to: Float32.self, capacity: frameCount)
            for f in 0..<frameCount {
                samples.append(Double(floats[f]))
            }
        }
        collectorRef.add(samples: samples)
    })
check(ioStatus, "AudioDeviceCreateIOProcIDWithBlock")
guard let ioProcID else { fail("AudioDeviceCreateIOProcIDWithBlock returned no proc") }

collector.noteStart()
check(AudioDeviceStart(aggregateDevice, ioProcID), "AudioDeviceStart (tap)")

Thread.sleep(forTimeInterval: durationSeconds)

check(AudioDeviceStop(aggregateDevice, ioProcID), "AudioDeviceStop")
check(AudioDeviceDestroyIOProcID(aggregateDevice, ioProcID), "AudioDeviceDestroyIOProcID")
check(AudioHardwareDestroyAggregateDevice(aggregateDevice), "AudioHardwareDestroyAggregateDevice")
check(AudioHardwareDestroyProcessTap(tapID), "AudioHardwareDestroyProcessTap")

// MARK: - Report

func dbFS(_ amplitude: Double) -> String {
    if amplitude <= 0 { return "-inf" }
    return String(format: "%.1f", 20 * log10(amplitude))
}

var lines: [String] = []
lines.append("tap-probe variant=bare-cli duration=\(durationSeconds)s")
lines.append(String(format: "format: %.0f Hz, %d ch (Float32 tap mix)", sampleRate, channelCount))

collector.lock.lock()
let firstLatencyMs: Double? = {
    guard let first = collector.firstCallbackAt else { return nil }
    let nanos = first.uptimeNanoseconds - collector.startedAt.uptimeNanoseconds
    return Double(nanos) / 1_000_000
}()
let callbacks = collector.callbacks
let sumSq = collector.sumSquares
let peaks = collector.peaks
let zeros = collector.zeroSamples
let totals = collector.totalSamples
collector.lock.unlock()

if let latency = firstLatencyMs {
    lines.append(String(format: "first-buffer-latency: %.1f ms (%d callbacks total)", latency, callbacks))
} else {
    lines.append("first-buffer-latency: NO CALLBACKS (tap delivered zero buffers)")
}
lines.append("sec rms_dBFS peak_dBFS zero_frac frames")
var grandZeros = 0
var grandTotal = 0
var secondsAboveMinus60 = 0
for sec in 0..<bucketCount {
    let n = totals[sec]
    grandZeros += zeros[sec]
    grandTotal += n
    if n == 0 {
        lines.append("\(sec) no-data no-data no-data 0")
        continue
    }
    let rms = sqrt(sumSq[sec] / Double(n))
    let rmsDb = dbFS(rms)
    if rms > 0, 20 * log10(rms) > -60 { secondsAboveMinus60 += 1 }
    let zeroFrac = Double(zeros[sec]) / Double(n)
    lines.append("\(sec) \(rmsDb) \(dbFS(peaks[sec])) \(String(format: "%.4f", zeroFrac)) \(n)")
}
let overallZeroFrac = grandTotal > 0 ? Double(grandZeros) / Double(grandTotal) : 1.0
if grandTotal == 0 || overallZeroFrac > 0.999 {
    lines.append("verdict: SILENT (all-zero buffers — consistent with missing " +
        "kTCCServiceAudioCapture grant for a bare CLI; see README)")
} else if secondsAboveMinus60 > 0 {
    lines.append("verdict: SIGNAL (\(secondsAboveMinus60)/\(bucketCount) s above -60 dBFS — " +
        "tap is delivering other-app audio)")
} else {
    lines.append("verdict: NEAR-SILENT (non-zero but below -60 dBFS — " +
        "check that a video was actually playing at normal volume)")
}

let report = lines.joined(separator: "\n") + "\n"
print(report, terminator: "")
if let path = statsFilePath {
    do {
        try report.write(toFile: path, atomically: true, encoding: .utf8)
    } catch {
        fail("could not write stats file \(path): \(error)")
    }
}
