import Foundation

enum Matcher {
	static func match(_ track: SpotifyTrack, candidates: [YTMCandidate]) -> MatchResult {
		guard !candidates.isEmpty else {
			return MatchResult(track: track, candidates: [], chosen: nil, confidence: .none)
		}

		let normTitle   = TextNormalize.stripSuffixes(track.title)
		let normArtist  = TextNormalize.normalize(track.artists.first ?? "")
		let trackAlbum  = track.album.map { TextNormalize.normalize($0) }

		struct Scored {
			let candidate: YTMCandidate
			let tier: Int        // 0=high, 1=low
			let albumMatch: Bool
			let durationDiff: Int
		}

		func score(_ c: YTMCandidate) -> Scored {
			let cTitle  = TextNormalize.stripSuffixes(c.title)
			let cArtist = TextNormalize.normalize(c.artists.first ?? "")
			let titleOK  = cTitle == normTitle
			let artistOK = cArtist == normArtist
			let durDiff  = c.durationMs.map { abs($0 - track.durationMs) } ?? Int.max
			let durOK    = durDiff <= 2000
			let albumMatch = c.album.map { TextNormalize.normalize($0) } == trackAlbum

			let tier: Int
			if c.resultType == .song && titleOK && artistOK && durOK {
				tier = 0 // high
			} else {
				tier = 1 // low
			}
			return Scored(candidate: c, tier: tier, albumMatch: albumMatch, durationDiff: durDiff)
		}

		let scored = candidates.map(score)

		// Best = lowest tier, then album match, then duration closeness
		let best = scored.min { a, b in
			if a.tier != b.tier { return a.tier < b.tier }
			if a.albumMatch != b.albumMatch { return a.albumMatch }
			return a.durationDiff < b.durationDiff
		}!

		let confidence: Confidence
		if best.tier == 0 {
			confidence = .high
		} else {
			confidence = .low
		}

		return MatchResult(track: track, candidates: candidates, chosen: best.candidate, confidence: confidence)
	}
}
