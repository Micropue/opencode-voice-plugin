import AVFoundation
import Foundation
import Network
import Speech

// JSONL protocol:
//   {"type":"hello","token":"..."}        (socket only)
//   {"type":"ready","locale":"zh-CN","onDevice":true}
//   {"type":"level","value":0.42}
//   {"type":"partial","text":"打开"}
//   {"type":"final","text":"打开项目"}
//   {"type":"error","code":"mic_denied","message":"..."}
//
// The app bundle is launched by the TUI plugin with --port/--token and writes
// JSONL to that local TCP socket. --selftest without --port writes to stdout.

var socketOutput: SocketOutput?
var outputIsSocket = false
var output: (([String: Any]) -> Void)?

func jsonData(_ fields: [String: Any]) -> Data? {
    guard JSONSerialization.isValidJSONObject(fields),
          let data = try? JSONSerialization.data(withJSONObject: fields) else { return nil }
    return data + Data([0x0A])
}

func emit(_ fields: [String: Any]) {
    if let output {
        output(fields)
        return
    }
    guard let data = jsonData(fields) else { return }
    FileHandle.standardOutput.write(data)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["type": "error", "code": code, "message": message])
    if outputIsSocket {
        Thread.sleep(forTimeInterval: 0.25)
    }
    exit(2)
}

struct Options {
    var locale = "zh-CN"
    var maxSeconds = 60.0
    var onDevice = true
    var allowNetwork = false
    var contextual: [String] = []
    var selftest = false
    var port: UInt16?
    var token: String?
}

func parseOptions() -> Options {
    var options = Options()
    var args = CommandLine.arguments.dropFirst()
    while let arg = args.popFirst() {
        switch arg {
        case "--locale":
            if let value = args.popFirst() { options.locale = value }
        case "--max-seconds":
            if let value = args.popFirst(), let number = Double(value), number > 0 { options.maxSeconds = number }
        case "--on-device":
            options.onDevice = true
        case "--no-on-device":
            options.onDevice = false
        case "--allow-network":
            options.allowNetwork = true
        case "--context":
            if let value = args.popFirst() {
                options.contextual = value.split(separator: ",").map(String.init).filter { !$0.isEmpty }
            }
        case "--port":
            if let value = args.popFirst(), let port = UInt16(value) { options.port = port }
        case "--token":
            if let value = args.popFirst() { options.token = value }
        case "--selftest":
            options.selftest = true
        default:
            break
        }
    }
    return options
}

func requestSpeechAuthorization() -> SFSpeechRecognizerAuthorizationStatus {
    var status = SFSpeechRecognizer.authorizationStatus()
    if status != .notDetermined { return status }
    let semaphore = DispatchSemaphore(value: 0)
    SFSpeechRecognizer.requestAuthorization { newStatus in
        status = newStatus
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 60)
    return status
}

func requestMicrophoneAccess() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return true
    case .denied, .restricted:
        return false
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            granted = ok
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 60)
        return granted
    @unknown default:
        return false
    }
}

final class SocketOutput {
    private let connection: NWConnection
    private let token: String
    private var buffer = Data()
    private var closed = false
    private var ready = false

    var onReady: (() -> Void)?
    var onCommand: ((String) -> Void)?
    var onClose: (() -> Void)?

    init(port: UInt16, token: String) {
        self.token = token
        self.connection = NWConnection(
            host: "127.0.0.1",
            port: NWEndpoint.Port(rawValue: port)!,
            using: .tcp
        )
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.ready = true
                self.send(["type": "hello", "token": self.token])
                self.onReady?()
                self.receive()
            case .failed, .cancelled:
                self.close()
            default:
                break
            }
        }
        connection.start(queue: .main)
    }

    func send(_ fields: [String: Any]) {
        guard ready, !closed, let data = jsonData(fields) else { return }
        connection.send(content: data, completion: .contentProcessed { _ in })
    }

    func stop() {
        guard !closed else { return }
        closed = true
        connection.cancel()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data {
                self.buffer.append(data)
                self.consume()
            }
            if isComplete || error != nil {
                self.close()
                return
            }
            if !self.closed { self.receive() }
        }
    }

    private func consume() {
        while let newline = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[..<newline]
            buffer.removeSubrange(...newline)
            guard let line = String(data: lineData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) else { continue }
            if line == "stop" || line == "cancel" {
                onCommand?(line)
            }
        }
    }

    private func close() {
        guard !closed else { return }
        closed = true
        connection.cancel()
        onClose?()
    }
}

final class VoiceRecognizer {
    private let options: Options
    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var lastPartial = ""
    private var finalEmitted = false
    private var stopping = false
    private var tapInstalled = false
    private var lastLevelAt = Date.distantPast
    private var timeout: DispatchWorkItem?

    init(options: Options) {
        self.options = options
    }

    func start() {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: options.locale)) else {
            fail("locale_unavailable", "Speech recognizer is unavailable for \(options.locale)")
        }
        guard recognizer.isAvailable else {
            fail("speech_unavailable", "Speech recognition is not available right now")
        }
        if options.onDevice && !recognizer.supportsOnDeviceRecognition && !options.allowNetwork {
            fail("on_device_unavailable", "On-device recognition is unavailable for \(options.locale); pass --allow-network to use Apple's server")
        }
        self.recognizer = recognizer

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if #available(macOS 13.0, *) {
            request.addsPunctuation = true
        }
        if !options.contextual.isEmpty {
            request.contextualStrings = options.contextual
        }
        if options.onDevice && recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("audio_unavailable", "No usable microphone input was found")
        }

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.request?.append(buffer)
            self.publishLevel(buffer)
        }
        tapInstalled = true

        engine.prepare()
        do {
            try engine.start()
        } catch {
            fail("audio_start_failed", error.localizedDescription)
        }

        emit([
            "type": "ready",
            "locale": options.locale,
            "onDevice": request.requiresOnDeviceRecognition,
        ])

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                if !text.isEmpty {
                    self.lastPartial = text
                    emit(["type": "partial", "text": text])
                }
                if result.isFinal {
                    self.finish(text)
                    return
                }
            }
            if let error, !self.stopping, !self.finalEmitted {
                emit(["type": "error", "code": "recognition_failed", "message": error.localizedDescription])
                self.cleanup()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { exit(2) }
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + options.maxSeconds) { [weak self] in
            self?.stop()
        }
    }

    private func publishLevel(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData?[0] else { return }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }

        var sum: Float = 0
        for index in 0..<count {
            let value = data[index]
            sum += value * value
        }
        let rms = sqrt(sum / Float(count))
        let decibels = 20 * log10(max(rms, 1e-7))
        let level = max(0, min(1, (decibels + 60) / 60))

        let now = Date()
        guard now.timeIntervalSince(lastLevelAt) >= 0.04 else { return }
        lastLevelAt = now
        emit(["type": "level", "value": Double(level)])
    }

    func stop() {
        guard !stopping, !finalEmitted else { return }
        stopping = true
        engine.stop()
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        request?.endAudio()

        let last = lastPartial
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.finalEmitted else { return }
            self.finish(last)
        }
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: work)
    }

    func cancel() {
        guard !finalEmitted else { return }
        finalEmitted = true
        timeout?.cancel()
        cleanup()
        socketOutput?.stop()
        exit(0)
    }

    private func finish(_ text: String) {
        guard !finalEmitted else { return }
        finalEmitted = true
        timeout?.cancel()
        cleanup()
        emit(["type": "final", "text": text])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            socketOutput?.stop()
            exit(0)
        }
    }

    private func cleanup() {
        engine.stop()
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        task?.cancel()
        task = nil
        request = nil
    }
}

func runSelfTest(port: UInt16?, token: String?) {
    let levels: [Double] = [0.1, 0.4, 0.8, 0.3, 0.0]
    if let port, let token {
        let socket = SocketOutput(port: port, token: token)
        socketOutput = socket
        output = { socket.send($0) }
        outputIsSocket = true
        socket.onReady = {
            for value in levels { emit(["type": "level", "value": value]) }
            emit(["type": "partial", "text": "打开项目"])
            emit(["type": "final", "text": "打开项目，看一下 git diff"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                socket.stop()
                exit(0)
            }
        }
        socket.start()
        dispatchMain()
    }

    emit(["type": "ready", "locale": "zh-CN", "onDevice": true, "selftest": true])
    for value in levels { emit(["type": "level", "value": value]) }
    emit(["type": "partial", "text": "打开项目"])
    emit(["type": "final", "text": "打开项目，看一下 git diff"])
    exit(0)
}

let options = parseOptions()

if options.selftest {
    runSelfTest(port: options.port, token: options.token)
}

let recognizer = VoiceRecognizer(options: options)

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

if let port = options.port, let token = options.token {
    let socket = SocketOutput(port: port, token: token)
    socketOutput = socket
    output = { socket.send($0) }
    outputIsSocket = true

    socket.onReady = {
        let speechStatus = requestSpeechAuthorization()
        switch speechStatus {
        case .authorized:
            break
        case .denied, .restricted:
            fail("speech_denied", "Speech recognition permission was denied. Enable it in System Settings > Privacy & Security > Speech Recognition.")
        case .notDetermined:
            fail("speech_denied", "Speech recognition permission was not granted.")
        @unknown default:
            fail("speech_denied", "Unknown speech recognition permission state.")
        }

        guard requestMicrophoneAccess() else {
            fail("mic_denied", "Microphone permission was denied. Enable it in System Settings > Privacy & Security > Microphone.")
        }
        recognizer.start()
    }

    socket.onCommand = { command in
        if command == "stop" {
            recognizer.stop()
        } else if command == "cancel" {
            recognizer.cancel()
        }
    }
    socket.onClose = {
        exit(0)
    }
    socket.start()

    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    interrupt.setEventHandler { recognizer.stop() }
    interrupt.resume()
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    terminate.setEventHandler { recognizer.stop() }
    terminate.resume()

    dispatchMain()
}

// CLI stdout mode: still useful for --selftest, but macOS TCC rejects Speech
// framework calls from a bare command-line binary without an app bundle.
let speechStatus = requestSpeechAuthorization()
switch speechStatus {
case .authorized:
    break
case .denied, .restricted:
    fail("speech_denied", "Speech recognition permission was denied. Enable it in System Settings > Privacy & Security > Speech Recognition.")
case .notDetermined:
    fail("speech_denied", "Speech recognition permission was not granted.")
@unknown default:
    fail("speech_denied", "Unknown speech recognition permission state.")
}

guard requestMicrophoneAccess() else {
    fail("mic_denied", "Microphone permission was denied. Enable it in System Settings > Privacy & Security > Microphone.")
}

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        let command = line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if command == "stop" || command == "end" {
            DispatchQueue.main.async { recognizer.stop() }
            break
        }
    }
}

recognizer.start()
dispatchMain()
