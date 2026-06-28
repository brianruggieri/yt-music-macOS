import Foundation

enum TextNormalize {
	/// Lowercase, strip diacritics, remove punctuation, collapse whitespace.
	static func normalize(_ s: String) -> String {
		let folded = s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
		let noPunct = folded.unicodeScalars.filter { scalar in
			let cat = scalar.properties.generalCategory
			return cat != .otherPunctuation &&
				cat != .openPunctuation &&
				cat != .closePunctuation &&
				cat != .dashPunctuation &&
				cat != .connectorPunctuation &&
				cat != .initialPunctuation &&
				cat != .finalPunctuation
		}
		let joined = String(String.UnicodeScalarView(noPunct))
		return joined.components(separatedBy: .whitespaces)
			.filter { !$0.isEmpty }
			.joined(separator: " ")
	}

	/// normalize() then strip parenthetical/bracket noise for comparison.
	static func stripSuffixes(_ s: String) -> String {
		// Remove (...) and [...] blocks containing noise keywords, then strip trailing noise like "- remaster"
		var result = s
		// ponytail: simple regex for the common noise patterns; add more patterns if needed
		let patterns = [
			"\\s*\\([^)]*\\)",          // any (...) block
			"\\s*\\[[^\\]]*\\]",        // any [...] block
			"(?i)\\s*-\\s*remaster\\w*", // "- remaster" / "- remastered"
			"(?i)\\s*-\\s*live\\b",      // "- live"
			"(?i)\\s*feat\\.?\\s+[^,]*", // "feat. ..." at end
		]
		for pattern in patterns {
			if let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) {
				let range = NSRange(result.startIndex..., in: result)
				result = regex.stringByReplacingMatches(in: result, range: range, withTemplate: "")
			}
		}
		return normalize(result.trimmingCharacters(in: .whitespaces))
	}
}
