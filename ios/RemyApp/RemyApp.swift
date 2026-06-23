import SwiftUI

@main
struct RemyApp: App {
    @State private var route = PaymentRoute.sample

    var body: some Scene {
        WindowGroup {
            RemyPaySheet(route: route)
                .onOpenURL { url in
                    route = PaymentRoute(url: url)
                }
        }
    }
}
