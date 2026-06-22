import Contacts
import Messages
import SwiftUI

final class MessagesViewController: MSMessagesAppViewController {
    private let contactStore = CNContactStore()
    private lazy var model = ContactResolutionModel(contactStore: contactStore)
    private var host: UIHostingController<ContactResolutionView>?

    override func viewDidLoad() {
        super.viewDidLoad()
        installSwiftUIView()
    }

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        model.activeConversation = conversation
        model.loadPendingNames(from: conversation)
        model.refreshAuthorization()
    }

    private func installSwiftUIView() {
        let view = ContactResolutionView(model: model)
        let host = UIHostingController(rootView: view)
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        host.view.backgroundColor = .clear
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        self.host = host
    }
}
