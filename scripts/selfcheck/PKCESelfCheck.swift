import Foundation

// ponytail: @main matches existing selfcheck pattern; -parse-as-library required for multi-file swiftc
@main struct PKCESelfCheck {
    static func main() {
        let v = PKCE.verifier()
        assert(v.count >= 43 && v.count <= 128, "verifier length \(v.count) out of range [43,128]")
        let c = PKCE.challenge(for: "dummyverifierdummyverifierdummyverifier12345")
        assert(!c.contains("=") && !c.contains("+") && !c.contains("/"), "must be base64url, got: \(c)")
        // Stability: same input → same output
        assert(c == PKCE.challenge(for: "dummyverifierdummyverifierdummyverifier12345"))
        print("PKCE self-check PASS")
    }
}
