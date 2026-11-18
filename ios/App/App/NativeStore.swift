import Foundation
import SwiftUI

@MainActor
final class NativeStore: ObservableObject {
    @Published var user: NativeUser?
    @Published var groups: [NativeSessionGroup] = []
    @Published var selectedSession: NativeSession?
    @Published var messages: [NativeMessage] = []
    @Published var isLoading = false
    @Published var isLoadingMessages = false
    @Published var isSending = false
    @Published var isConnected = false
    @Published var errorMessage: String?
    @Published var composerText = ""

    private let api = NativeAPI.shared
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var subscribedSessionId: Int?
    private var streamingAssistantId: String?
    private var reconnectTask: Task<Void, Never>?
    private var terminalRefreshTask: Task<Void, Never>?
    private var reconnectDelay: UInt64 = 1_000_000_000
    private var didRestore = false
    private var pendingUserMessageIds: [String: String] = [:]

    init() {
        Task { await restore() }
    }

    var allSessions: [NativeSession] {
        groups.flatMap(\.sessions)
    }

    func restore() async {
        guard !didRestore else { return }
        didRestore = true
        guard NativeTokenStore.shared.accessToken != nil else { return }
        do {
            user = try await api.loadMe()
            try await loadGroups()
            connect()
        } catch {
            if let nativeError = error as? NativeError, nativeError.requiresLogin {
                NativeTokenStore.shared.clear()
                user = nil
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    func login(username: String, password: String) async {
        isLoading = true
        errorMessage = nil
        do {
            let response = try await api.login(username: username, password: password)
            user = response.user
            try await loadGroups()
            connect()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func logout() async {
        receiveTask?.cancel()
        reconnectTask?.cancel()
        terminalRefreshTask?.cancel()
        reconnectTask = nil
        terminalRefreshTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        isConnected = false
        await api.logout()
        groups = []
        messages = []
        selectedSession = nil
        user = nil
        pendingUserMessageIds.removeAll()
    }

    func loadGroups() async throws {
        groups = try await api.loadGroups().groups
    }

    func selectSession(_ session: NativeSession) {
        let previousSessionId = subscribedSessionId
        subscribedSessionId = nil
        selectedSession = session
        composerText = ""
        Task { await loadMessages(for: session) }
        if let previousSessionId, previousSessionId != session.id {
            Task { try? await sendSocket(type: "unsubscribe", sessionId: previousSessionId) }
        }
        subscribe(to: session.id)
    }

    func startNewChat() {
        let previousSessionId = subscribedSessionId
        subscribedSessionId = nil
        selectedSession = nil
        messages = []
        composerText = ""
        if let previousSessionId {
            Task { try? await sendSocket(type: "unsubscribe", sessionId: previousSessionId) }
        }
    }

    func sendComposer() {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        composerText = ""
        isSending = true
        Task { await send(text: text) }
    }

    func retryConnection() {
        if !isConnected {
            socket?.cancel(with: .goingAway, reason: nil)
            socket = nil
            subscribedSessionId = nil
        }
        connect()
    }

    private func loadMessages(for session: NativeSession) async {
        isLoadingMessages = true
        errorMessage = nil
        do {
            let response = try await api.loadMessages(sessionId: session.id)
            messages = response.messages
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingMessages = false
    }

    private func send(text: String) async {
        errorMessage = nil
        do {
            if selectedSession == nil {
                let agents = try await api.loadAgents()
                guard let agent = agents.first(where: { $0.clientVisible != false }) ?? agents.first else {
                    throw NativeError(message: "暂无可用 Agent")
                }
                let session = try await api.createSession(agentId: agent.id)
                selectedSession = session
                groups = try await api.loadGroups().groups
                subscribe(to: session.id)
            }
            guard let sessionId = selectedSession?.id else { throw NativeError(message: "会话创建失败") }
            try await waitForConnection()
            let eventId = UUID().uuidString
            let localMessageId = "local-\(eventId)"
            let userMessage = NativeMessage(id: localMessageId, role: "USER", content: text, createdAt: ISO8601DateFormatter().string(from: Date()))
            pendingUserMessageIds[eventId] = localMessageId
            messages.append(userMessage)
            do {
                try await sendSocket(type: "send_message", sessionId: sessionId, data: ["content": text, "eventId": eventId, "images": []])
            } catch {
                pendingUserMessageIds.removeValue(forKey: eventId)
                messages.removeAll { $0.id == localMessageId }
                throw error
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isSending = false
    }

    private func connect() {
        guard socket == nil, let token = NativeTokenStore.shared.accessToken,
              let url = URL(string: "wss://mao.yupengsheng.cn/api/ws/stream?client=browser") else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        task.resume()
        Task {
            do {
                // auth 是服务端约定的根级帧字段；业务 payload 才放在 data 中。
                try await sendSocket(
                    type: "auth",
                    rootFields: ["token": token, "client": "browser", "pageEnabled": false]
                )
                await receiveLoop()
            } catch {
                await MainActor.run {
                    self.isConnected = false
                    self.socket = nil
                    self.subscribedSessionId = nil
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func receiveLoop() async {
        guard let socket else { return }
        do {
            while !Task.isCancelled {
                let message = try await socket.receive()
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let value): data = value
                @unknown default: continue
                }
                await handleSocketData(data)
            }
        } catch {
            await MainActor.run {
                self.isConnected = false
                self.socket = nil
                self.subscribedSessionId = nil
                self.scheduleReconnect()
            }
        }
    }

    private func scheduleReconnect() {
        guard user != nil, reconnectTask == nil else { return }
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 30_000_000_000)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.socket == nil, self.user != nil else { return }
                self.reconnectTask = nil
                self.connect()
            }
        }
    }

    private func handleSocketData(_ data: Data) async {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }
        let sid = (object["sessionId"] as? NSNumber)?.intValue
        let payload = object["data"] as? [String: Any] ?? [:]
        await MainActor.run {
            switch type {
            case "connected":
                isConnected = true
                reconnectTask?.cancel()
                reconnectTask = nil
                reconnectDelay = 1_000_000_000
                if let id = selectedSession?.id { subscribe(to: id) }
            case "session_snapshot", "session_status":
                if let sid, let phase = payload["phase"] as? String {
                    updateSession(id: sid, phase: phase)
                    if Self.isTerminalPhase(phase), sid == selectedSession?.id {
                        streamingAssistantId = nil
                        isSending = false
                        refreshMessagesAfterTerminal(sessionId: sid)
                    }
                }
            case "user_message_saved":
                reconcileSavedUserMessage(payload)
            case "message_end":
                streamingAssistantId = nil
                isSending = false
            case "content_delta":
                guard sid == selectedSession?.id, let delta = payload["delta"] as? String else { return }
                if let streamingAssistantId,
                   let index = messages.firstIndex(where: { $0.id == streamingAssistantId }) {
                    messages[index].content += delta
                } else {
                    let message = NativeMessage(id: "stream-\(UUID().uuidString)", role: "ASSISTANT", content: delta)
                    streamingAssistantId = message.id
                    messages.append(message)
                }
            case "error":
                if let message = payload["message"] as? String { errorMessage = message }
                streamingAssistantId = nil
                isSending = false
                if let selectedSession {
                    Task { await loadMessages(for: selectedSession) }
                }
            default:
                break
            }
        }
    }

    private func updateSession(id: Int, phase: String) {
        guard let selected = selectedSession, selected.id == id else { return }
        selectedSession = NativeSession(id: selected.id, agentId: selected.agentId, agentName: selected.agentName, title: selected.title, status: selected.status, executionMode: selected.executionMode, phase: phase, summary: selected.summary, updatedAt: selected.updatedAt, createdAt: selected.createdAt, running: phase == "RUNNING", unread: selected.unread)
        groups = groups.map { group in
            NativeSessionGroup(key: group.key, label: group.label, total: group.total, hasMore: group.hasMore, sessions: group.sessions.map { item in
                guard item.id == id else { return item }
                return NativeSession(id: item.id, agentId: item.agentId, agentName: item.agentName, title: item.title, status: item.status, executionMode: item.executionMode, phase: phase, summary: item.summary, updatedAt: item.updatedAt, createdAt: item.createdAt, running: phase == "RUNNING", unread: item.unread)
            })
        }
    }

    private static func isTerminalPhase(_ phase: String) -> Bool {
        phase == "COMPLETED" || phase == "FAILED" || phase == "CANCELLED"
    }

    /// The terminal status is the point at which the server has persisted the
    /// final assistant message. Reconcile from REST so a dropped WebSocket
    /// delta or a reconnect cannot leave a stale local bubble on screen.
    private func refreshMessagesAfterTerminal(sessionId: Int) {
        guard terminalRefreshTask == nil else { return }
        terminalRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else { return }
            await self?.refreshPersistedSession(sessionId: sessionId)
            await MainActor.run { self?.terminalRefreshTask = nil }
        }
    }

    private func refreshPersistedSession(sessionId: Int) async {
        guard selectedSession?.id == sessionId else { return }
        do {
            let response = try await api.loadMessages(sessionId: sessionId)
            guard selectedSession?.id == sessionId else { return }
            messages = response.messages
            groups = try await api.loadGroups().groups
            if let session = allSessions.first(where: { $0.id == sessionId }) {
                selectedSession = session
            }
            pendingUserMessageIds = pendingUserMessageIds.filter { _, localId in
                !messages.contains(where: { $0.id == localId })
            }
        } catch {
            // Keep the streamed transcript visible if this read fails. The
            // next reconnect or session selection will retry it.
            errorMessage = error.localizedDescription
        }
    }

    private func reconcileSavedUserMessage(_ payload: [String: Any]) {
        guard let eventId = payload["tempEventId"] as? String,
              let localId = pendingUserMessageIds.removeValue(forKey: eventId),
              let rawMessageId = payload["messageId"] else { return }
        let persistedId: String
        if let value = rawMessageId as? NSNumber {
            persistedId = value.stringValue
        } else if let value = rawMessageId as? String {
            persistedId = value
        } else {
            return
        }
        guard let index = messages.firstIndex(where: { $0.id == localId }) else { return }
        let current = messages[index]
        messages[index] = NativeMessage(
            id: persistedId,
            role: current.role,
            content: current.content,
            thinkingContent: current.thinkingContent,
            images: current.images,
            createdAt: current.createdAt
        )
    }

    private func subscribe(to id: Int) {
        guard subscribedSessionId != id else { return }
        subscribedSessionId = id
        Task {
            try? await waitForConnection()
            try? await sendSocket(type: "subscribe", sessionId: id)
        }
    }

    private func waitForConnection() async throws {
        for _ in 0..<75 {
            if isConnected, socket != nil { return }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        throw NativeError(message: "实时连接超时，请稍后重试")
    }

    private func sendSocket(type: String, sessionId: Int? = nil, data: [String: Any]? = nil, rootFields: [String: Any] = [:]) async throws {
        var payload: [String: Any] = rootFields.merging(["type": type]) { _, new in new }
        if let sessionId { payload["sessionId"] = sessionId }
        if let data { payload["data"] = data }
        let bytes = try JSONSerialization.data(withJSONObject: payload)
        guard let text = String(data: bytes, encoding: .utf8), let socket else { throw NativeError(message: "实时连接不可用") }
        try await socket.send(.string(text))
    }
}
