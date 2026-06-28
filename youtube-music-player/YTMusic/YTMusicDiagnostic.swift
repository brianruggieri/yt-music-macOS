import Foundation

enum YTMusicDiagnosticError: Error, LocalizedError {
	case createFailed(Error)
	case addFailed(Error)
	case deleteFailed(Error)

	var errorDescription: String? {
		switch self {
		case .createFailed(let e): return "preflight create failed: \(e.localizedDescription)"
		case .addFailed(let e): return "preflight add failed: \(e.localizedDescription)"
		case .deleteFailed(let e): return "preflight delete failed: \(e.localizedDescription)"
		}
	}
}

enum YTMusicDiagnostic {
	// Rick Astley — Never Gonna Give You Up: stable since 2009, never removed, well-known music video
	// ponytail: replace with any stable video ID if this ever gets deleted
	static let preflightVideoID = "dQw4w9WgXcQ"

	/// Create a private playlist, add one video, then delete it.
	/// Returns .success only if all three steps succeed; .failure names the failing step.
	static func runWritePreflight(_ client: YTMusicClient) async -> Result<Void, Error> {
		let playlistId: String
		do {
			playlistId = try await client.createPlaylist(title: "_import-preflight", privacy: "PRIVATE")
		} catch {
			return .failure(YTMusicDiagnosticError.createFailed(error))
		}

		do {
			let result = try await client.addItems(playlistID: playlistId, videoIDs: [preflightVideoID])
			if !result.failed.isEmpty {
				throw YTMusicClientError.missingField("video \(preflightVideoID) not added")
			}
		} catch {
			try? await client.deletePlaylist(playlistId)  // best-effort cleanup
			return .failure(YTMusicDiagnosticError.addFailed(error))
		}

		do {
			try await client.deletePlaylist(playlistId)
		} catch {
			return .failure(YTMusicDiagnosticError.deleteFailed(error))
		}

		return .success(())
	}
}
