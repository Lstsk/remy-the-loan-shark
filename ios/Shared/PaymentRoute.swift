import Foundation

struct PaymentRoute: Equatable {
    var friendName: String
    var title: String
    var amount: Decimal

    static let sample = PaymentRoute(friendName: "Alex", title: "Dinner", amount: 28.67)

    init(friendName: String, title: String, amount: Decimal) {
        self.friendName = friendName
        self.title = title
        self.amount = amount
    }

    init(url: URL?) {
        guard let url,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            self = .sample
            return
        }

        let query = components.queryItems ?? []
        let friend = query.first(where: { $0.name == "friend" })?.value ?? "friend"
        let title = query.first(where: { $0.name == "title" })?.value ?? "Expense"
        let amountString = query.first(where: { $0.name == "amount" })?.value ?? "0"
        self.friendName = friend.capitalized
        self.title = title
        self.amount = Decimal(string: amountString) ?? 0
    }

    var formattedAmount: String {
        let number = NSDecimalNumber(decimal: amount)
        return NumberFormatter.currency.string(from: number) ?? "$\(number)"
    }
}

extension NumberFormatter {
    static let currency: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.maximumFractionDigits = 2
        return formatter
    }()
}
