import Foundation

struct NativeUser: Codable, Identifiable, Equatable {
    let id: Int
    let username: String
    let displayName: String?
    let email: String?
    let avatarUrl: String?
}

struct NativeAuthResponse: Codable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int?
    let user: NativeUser
}

struct NativeSession: Codable, Identifiable, Equatable {
    let id: Int
    let agentId: Int?
    let agentName: String?
    var title: String?
    let status: String?
    let executionMode: String?
    let phase: String?
    let summary: String?
    let updatedAt: String?
    let createdAt: String?
    let running: Bool?
    let unread: Bool?
}

struct NativeSessionGroup: Codable, Identifiable {
    var id: String { key }
    let key: String
    let label: String
    let total: Int
    let hasMore: Bool
    let sessions: [NativeSession]
}

struct NativeSessionGroupsResponse: Codable {
    let groups: [NativeSessionGroup]
}

struct NativeAgent: Codable, Identifiable {
    let id: Int
    let name: String
    let clientVisible: Bool?
    let defaultModelId: Int?
}

struct NativeMessage: Codable, Identifiable, Equatable {
    let id: String
    let role: String
    var content: String
    let thinkingContent: String?
    let images: [String]?
    let createdAt: String?

    init(id: String, role: String, content: String, thinkingContent: String? = nil, images: [String]? = nil, createdAt: String? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.thinkingContent = thinkingContent
        self.images = images
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawId = try container.decode(AnyCodableString.self, forKey: .id)
        id = rawId.value
        role = try container.decodeIfPresent(String.self, forKey: .role) ?? "ASSISTANT"
        content = try container.decodeIfPresent(String.self, forKey: .content) ?? ""
        thinkingContent = try container.decodeIfPresent(String.self, forKey: .thinkingContent)
        images = try container.decodeIfPresent([String].self, forKey: .images)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
    }

    private enum CodingKeys: String, CodingKey { case id, role, content, thinkingContent, images, createdAt }
}

struct NativeMessagesResponse: Codable {
    let messages: [NativeMessage]
    let hasMore: Bool?
    let nextBeforeMessageId: Int?
}

struct NativeAPIEnvelope<T: Codable>: Codable {
    let code: Int
    let message: String?
    let data: T?
}

struct NativeError: LocalizedError {
    let message: String
    let requiresLogin: Bool

    init(message: String, requiresLogin: Bool = false) {
        self.message = message
        self.requiresLogin = requiresLogin
    }

    var errorDescription: String? { message }
}

struct AnyCodableString: Codable {
    let value: String

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            value = string
        } else if let int = try? container.decode(Int.self) {
            value = String(int)
        } else {
            throw DecodingError.typeMismatch(String.self, .init(codingPath: decoder.codingPath, debugDescription: "Expected string or integer"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }
}
