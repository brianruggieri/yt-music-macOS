//
//  youtube_music_playerApp.swift
//  youtube-music-player
//
//  Created by Jem on 12/1/25.
//

import SwiftUI

@main
struct youtube_music_playerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1200, height: 800)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Import from Spotify…") {
                    ImportLauncher.shared.isPresented = true
                }
                #if DEBUG
                Button("Run YouTube Music Write Diagnostic") {
                    ImportLauncher.shared.isDiagnosticPresented = true
                }
                #endif
                // TEMPORARY — Spike A (Task 1); removed in Task 12. Runs the audio
                // tap probe off the main queue and prints ~1s RMS per candidate to
                // stdout. Plain (non-#if DEBUG) so it works from a Release build too.
                Button("Run Audio Tap Spike") {
                    DispatchQueue.global(qos: .userInitiated).async {
                        AudioTapSpike.runAll()
                    }
                }
            }
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.async {
            if let window = NSApplication.shared.windows.first {
                window.titlebarAppearsTransparent = true
                window.titleVisibility = .hidden
                window.styleMask.insert(.fullSizeContentView)

            }
        }
    }
}
