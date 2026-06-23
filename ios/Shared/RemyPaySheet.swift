import SwiftUI

struct RemyPaySheet: View {
    let route: PaymentRoute
    @State private var status: Status = .unpaid

    enum Status: String {
        case unpaid = "Unpaid"
        case paid = "Paid"
        case disputed = "Needs review"
    }

    var body: some View {
        ZStack {
            MeshGradient(
                width: 3,
                height: 3,
                points: [
                    [0, 0], [0.5, 0], [1, 0],
                    [0, 0.5], [0.55, 0.48], [1, 0.5],
                    [0, 1], [0.5, 1], [1, 1],
                ],
                colors: [
                    .white, .blue.opacity(0.18), .orange.opacity(0.18),
                    .mint.opacity(0.14), .white, .blue.opacity(0.12),
                    .white, .gray.opacity(0.12), .white,
                ]
            )
            .ignoresSafeArea()

            VStack {
                Spacer()
                sheet
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 10)
        }
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
                withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                    status = .paid
                }
            } label: {
                Label("I paid", systemImage: "checkmark.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)

            Button(role: .destructive) {
                withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                    status = .disputed
                }
            } label: {
                Label("This amount is wrong", systemImage: "exclamationmark.bubble.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }
}

#Preview {
    RemyPaySheet(route: .sample)
}
