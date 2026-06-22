import Contacts
import Foundation
import Messages

struct ContactCandidate: Identifiable, Hashable {
    let id: String
    let alias: String
    let displayName: String
    let phone: String
}

@MainActor
final class ContactResolutionModel: ObservableObject {
    @Published var authorizationStatus: CNAuthorizationStatus = CNContactStore.authorizationStatus(for: .contacts)
    @Published var pendingNames: [String] = []
    @Published var candidatesByName: [String: [ContactCandidate]] = [:]
    @Published var statusText: String = "Match friends from your contacts."

    var activeConversation: MSConversation?

    private let contactStore: CNContactStore
    private let api = RemyAPI()

    init(contactStore: CNContactStore) {
        self.contactStore = contactStore
    }

    func refreshAuthorization() {
        authorizationStatus = CNContactStore.authorizationStatus(for: .contacts)
        if authorizationStatus == .authorized || authorizationStatus == .limited {
            refreshCandidates()
        } else {
            statusText = "Tap a contact match. iOS will share only the person you choose."
        }
    }

    func requestFullContactsAccess() {
        authorizationStatus = CNContactStore.authorizationStatus(for: .contacts)
        guard authorizationStatus == .notDetermined else {
            refreshAuthorization()
            return
        }

        contactStore.requestAccess(for: .contacts) { [weak self] granted, _ in
            Task { @MainActor in
                guard let self else { return }
                self.authorizationStatus = granted ? .authorized : CNContactStore.authorizationStatus(for: .contacts)
                self.refreshCandidates()
            }
        }
    }

    func saveApprovedContactIdentifiers(_ identifiers: [String], alias: String) {
        guard !identifiers.isEmpty else { return }

        do {
            let contacts = try contactStore.unifiedContacts(
                matching: CNContact.predicateForContacts(withIdentifiers: identifiers),
                keysToFetch: contactKeys()
            )
            let candidates = contacts.flatMap { candidates(from: $0, alias: alias) }
            if let first = candidates.first {
                save(candidate: first)
            }
            refreshAuthorization()
        } catch {
            statusText = "Couldn’t read that contact yet."
        }
    }

    func loadPendingNames(from conversation: MSConversation) {
        let queryItems = conversation.selectedMessage?.url.flatMap {
            URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems
        } ?? []

        let namesValue = queryItems.first(where: { $0.name == "names" })?.value ?? ""
        pendingNames = namesValue
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        if pendingNames.isEmpty {
            pendingNames = ["James", "Boxiang"]
        }
    }

    func refreshCandidates() {
        guard authorizationStatus == .authorized || authorizationStatus == .limited else {
            statusText = "Tap a contact match. iOS will share only the person you choose."
            return
        }

        var next: [String: [ContactCandidate]] = [:]
        for name in pendingNames {
            next[name] = searchContacts(matching: name)
        }
        candidatesByName = next
        statusText = "Pick the right people once. Remy will remember."
    }

    func save(candidate: ContactCandidate) {
        Task {
            do {
                try await api.saveContact(candidate: candidate)
                statusText = "Saved \(candidate.displayName)."
            } catch {
                statusText = "Couldn’t save \(candidate.displayName). Check Remy is running."
            }
        }
    }

    private func searchContacts(matching name: String) -> [ContactCandidate] {
        do {
            let contacts = try contactStore.unifiedContacts(
                matching: CNContact.predicateForContacts(matchingName: name),
                keysToFetch: contactKeys()
            )

            return contacts.flatMap { candidates(from: $0, alias: name) }
        } catch {
            statusText = "Couldn’t search Contacts."
            return []
        }
    }

    private func contactKeys() -> [CNKeyDescriptor] {
        [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactNicknameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
        ]
    }

    private func candidates(from contact: CNContact, alias: String) -> [ContactCandidate] {
        let displayName = CNContactFormatter.string(from: contact, style: .fullName)
            ?? [contact.givenName, contact.familyName].filter { !$0.isEmpty }.joined(separator: " ")
        return contact.phoneNumbers.map { phone in
            ContactCandidate(
                id: "\(contact.identifier)-\(phone.value.stringValue)",
                alias: alias,
                displayName: displayName.isEmpty ? alias : displayName,
                phone: phone.value.stringValue
            )
        }
    }
}
