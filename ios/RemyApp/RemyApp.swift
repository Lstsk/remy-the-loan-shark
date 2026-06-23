import SwiftUI

@main
struct RemyApp: App {
    @State private var route = PaymentRoute.sample

    var body: some Scene {
        WindowGroup {
            RemyPaySheet(route: route)
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    route = PaymentRoute(url: activity.webpageURL)
                }
                .onOpenURL { url in
                    route = PaymentRoute(url: url)
                }
        }
    }
}
