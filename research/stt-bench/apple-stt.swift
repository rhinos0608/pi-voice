// apple-stt.swift — transcribe WAV files with macOS 26 SpeechAnalyzer.
// Usage:
//   apple-stt [--terms terms.json] file <transcribe|dictation|context> <wav> [<wav> ...]
//   apple-stt [--terms terms.json] rt   <transcribe|dictation|context> <wav> [<wav> ...]
// Emits one JSON object per line on stdout. stderr is for progress only.
// Build: xcrun swiftc -O apple-stt.swift -o apple-stt
import AVFoundation
import Foundation
import Speech

@available(macOS 26, *)
enum Bench {
    static var contextTerms: [String] = []
    static let locale = Locale(identifier: "en-US")

    static func makeContext(variant: String) -> AnalysisContext {
        let ctx = AnalysisContext()
        if variant == "context" {
            ctx.contextualStrings = [.general: contextTerms]
        }
        return ctx
    }

    static func ensureAssets(for modules: [any SpeechModule]) async throws -> String {
        var notes: [String] = []
        do {
            let reserved = try await AssetInventory.reserve(locale: locale)
            notes.append("reserve=\(reserved)")
        } catch {
            notes.append("reserve_error=\(String(describing: error))")
        }
        let st = await AssetInventory.status(forModules: modules)
        notes.append("status=\(String(describing: st))")
        if st != .installed {
            if let req = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                try await req.downloadAndInstall()
                notes.append("installed_after_download")
            } else {
                notes.append("no_installation_request")
            }
        }
        return notes.joined(separator: ";")
    }

    struct Outcome {
        var text: String = ""
        var wallS: Double = 0
        var eoaToFinalS: Double? = nil
        var nFinals: Int = 0
        var assetNotes: String = ""
    }

    static func plainText(_ a: AttributedString) -> String {
        String(a.characters)
    }

    static func drain<M: SpeechModule>(
        module: M, textOf: @Sendable @escaping (M.Result) -> String
    ) async throws -> (String, Int) {
        var last = ""
        var n = 0
        for try await r in module.results {
            if r.isFinal {
                n += 1
                last = textOf(r)
            } else if last.isEmpty {
                last = textOf(r)
            }
        }
        return (last, n)
    }

    // MARK: file mode — whole-file analysis via SpeechAnalyzer(inputAudioFile:)
    static func transcribeFile<M: SpeechModule>(
        path: String, variant: String, module: M, textOf: @Sendable @escaping (M.Result) -> String
    ) async throws -> Outcome {
        let t0 = Date()
        var out = Outcome()
        let url = URL(fileURLWithPath: path)
        let audioFile = try AVAudioFile(forReading: url)
        out.assetNotes = try await ensureAssets(for: [module])
        let analyzer = try await SpeechAnalyzer(
            inputAudioFile: audioFile, modules: [module],
            analysisContext: makeContext(variant: variant), finishAfterFile: true)
        let collect = Task { try await drain(module: module, textOf: textOf) }
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        let (text, n) = try await collect.value
        out.text = text
        out.nFinals = n
        out.wallS = Date().timeIntervalSince(t0)
        return out
    }

    // MARK: realtime mode — pace buffers in real time, measure end-of-audio -> final
    static func transcribeRealtime<M: SpeechModule>(
        path: String, variant: String, module: M, textOf: @Sendable @escaping (M.Result) -> String
    ) async throws -> Outcome {
        let t0 = Date()
        var out = Outcome()
        out.assetNotes = try await ensureAssets(for: [module])
        guard let fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            throw NSError(domain: "bench", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "no compatible audio format"])
        }
        let url = URL(fileURLWithPath: path)
        let audioFile = try AVAudioFile(forReading: url)
        let fileFormat = audioFile.processingFormat
        let chunkFrames: AVAudioFrameCount = 8000 // 0.5 s at 16 kHz
        var chunks: [AVAudioPCMBuffer] = []
        do {
            audioFile.framePosition = 0
            let total = AVAudioFrameCount(audioFile.length)
            guard let whole = AVAudioPCMBuffer(pcmFormat: fileFormat, frameCapacity: total) else {
                throw NSError(domain: "bench", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "buffer alloc failed"])
            }
            try audioFile.read(into: whole, frameCount: total)
            // slice into 0.5 s chunks (format-agnostic byte copy; corpus is mono)
            let bpf = Int(fileFormat.streamDescription.pointee.mBytesPerFrame)
            let per = Int(chunkFrames)
            let n = Int(whole.frameLength)
            let srcBase = whole.audioBufferList.pointee.mBuffers.mData!
            var off = 0
            while off < n {
                let len = min(per, n - off)
                guard let c = AVAudioPCMBuffer(pcmFormat: fileFormat, frameCapacity: AVAudioFrameCount(len)) else { break }
                c.frameLength = AVAudioFrameCount(len)
                memcpy(c.audioBufferList.pointee.mBuffers.mData!, srcBase.advanced(by: off * bpf), len * bpf)
                chunks.append(c)
                off += len
            }
        } catch {
            let ns = error as NSError
            throw error
        }
        let converter: AVAudioConverter? =
            (fileFormat == fmt) ? nil : AVAudioConverter(from: fileFormat, to: fmt)
        var continuation: AsyncStream<AnalyzerInput>.Continuation!
        let input = AsyncStream<AnalyzerInput> { continuation = $0 }
        let analyzer = SpeechAnalyzer(modules: [module])
        var lastFinalWall: Date? = nil
        let collect = Task { () -> (String, Int) in
            var last = ""
            var n = 0
            for try await r in module.results {
                if r.isFinal {
                    n += 1
                    last = textOf(r)
                    lastFinalWall = Date()
                } else if last.isEmpty {
                    last = textOf(r)
                }
            }
            return (last, n)
        }
        let analyzeTask = Task {
            try await analyzer.setContext(makeContext(variant: variant))
            try await analyzer.analyzeSequence(input)
        }
        var fedSamples: Int64 = 0
        let inRate = fmt.sampleRate
        let eoa: Date
        do {
            for buf in chunks {
                let fed: AVAudioPCMBuffer
                if let converter {
                    guard let outBuf = AVAudioPCMBuffer(
                        pcmFormat: fmt,
                        frameCapacity: AVAudioFrameCount(Double(buf.frameLength) * inRate / buf.format.sampleRate) + 16)
                    else { continue }
                    var err: NSError?
                    converter.convert(to: outBuf, error: &err) { _, outStatus in
                        outStatus.pointee = .haveData
                        return buf
                    }
                    if err != nil { continue }
                    fed = outBuf
                } else {
                    fed = buf
                }
                if fed.frameLength == 0 { continue }
                let durS = Double(fed.frameLength) / fed.format.sampleRate
                let t = CMTime(value: fedSamples, timescale: Int32(inRate))
                fedSamples += Int64(fed.frameLength)
                continuation.yield(AnalyzerInput(buffer: fed, bufferStartTime: t))
                try await Task.sleep(nanoseconds: UInt64(durS * 1_000_000_000))
            }
            eoa = Date()
            continuation.finish()
            _ = try await analyzeTask.value
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            let (text, n) = try await collect.value
            out.text = text
            out.nFinals = n
        } catch {
            continuation.finish()
            throw error
        }
        out.wallS = Date().timeIntervalSince(t0)
        if let lf = lastFinalWall {
            out.eoaToFinalS = lf.timeIntervalSince(eoa)
        }
        return out
    }

    static func runOne(mode: String, variant: String, path: String) async throws -> Outcome {
        if variant == "dictation" {
            let m = DictationTranscriber(locale: locale, preset: .shortDictation)
            let t: @Sendable (DictationTranscriber.Result) -> String = { plainText($0.text) }
            return try mode == "rt"
                ? await transcribeRealtime(path: path, variant: variant, module: m, textOf: t)
                : await transcribeFile(path: path, variant: variant, module: m, textOf: t)
        } else {
            let m = SpeechTranscriber(locale: locale, preset: .transcription)
            let t: @Sendable (SpeechTranscriber.Result) -> String = { plainText($0.text) }
            return try mode == "rt"
                ? await transcribeRealtime(path: path, variant: variant, module: m, textOf: t)
                : await transcribeFile(path: path, variant: variant, module: m, textOf: t)
        }
    }
}

@available(macOS 26, *)
func withTimeout<T: Sendable>(seconds: UInt64, op: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await op() }
        group.addTask {
            try await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            throw NSError(domain: "bench", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "timeout after \(seconds)s"])
        }
        let first = try await group.next()!
        group.cancelAll()
        return first
    }
}

@available(macOS 26, *)
func emit(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    }
}

@available(macOS 26, *)
func run() async {
    var args = CommandLine.arguments.dropFirst().map { $0 }
    if args.count >= 2, args[0] == "--terms" {
        let p = args[1]
        if let d = try? Data(contentsOf: URL(fileURLWithPath: p)),
           let arr = try? JSONSerialization.jsonObject(with: d) as? [String] {
            Bench.contextTerms = arr
        }
        args = Array(args.dropFirst(2))
    }
    guard args.count >= 3, (args[0] == "file" || args[0] == "rt"),
          ["transcribe", "dictation", "context"].contains(args[1])
    else {
        fputs("usage: apple-stt [--terms terms.json] <file|rt> <transcribe|dictation|context> <wav>...\n",
              stderr)
        exit(2)
    }
    let mode = args[0]
    let variant = args[1]
    for path in args.dropFirst(2) {
        do {
            let oc = try await withTimeout(seconds: 180) {
                try await Bench.runOne(mode: mode, variant: variant, path: path)
            }
            var d: [String: Any] = ["file": path, "mode": mode, "variant": variant,
                                    "text": oc.text, "wall_s": oc.wallS,
                                    "n_finals": oc.nFinals, "assets": oc.assetNotes]
            if let e = oc.eoaToFinalS { d["eoa_to_final_s"] = e }
            emit(d)
        } catch {
            let ns = error as NSError
            fputs("DEBUG type=\(type(of: error)) domain=\(ns.domain) code=\(ns.code) userInfo=\(ns.userInfo)\n", stderr)
            emit(["file": path, "mode": mode, "variant": variant,
                  "error": String(describing: error)])
        }
    }
}

if #available(macOS 26, *) {
    let sem = DispatchSemaphore(value: 0)
    Task { await run(); sem.signal() }
    sem.wait()
} else {
    fputs("requires macOS 26+\n", stderr)
    exit(3)
}
