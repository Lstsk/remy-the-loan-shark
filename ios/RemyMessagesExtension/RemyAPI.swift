import Foundation

struct RemyAPI {
    private var baseURL: URL {
        let value = Bundle.main.object(forInfoDictionaryKey: "REMY_API_BASE_URL") as? String
        return URL(string: value ?? "http://127.0.0.1:8787")!
    }

    func saveContact(candidate: ContactCandidate) async throws {
        let url = baseURL.appending(path: "contacts")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(SaveContactPayload(
            displayName: candidate.displayName,
            alias: candidate.alias,
            phone: candidate.phone,
            imessageHandle: candidate.phone,
            source: "ios-contacts"
        ))

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }
}

private struct SaveContactPayload: Encodable {
    let displayName: String
    let alias: String
    let phone: String
    let imessageHandle: String
    let source: String
}
