import SwiftUI

struct RemyPaySheet: View {
    let route: PaymentRoute
    @State private var status: Status = .unpaid
    @State private var isUpdating = false
    @State private var updateError: String?

    enum Status: String {
        case unpaid = "Unpaid"
        case paid = "Paid"
        case disputed = "Needs review"
    }

    var body: some View {
        ZStack {
            background

            VStack {
                Spacer()
                sheet
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 10)
        }
        .onChange(of: route) { _, _ in
            status = .unpaid
            updateError = nil
            isUpdating = false
        }
    }

    private var background: some View {
        LinearGradient(
            colors: [
                Color(uiColor: .systemBackground),
                Color(uiColor: .secondarySystemBackground),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .overlay(alignment: .topLeading) {
            Circle()
                .fill(.blue.opacity(0.16))
                .frame(width: 240, height: 240)
                .blur(radius: 36)
                .offset(x: -80, y: -90)
        }
        .overlay(alignment: .topTrailing) {
            Circle()
                .fill(.orange.opacity(0.16))
                .frame(width: 220, height: 220)
                .blur(radius: 34)
                .offset(x: 90, y: -70)
        }
        .ignoresSafeArea()
    }

    private var sheet: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(.secondary.opacity(0.32))
                .frame(width: 42, height: 5)
                .padding(.top, 10)
                .padding(.bottom, 8)

            VStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.black.gradient)
                    .frame(width: 58, height: 58)
                    .overlay {
                        Text("R")
                            .font(.system(size: 30, weight: .black, design: .rounded))
                            .foregroundStyle(.white)
                    }

                Text("Carson paid for \(route.title)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)

                Text(route.formattedAmount)
                    .font(.system(size: 56, weight: .bold, design: .rounded))
                    .contentTransition(.numericText())

                Text("\(route.friendName), this is your split. Receipt proof and everyone’s status stay visible here.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                statusPill
            }
            .padding(.bottom, 18)

            VStack(spacing: 12) {
                infoRows
                paymentActions
                if let updateError {
                    Text(updateError)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
                stateActions
            }
            .padding(14)

            Text("powered by Remy · get paid back without asking twice")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.bottom, 16)
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .stroke(.white.opacity(0.54), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.18), radius: 34, y: 18)
    }

    private var statusPill: some View {
        Text(status.rawValue)
            .font(.caption.weight(.bold))
            .foregroundStyle(status == .paid ? .green : status == .disputed ? .orange : .blue)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(.thinMaterial, in: Capsule())
    }

    private var infoRows: some View {
        VStack(spacing: 0) {
            row("Total", route.formattedAmount)
            Divider().padding(.leading, 14)
            row("Paid by", "Carson")
            Divider().padding(.leading, 14)
            row("Proof", "Receipt pending")
        }
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .fontWeight(.semibold)
        }
        .font(.subheadline)
        .padding(14)
    }

    private var paymentActions: some View {
        HStack(spacing: 10) {
            Link("Venmo", destination: URL(string: "venmo://paycharge?txn=pay&amount=\(route.amount)")!)
                .buttonStyle(.borderedProminent)
            Link("Cash App", destination: URL(string: "https://cash.app")!)
                .buttonStyle(.bordered)
            Link("PayPal", destination: URL(string: "https://paypal.com")!)
                .buttonStyle(.bordered)
        }
        .controlSize(.large)
    }

    private var stateActions: some View {
        VStack(spacing: 10) {
            Button {
                Task {
                    await updateStatus(.paid)
                }
            } label: {
                Label("I paid", systemImage: "checkmark.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(isUpdating)

            Button(role: .destructive) {
                Task {
                    await updateStatus(.disputed)
                }
            } label: {
                Label("This amount is wrong", systemImage: "exclamationmark.bubble.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(isUpdating)
        }
        .overlay {
            if isUpdating {
                ProgressView()
                    .controlSize(.small)
                    .padding(8)
                    .background(.regularMaterial, in: Capsule())
            }
        }
    }

    @MainActor
    private func updateStatus(_ nextStatus: Status) async {
        updateError = nil

        guard let requestId = route.requestId, !requestId.isEmpty else {
            withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                status = nextStatus
            }
            return
        }

        isUpdating = true
        defer { isUpdating = false }

        do {
            try await postStatus(nextStatus, requestId: requestId)
            withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                status = nextStatus
            }
        } catch {
            updateError = "Couldn’t update Remy yet. Try again."
        }
    }

    private func postStatus(_ nextStatus: Status, requestId: String) async throws {
        let path = nextStatus == .paid ? "/pay/paid" : "/pay/dispute"
        guard let url = URL(string: "https://trymomento.app\(path)") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let amount = NSDecimalNumber(decimal: route.amount).stringValue
        let fields = [
            "requestId": requestId,
            "friendName": route.friendName,
            "amount": amount,
        ]
        request.httpBody = fields
            .map { key, value in
                "\(urlEncode(key))=\(urlEncode(value))"
            }
            .joined(separator: "&")
            .data(using: .utf8)

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<400).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }

    private func urlEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}

#Preview {
    RemyPaySheet(route: .sample)
}
