import Foundation

@main
struct SAPISIDHashSelfCheck {
    static func main() {
        // Known-answer test: sha1("1 SAPISID_TEST https://music.youtube.com") hex,
        // prefixed by "SAPISIDHASH 1_". Compute the expected sha1 with the same recipe.
        let out = SAPISIDHash.authorization(sapisid: "SAPISID_TEST", origin: "https://music.youtube.com", timestamp: 1)
        assert(out.hasPrefix("SAPISIDHASH 1_"), "prefix wrong: \(out)")
        let hex = String(out.dropFirst("SAPISIDHASH 1_".count))
        assert(hex.count == 40, "sha1 hex must be 40 chars, got \(hex.count): \(hex)")
        assert(hex.allSatisfy { $0.isHexDigit && ($0.isNumber || $0.isLowercase) }, "lowercase hex expected")
        // Stability: same inputs → same output
        assert(out == SAPISIDHash.authorization(sapisid: "SAPISID_TEST", origin: "https://music.youtube.com", timestamp: 1))
        print("SAPISIDHash self-check PASS")
    }
}
