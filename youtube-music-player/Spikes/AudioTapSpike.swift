//
//  AudioTapSpike.swift
//  youtube-music-player
//
//  TEMPORARY — Spike A (Task 1). Removed in Task 12.
//
//  WebKit decodes/plays YT Music audio in an out-of-process child (WebContent /
//  GPU), not this host PID, so a Core Audio process tap on the host alone may
//  capture silence. This spike stands up a minimal process tap against three
//  candidate targets and prints ~1s RMS for each so a human can read stdout and
//  pick the target that actually carries the music (nonzero on play, ~0 on pause).
//
//  API sequence mirrors insidegui/AudioCap (ProcessTap.swift / CoreAudioUtils.swift):
//    PID -> AudioObjectID via kAudioHardwarePropertyTranslatePIDToProcessObject
//    CATapDescription -> AudioHardwareCreateProcessTap
//    aggregate device (kAudioAggregateDeviceTapAutoStartKey: true,
//                      kAudioAggregateDeviceTapListKey -> kAudioSubTapUIDKey)
//    AudioDeviceCreateIOProcIDWithBlock -> AudioDeviceStart
//    teardown: Stop -> DestroyIOProcID -> DestroyAggregateDevice -> DestroyProcessTap
//
//  ponytail: throwaway diagnostic. Blocks its worker thread ~1s/candidate; runs
//  off the main queue (see the menu trigger) so the UI stays responsive.

import CoreAudio
import Foundation

enum AudioTapSpike {

    private struct SpikeError: Error, CustomStringConvertible {
        let description: String
        init(_ d: String) { description = d }
    }

    /// IOProc runs on a Core Audio realtime thread; the reader is on the worker
    /// thread that called `measureRMS`. A plain lock is fine for a 1s spike.
    /// ponytail: NSLock on the RT thread, acceptable for a throwaway measurement.
    private final class RMSAccumulator: @unchecked Sendable {
        private let lock = NSLock()
        private var sumSquares = 0.0
        private var count = 0
        func add(sumSquares s: Double, count c: Int) {
            lock.lock(); sumSquares += s; count += c; lock.unlock()
        }
        func rms() -> Double {
            lock.lock(); defer { lock.unlock() }
            return count > 0 ? (sumSquares / Double(count)).squareRoot() : 0
        }
    }

    private enum Target {
        case pids([pid_t])
        case systemOutput
    }

    /// Entry point wired to the temporary "Run Audio Tap Spike" menu command.
    /// Nonisolated so it can run on a background queue (keeps the UI responsive
    /// and lets the TCC prompt appear while we measure).
    nonisolated static func runAll() {
        print("===== AUDIO TAP SPIKE (Task 1 / Spike A) =====")
        guard #available(macOS 14.4, *) else {
            print("[spike] macOS 14.4+ required for Core Audio process taps; this OS is too old.")
            print("===== END SPIKE =====")
            return
        }

        let ownPID = ProcessInfo.processInfo.processIdentifier
        print("[spike] host app PID = \(ownPID)")

        // (i) own / host PID
        probe(name: "hostPID(\(ownPID))", target: .pids([ownPID]))

        // (ii) WebKit child processes (WebContent / GPU)
        let kids = webKitChildPIDs(of: ownPID)
        if kids.isEmpty {
            print("[spike] webkitChildPIDs -> none discovered (is a track loaded in the webview?)")
        } else {
            print("[spike] webkitChildPIDs -> \(kids)")
            probe(name: "webkitChildPIDs\(kids)", target: .pids(kids))
        }

        // (iii) system default output (global tap, no exclusions)
        probe(name: "systemOutput", target: .systemOutput)

        print("[spike] NOTE: nonzero only counts if it DROPS to ~0 when you PAUSE the track.")
        print("[spike] NOTE: first run may read ~0 if it triggered the Audio Capture prompt; grant it, then run again.")
        print("===== END SPIKE =====")
    }

    @available(macOS 14.4, *)
    private static func probe(name: String, target: Target) {
        do {
            let rms = try measureRMS(target: target, seconds: 1.0)
            print(String(format: "[spike] %-32@ RMS = %.6f", name as NSString, rms))
        } catch {
            print("[spike] \(name) -> ERROR: \(error)")
        }
    }

    @available(macOS 14.4, *)
    private static func measureRMS(target: Target, seconds: Double) throws -> Double {
        // 1. Tap description.
        let tapDescription: CATapDescription
        switch target {
        case .systemOutput:
            // Global tap, exclude nothing == whatever is hitting system output.
            tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        case .pids(let pids):
            let objects = try pids.map { try translatePIDToProcessObject($0) }
            tapDescription = CATapDescription(stereoMixdownOfProcesses: objects)
        }
        tapDescription.uuid = UUID()
        tapDescription.muteBehavior = .unmuted   // keep the music audible while measuring

        // 2. Create the process tap.
        var tapID = AudioObjectID(kAudioObjectUnknown)
        var err = AudioHardwareCreateProcessTap(tapDescription, &tapID)
        guard err == noErr, tapID != AudioObjectID(kAudioObjectUnknown) else {
            throw SpikeError("AudioHardwareCreateProcessTap failed: \(err)")
        }
        defer { AudioHardwareDestroyProcessTap(tapID) }

        // 3. Wrap the tap in a private auto-starting aggregate device.
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "MilkDropSpikeAggregate",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [
                [kAudioSubTapUIDKey: tapDescription.uuid.uuidString]
            ],
        ]
        var aggID = AudioObjectID(kAudioObjectUnknown)
        err = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggID)
        guard err == noErr, aggID != AudioObjectID(kAudioObjectUnknown) else {
            throw SpikeError("AudioHardwareCreateAggregateDevice failed: \(err)")
        }
        defer { AudioHardwareDestroyAggregateDevice(aggID) }

        // 4. IOProc: accumulate sum-of-squares over every Float32 sample it sees.
        let acc = RMSAccumulator()
        let ioBlock: AudioDeviceIOBlock = { _, inInputData, _, _, _ in
            let abl = UnsafeMutableAudioBufferListPointer(
                UnsafeMutablePointer(mutating: inInputData))
            for buffer in abl {
                guard let mData = buffer.mData else { continue }
                let n = Int(buffer.mDataByteSize) / MemoryLayout<Float32>.size
                let samples = mData.assumingMemoryBound(to: Float32.self)
                var s = 0.0
                for i in 0..<n {
                    let v = Double(samples[i])
                    s += v * v
                }
                acc.add(sumSquares: s, count: n)
            }
        }

        var procID: AudioDeviceIOProcID?
        err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil, ioBlock)
        guard err == noErr, let procID else {
            throw SpikeError("AudioDeviceCreateIOProcIDWithBlock failed: \(err)")
        }
        defer { AudioDeviceDestroyIOProcID(aggID, procID) }

        // 5. Run for ~`seconds`, then tear down (defers fire in reverse order).
        err = AudioDeviceStart(aggID, procID)
        guard err == noErr else { throw SpikeError("AudioDeviceStart failed: \(err)") }
        defer { AudioDeviceStop(aggID, procID) }

        Thread.sleep(forTimeInterval: seconds)
        return acc.rms()
    }

    /// Translate a Unix pid to a Core Audio process AudioObjectID.
    /// Mirrors AudioCap's translatePIDToProcessObjectID.
    @available(macOS 14.4, *)
    private static func translatePIDToProcessObject(_ pid: pid_t) throws -> AudioObjectID {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var qualifier = pid
        var objectID = AudioObjectID(kAudioObjectUnknown)
        var dataSize = UInt32(MemoryLayout<AudioObjectID>.size)
        let err = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            UInt32(MemoryLayout<pid_t>.size),
            &qualifier,
            &dataSize,
            &objectID)
        guard err == noErr else {
            throw SpikeError("TranslatePIDToProcessObject(\(pid)) failed: \(err)")
        }
        guard objectID != AudioObjectID(kAudioObjectUnknown) else {
            throw SpikeError("No audio process object for pid \(pid) (not producing audio?)")
        }
        return objectID
    }

    /// Best-effort discovery of the WebKit helper processes serving this app.
    ///
    /// WebContent/GPU helpers are XPC processes usually re-parented away from the
    /// app, so a direct `pgrep -P <pid>` won't find them. We snapshot every
    /// process (pid, ppid, executable path), keep the WebKit content/GPU helpers,
    /// and prefer those whose ancestry traces back to us; if none do (re-parented),
    /// fall back to all WebKit helpers and let the human sanity-check stdout.
    /// ponytail: shelling `ps` beats hand-rolling sysctl(KERN_PROC_ALL) for a spike.
    private static func webKitChildPIDs(of ownPID: pid_t) -> [pid_t] {
        guard let out = runPS() else { return [] }
        var ppidOf: [pid_t: pid_t] = [:]
        var commOf: [pid_t: String] = [:]
        for line in out.split(separator: "\n") {
            let parts = line.trimmingCharacters(in: .whitespaces)
                .split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
            guard parts.count >= 3, let pid = pid_t(parts[0]), let ppid = pid_t(parts[1])
            else { continue }
            ppidOf[pid] = ppid
            commOf[pid] = String(parts[2])
        }
        func tracesToOwn(_ pid: pid_t) -> Bool {
            var cur = pid, hops = 0
            while let p = ppidOf[cur], hops < 64 {
                if p == ownPID { return true }
                cur = p; hops += 1
            }
            return false
        }
        let webkit = commOf.compactMap { (pid, comm) -> pid_t? in
            comm.contains("com.apple.WebKit")
                && (comm.contains("WebContent") || comm.contains("GPU")) ? pid : nil
        }
        let descendants = webkit.filter(tracesToOwn)
        return (descendants.isEmpty ? webkit : descendants).sorted()
    }

    /// `ps -axo pid=,ppid=,comm=` -> "  1234  5678 /path/to/exe".
    private static func runPS() -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = ["-axo", "pid=,ppid=,comm="]
        let pipe = Pipe()
        p.standardOutput = pipe
        do {
            try p.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return String(data: data, encoding: .utf8)
        } catch {
            print("[spike] ps failed: \(error)")
            return nil
        }
    }
}
