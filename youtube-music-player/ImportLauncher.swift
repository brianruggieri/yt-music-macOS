import Foundation

// ponytail: singleton trigger — menu command, nav interceptor, and ContentView all share this one publisher
final class ImportLauncher: ObservableObject {
    static let shared = ImportLauncher()
    private init() {}
    @Published var isPresented = false
}
