import ContactsUI
import SwiftUI

struct ContactResolutionView: View {
    @ObservedObject var model: ContactResolutionModel

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                Text("Match contacts")
                    .font(.title2.bold())
                Text(model.statusText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                if model.authorizationStatus == .denied || model.authorizationStatus == .restricted {
                    Text("Contacts permission is off. Share a contact card in Messages and Remy can still remember them.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    List {
                        ForEach(model.pendingNames, id: \.self) { name in
                            Section("Which \(name)?") {
                                if model.authorizationStatus == .notDetermined || model.authorizationStatus == .limited {
                                    ContactAccessButton(
                                        queryString: name,
                                        ignoredEmails: nil,
                                        ignoredPhoneNumbers: nil
                                    ) { identifiers in
                                        model.saveApprovedContactIdentifiers(identifiers, alias: name)
                                    }
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(.primary)
                                    .tint(.blue)
                                }

                                let candidates = model.candidatesByName[name] ?? []
                                if candidates.isEmpty {
                                    Text("No matches yet")
                                        .foregroundStyle(.secondary)
                                } else {
                                    ForEach(candidates) { candidate in
                                        Button {
                                            model.save(candidate: candidate)
                                        } label: {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(candidate.displayName)
                                                    .font(.body.weight(.medium))
                                                Text(candidate.phone)
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .padding(.top, 12)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Refresh") {
                        model.refreshAuthorization()
                    }
                }
            }
        }
    }
}
