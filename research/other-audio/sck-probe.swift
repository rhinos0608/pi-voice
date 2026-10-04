// sck-probe.swift — Hardware probe: ScreenCaptureKit audio-only reference stream.
//
// WHAT: Captures 10 s of system audio via ScreenCaptureKit (SCStream with
// capturesAudio = true, excludesCurrentProcessAudio = true, audio-only
// output) and prints per-second RMS/peak dBFS, zero fraction, first-buffer
// latency, and format.
//
// WHY: pi-voice wants a reference stream of what other apps play so it can
// reject wake words coming from the Mac's speakers. Research claims SCK
// audio-only capture needs the "Screen & System Audio Recording" permission
// and shows ~50-150 ms latency. This probe tests that claim.
//
// NO AUDIO IS WRITTEN TO DISK. Only aggregate statistics leave this process.
// Running this WILL trigger a system permission prompt on first use — the
// owner must run it, not CI. See README.md.
//
// BUILD (do not run yet):
//   xcrun swiftc -O research/other-audio/sck-probe.swift -o /tmp/sck-probe
//   (links ScreenCaptureKit automatically via `import ScreenCaptureKit`)
//
// RUN (owner, while playing a video at normal volume):
//   /tmp/sck-probe [--duration 10]
//
// EXIT: 0 on a completed capture (even if silent — silence is a result).
// Non-zero with a message on stderr for setup errors.

import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - CLI args

var durationSeconds: Double = 10
var argIndex = 1
while argIndex < CommandLine.argc {
    let arg = CommandLine.arguments[argIndex]
    if arg == "--duration", argIndex + 1 < CommandLine.argc {
        durationSeconds = Double(CommandLine.arguments[argIndex + 1]) ?? 10
        argIndex += 2
    } else {
        fputs("sck-probe: unknown argument: \(arg)\n", stderr)
        fputs("usage: sck-probe [--duration SECONDS]\n", stderr)
        exit(2)
    }
}

func fail(_ message: String) -> Never {
    fputs("sck-probe ERROR: \(message)\n", stderr)
    exit(1)
}

// MARK: - Stats collector (called on the stream output queue)

final class StatsCollector: NSObject, SCStreamOutput, @unchecked Sendable {
    let lock = NSLock()
    var sumSquares: [Double]
    var peaks: [Double]
    var zeroSamples: [Int]
    var totalSamples: [Int]
    let bucketCount: Int
    var startedAt: DispatchTime = .now()
    var firstCallbackAt: DispatchTime?
    var audioCallbacks = 0
    var sampleRate: Double = 0
    var channelCount = 0

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
        audioCallbacks = 0
        lock.unlock()
    }

    // Synchronous snapshot so async report code never calls lock()/unlock()
    // directly (NSLock is unavailable from async contexts in Swift 6 mode).
    func snapshot() -> StatsSnapshot {
        lock.lock()
        defer { lock.unlock() }
        var snap = StatsSnapshot()
        if let first = firstCallbackAt {
            snap.firstLatencyMs =
                Double(first.uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000
        }
        snap.audioCallbacks = audioCallbacks
        snap.sumSquares = sumSquares
        snap.peaks = peaks
        snap.zeroSamples = zeroSamples
        snap.totalSamples = totalSamples
        return snap
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of outputType: SCStreamOutputType) {
        guard outputType == .audio else { return } // ignore video frames
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var length = 0
        var dataPointer: UnsafeMutablePointer<CChar>?
        let status = CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0,
                                                 lengthAtOffsetOut: nil,
                                                 totalLengthOut: &length,
                                                 dataPointerOut: &dataPointer)
        guard status == noErr, let ptr = dataPointer, length > 0 else { return }
        // SCK delivers Float32 non-interleaved? No: SCK audio is Float32
        // interleaved PCM for the configured channel count.
        let format = CMSampleBufferGetFormatDescription(sampleBuffer)
        var channels = 2
        if let format, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format) {
            channels = Int(asbd.pointee.mChannelsPerFrame)
        }
        let frameCount = length / (MemoryLayout<Float32>.size * max(1, channels))
        guard frameCount > 0 else { return }
        let floats = UnsafeRawPointer(ptr).bindMemory(to: Float32.self,
                                                      capacity: frameCount * max(1, channels))
        lock.lock()
        let now = DispatchTime.now()
        if firstCallbackAt == nil { firstCallbackAt = now }
        audioCallbacks += 1
        sampleRate = 48000
        channelCount = channels
        let elapsed = Double(now.uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000_000
        let bucket = min(bucketCount - 1, max(0, Int(elapsed)))
        var ss = 0.0
        var peak = 0.0
        var zeros = 0
        let total = frameCount * max(1, channels)
        for i in 0..<total {
            let s = Double(floats[i])
            ss += s * s
            let a = abs(s)
            if a > peak { peak = a }
            if s == 0.0 { zeros += 1 }
        }
        sumSquares[bucket] += ss
        if peak > peaks[bucket] { peaks[bucket] = peak }
        zeroSamples[bucket] += zeros
        totalSamples[bucket] += total
        lock.unlock()
        _ = status
    }
}

// MARK: - Capture (async entry; top-level await is allowed in swiftc main.swift-style files)

// NOTE: swiftc compiles this file as a main file, so top-level `await` works.
struct StatsSnapshot {
    var firstLatencyMs: Double?
    var audioCallbacks = 0
    var sumSquares: [Double] = []
    var peaks: [Double] = []
    var zeroSamples: [Int] = []
    var totalSamples: [Int] = []
}

@MainActor
func run() async {
    let bucketCount = max(1, Int(durationSeconds.rounded(.up)))
    let collector = StatsCollector(bucketCount: bucketCount)

    // Pick the main display; exclude our own windows (we have none, but be explicit).
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
        fail("SCShareableContent failed: \(error). " +
            "On first run this usually means the Screen Recording permission prompt " +
            "was denied or dismissed — see README.md.")
    }
    guard let display = content.displays.first else {
        fail("no displays found in SCShareableContent")
    }
    let filter = SCContentFilter(display: display, excludingWindows: [])

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.excludesCurrentProcessAudio = true
    // Keep video tiny: we only care about audio, but the stream still vends
    // video frames (ignored in the collector). Small size = cheap.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    config.sampleRate = 48000
    config.channelCount = 2

    let stream = SCStream(filter: filter, configuration: config, delegate: nil)
    do {
        try stream.addStreamOutput(collector, type: .audio,
                                   sampleHandlerQueue: DispatchQueue(label: "local.pi-voice.sck-probe.audio"))
    } catch {
        fail("addStreamOutput(.audio) failed: \(error). " +
            "A permission denial here means Screen & System Audio Recording was not granted.")
    }

    collector.noteStart()
    do {
        try await stream.startCapture()
    } catch {
        fail("startCapture failed: \(error). " +
            "If permission was just granted, wait a few seconds and run again.")
    }

    try? await Task.sleep(nanoseconds: UInt64(durationSeconds * 1_000_000_000))

    do {
        try await stream.stopCapture()
    } catch {
        fputs("sck-probe WARNING: stopCapture failed: \(error)\n", stderr)
    }

    // MARK: - Report

    func dbFS(_ amplitude: Double) -> String {
        if amplitude <= 0 { return "-inf" }
        return String(format: "%.1f", 20 * log10(amplitude))
    }

    var lines: [String] = []
    lines.append("sck-probe variant=sck-audio-only duration=\(durationSeconds)s")

    let snap = collector.snapshot()
    let firstLatencyMs = snap.firstLatencyMs
    let callbacks = snap.audioCallbacks
    let sumSq = snap.sumSquares
    let peaks = snap.peaks
    let zeros = snap.zeroSamples
    let totals = snap.totalSamples

    lines.append("format: 48000 Hz, 2 ch (Float32 interleaved, as requested)")
    if let latency = firstLatencyMs {
        lines.append(String(format: "first-buffer-latency: %.1f ms (%d audio callbacks total)",
                            latency, callbacks))
    } else {
        lines.append("first-buffer-latency: NO AUDIO CALLBACKS (check permission + playback)")
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
        if rms > 0, 20 * log10(rms) > -60 { secondsAboveMinus60 += 1 }
        let zeroFrac = Double(zeros[sec]) / Double(n)
        lines.append("\(sec) \(dbFS(rms)) \(dbFS(peaks[sec])) \(String(format: "%.4f", zeroFrac)) \(n)")
    }
    let overallZeroFrac = grandTotal > 0 ? Double(grandZeros) / Double(grandTotal) : 1.0
    if grandTotal == 0 || overallZeroFrac > 0.999 {
        lines.append("verdict: SILENT (no system-audio signal — either permission missing " +
            "or nothing was playing; re-check README order)")
    } else if secondsAboveMinus60 > 0 {
        lines.append("verdict: SIGNAL (\(secondsAboveMinus60)/\(bucketCount) s above -60 dBFS — " +
            "SCK is delivering other-app audio)")
    } else {
        lines.append("verdict: NEAR-SILENT (non-zero but below -60 dBFS — " +
            "check that a video was actually playing at normal volume)")
    }
    print(lines.joined(separator: "\n"))
}

await run()
