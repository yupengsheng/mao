import Foundation
import Security

final class NativeTokenStore {
    static let shared = NativeTokenStore()
    private let service = "cn.yupengsheng.mao.app"
    private let accessKey = "accessToken"
    private let refreshKey = "refreshToken"

    var accessToken: String? { read(accessKey) }
    var refreshToken: String? { read(refreshKey) }

    func save(accessToken: String, refreshToken: String) {
        write(accessToken, key: accessKey)
        write(refreshToken, key: refreshKey)
    }

    func clear() {
        delete(accessKey)
        delete(refreshKey)
    }

    private func write(_ value: String, key: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(query as CFDictionary)
        let insert = query.merging([kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]) { _, new in new }
        SecItemAdd(insert as CFDictionary, nil)
    }

    private func read(_ key: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func delete(_ key: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(query as CFDictionary)
    }
}

@MainActor
final class NativeAPI {
    static let shared = NativeAPI()
    let baseURL = URL(string: "https://mao.yupengsheng.cn/api/v1")!
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var refreshTask: Task<String, Error>?

    init() {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        session = URLSession(configuration: configuration)
    }

    func login(username: String, password: String) async throws -> NativeAuthResponse {
        let response: NativeAuthResponse = try await request(path: "/auth/login", method: "POST", body: ["username": username, "password": password], authenticated: false)
        NativeTokenStore.shared.save(accessToken: response.accessToken, refreshToken: response.refreshToken)
        return response
    }

    func refresh() async throws -> String {
        if let refreshTask { return try await refreshTask.value }
        let task = Task<String, Error> {
            defer { refreshTask = nil }
            guard let refreshToken = NativeTokenStore.shared.refreshToken else {
                throw NativeError(message: "登录已过期，请重新登录", requiresLogin: true)
            }
            let response: NativeAuthResponse = try await request(path: "/auth/refresh", method: "POST", body: ["refreshToken": refreshToken], authenticated: false)
            NativeTokenStore.shared.save(accessToken: response.accessToken, refreshToken: response.refreshToken)
            return response.accessToken
        }
        refreshTask = task
        return try await task.value
    }

    func logout() async {
        _ = try? await requestVoid(path: "/auth/logout", method: "POST", authenticated: true)
        NativeTokenStore.shared.clear()
    }

    func loadGroups() async throws -> NativeSessionGroupsResponse {
        try await request(path: "/sessions/groups?previewLimit=5", method: "GET", authenticated: true)
    }

    func loadAgents() async throws -> [NativeAgent] {
        try await request(path: "/agents?scope=client", method: "GET", authenticated: true)
    }

    func loadModels() async throws -> [NativeModel] {
        try await request(path: "/models/active", method: "GET", authenticated: true)
    }

    func loadCloudProjects() async throws -> [NativeCloudProject] {
        try await request(path: "/sessions/cloud-projects", method: "GET", authenticated: true)
    }

    func loadMe() async throws -> NativeUser {
        try await request(path: "/users/me", method: "GET", authenticated: true)
    }

    func createSession(
        agentId: Int,
        modelId: Int?,
        workspaceMode: String,
        workspace: String?,
        cloudProjectKey: String?,
        gitCloneURL: String?
    ) async throws -> NativeSession {
        // 服务端目前的 SessionSource 没有 ios，web 是兼容的通用 CLOUD 客户端来源；
        // 不伪造 android，避免后续按来源统计时把 iOS 计入安卓。
        var body: [String: Any] = [
            "agentId": agentId,
            "executionMode": "CLOUD",
            "source": "web",
            "workspaceMode": workspaceMode
        ]
        if let modelId { body["modelId"] = modelId }
        if let workspace, !workspace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["workspace"] = workspace
        }
        if let cloudProjectKey, !cloudProjectKey.isEmpty, workspaceMode != "git" {
            body["cloudProjectKey"] = cloudProjectKey
        }
        if let gitCloneURL, !gitCloneURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, workspaceMode == "git" {
            body["gitCloneUrl"] = gitCloneURL.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return try await request(path: "/sessions", method: "POST", body: body, authenticated: true)
    }

    func updateSession(sessionId: Int, modelId: Int? = nil, agentId: Int? = nil) async throws -> NativeSession {
        var body: [String: Any] = [:]
        if let modelId { body["modelId"] = modelId }
        if let agentId { body["agentId"] = agentId }
        guard !body.isEmpty else {
            throw NativeError(message: "没有可更新的会话配置")
        }
        return try await request(path: "/sessions/\(sessionId)", method: "PATCH", body: body, authenticated: true)
    }

    func loadMessages(sessionId: Int) async throws -> NativeMessagesResponse {
        try await request(path: "/sessions/\(sessionId)/messages?roundLimit=20", method: "GET", authenticated: true)
    }

    private func request<T: Codable>(path: String, method: String, body: Any? = nil, authenticated: Bool) async throws -> T {
        let data = try await perform(path: path, method: method, body: body, authenticated: authenticated)
        let envelope = try decoder.decode(NativeAPIEnvelope<T>.self, from: data)
        guard envelope.code == 0 else { throw NativeError(message: envelope.message ?? "请求失败") }
        guard let value = envelope.data else { throw NativeError(message: "服务器返回为空") }
        return value
    }

    private func requestVoid(path: String, method: String, authenticated: Bool) async throws {
        let data = try await perform(path: path, method: method, body: nil, authenticated: authenticated)
        let envelope = try decoder.decode(NativeAPIEnvelope<EmptyResponse>.self, from: data)
        guard envelope.code == 0 else { throw NativeError(message: envelope.message ?? "请求失败") }
    }

    private func perform(path: String, method: String, body: Any?, authenticated: Bool) async throws -> Data {
        guard let url = URL(string: baseURL.absoluteString + path) else { throw NativeError(message: "请求地址无效") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if authenticated, let token = NativeTokenStore.shared.accessToken { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw NativeError(message: "网络响应无效") }
        if http.statusCode == 401, authenticated {
            _ = try await refresh()
            return try await perform(path: path, method: method, body: body, authenticated: authenticated)
        }
        if http.statusCode == 401, path == "/auth/refresh" {
            throw NativeError(message: "登录已过期，请重新登录", requiresLogin: true)
        }
        guard (200..<300).contains(http.statusCode) else {
            if let envelope = try? decoder.decode(NativeAPIEnvelope<EmptyResponse>.self, from: data), let message = envelope.message { throw NativeError(message: message) }
            throw NativeError(message: "网络请求失败（\(http.statusCode)）")
        }
        return data
    }
}

struct EmptyResponse: Codable {}
