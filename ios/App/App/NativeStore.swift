import Foundation
import SwiftUI

private final class NativeWebSocketDelegate: NSObject, URLSessionWebSocketDelegate {
    var onOpen: (() -> Void)?
    var onClose: ((URLSessionWebSocketTask.CloseCode, Data?) -> Void)?

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        onOpen?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        onClose?(closeCode, reason)
    }
}

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
    @Published var agents: [NativeAgent] = []
    @Published var models: [NativeModel] = []
    @Published var cloudProjects: [NativeCloudProject] = []
    @Published var selectedAgent: NativeAgent?
    @Published var selectedModel: NativeModel?
    @Published var workspaceMode = "new"
    @Published var workspacePath = ""
    @Published var cloudProjectKey = ""
    @Published var gitCloneURL = ""
    @Published var isLoadingConfiguration = false
    @Published var socketErrorMessage: String?

    private let api = NativeAPI.shared
    private var socket: URLSessionWebSocketTask?
    private var socketSession: URLSession?
    private var socketDelegate: NativeWebSocketDelegate?
    private var socketTimeoutTask: Task<Void, Never>?
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
            await loadConfiguration()
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
            await loadConfiguration()
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
        socketSession?.invalidateAndCancel()
        socketSession = nil
        socketDelegate = nil
        socketTimeoutTask?.cancel()
        socketTimeoutTask = nil
        isConnected = false
        await api.logout()
        groups = []
        agents = []
        models = []
        cloudProjects = []
        selectedAgent = nil
        selectedModel = nil
        workspaceMode = "new"
        workspacePath = ""
        cloudProjectKey = ""
        gitCloneURL = ""
        messages = []
        selectedSession = nil
        user = nil
        pendingUserMessageIds.removeAll()
    }

    func loadGroups() async throws {
        groups = try await api.loadGroups().groups
    }

    func loadConfiguration() async {
        isLoadingConfiguration = true
        defer { isLoadingConfiguration = false }
        // 三个列表相互独立。云项目接口短暂失败时，智能体和模型仍应可用。
        let loadedAgents = try? await api.loadAgents()
        let loadedModels = try? await api.loadModels()
        let loadedProjects = try? await api.loadCloudProjects()
        if let loadedAgents {
            agents = loadedAgents.filter { $0.enabled != false && $0.clientVisible != false }
        }
        if let loadedModels {
            models = loadedModels.filter { $0.status == nil || $0.status == 1 }
        }
        if let loadedProjects {
            cloudProjects = loadedProjects
        }
        syncSelectionFromSession()
        if selectedAgent == nil { selectedAgent = agents.first }
        if selectedModel == nil {
            selectedModel = preferredModel(for: selectedAgent) ?? models.first(where: { $0.isDefault == true }) ?? models.first
        }
    }

    func selectAgent(_ agent: NativeAgent) {
        selectedAgent = agent
        if let preferred = preferredModel(for: agent) { selectedModel = preferred }
        guard let session = selectedSession, session.agentId != agent.id else { return }
        Task { await updateCurrentSession(agentId: agent.id) }
    }

    func selectModel(_ model: NativeModel) {
        selectedModel = model
        guard selectedSession?.modelId != model.id, let sessionId = selectedSession?.id else { return }
        Task { await updateCurrentSession(modelId: model.id, sessionId: sessionId) }
    }

    func selectWorkspaceMode(_ mode: String) {
        workspaceMode = mode
        if mode != "existing" { cloudProjectKey = "" }
        if mode != "git" { gitCloneURL = "" }
        if mode != "path" { workspacePath = "" }
    }

    func setGitCloneURL(_ value: String) {
        gitCloneURL = value
        if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { workspaceMode = "git" }
    }

    func setWorkspacePath(_ path: String) {
        workspacePath = path
        if !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { workspaceMode = "path" }
    }

    func setCloudProject(_ project: NativeCloudProject?) {
        cloudProjectKey = project?.name ?? ""
        if project != nil { workspaceMode = "existing" }
    }

    func selectSession(_ session: NativeSession) {
        let previousSessionId = subscribedSessionId
        subscribedSessionId = nil
        selectedSession = session
        syncSelectionFromSession()
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
        // 保留上一次使用的 Agent / 模型 / 工作区，方便连续创建任务。
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
        reconnectTask?.cancel()
        reconnectTask = nil
        if !isConnected {
            socket?.cancel(with: .goingAway, reason: nil)
            socket = nil
            socketSession?.invalidateAndCancel()
            socketSession = nil
            socketDelegate = nil
            subscribedSessionId = nil
        }
        socketTimeoutTask?.cancel()
        socketTimeoutTask = nil
        socketErrorMessage = nil
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
                if agents.isEmpty || models.isEmpty { await loadConfiguration() }
                guard let agent = selectedAgent ?? agents.first(where: { $0.clientVisible != false }) ?? agents.first else {
                    throw NativeError(message: "暂无可用 Agent")
                }
                let model = selectedModel ?? preferredModel(for: agent) ?? models.first(where: { $0.isDefault == true }) ?? models.first
                selectedAgent = agent
                selectedModel = model
                if workspaceMode == "existing" && cloudProjectKey.isEmpty {
                    throw NativeError(message: "请选择已有云工作区")
                }
                if workspaceMode == "git" && gitCloneURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    throw NativeError(message: "请输入 Git 仓库地址")
                }
                let session = try await api.createSession(
                    agentId: agent.id,
                    modelId: model?.id,
                    workspaceMode: resolvedWorkspaceMode,
                    workspace: resolvedWorkspacePath,
                    cloudProjectKey: resolvedCloudProjectKey,
                    gitCloneURL: resolvedGitCloneURL
                )
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
                var data: [String: Any] = ["content": text, "eventId": eventId, "images": []]
                if let modelId = selectedModel?.id { data["modelId"] = modelId }
                try await sendSocket(type: "send_message", sessionId: sessionId, data: data)
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

    private var resolvedWorkspaceMode: String {
        if workspaceMode == "existing", !cloudProjectKey.isEmpty { return "existing" }
        if workspaceMode == "git", !gitCloneURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "git" }
        if workspaceMode == "path", !workspacePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "new" }
        return "new"
    }

    private var resolvedWorkspacePath: String? {
        workspaceMode == "path" ? workspacePath.trimmingCharacters(in: .whitespacesAndNewlines) : nil
    }

    private var resolvedCloudProjectKey: String? {
        workspaceMode == "existing" ? cloudProjectKey : nil
    }

    private var resolvedGitCloneURL: String? {
        workspaceMode == "git" ? gitCloneURL.trimmingCharacters(in: .whitespacesAndNewlines) : nil
    }

    private func preferredModel(for agent: NativeAgent?) -> NativeModel? {
        guard let modelId = agent?.defaultModelId else { return nil }
        return models.first(where: { $0.id == modelId })
    }

    private func syncSelectionFromSession() {
        guard let session = selectedSession else { return }
        if let agentId = session.agentId, let agent = agents.first(where: { $0.id == agentId }) {
            selectedAgent = agent
        }
        if let modelId = session.modelId, let model = models.first(where: { $0.id == modelId }) {
            selectedModel = model
        } else {
            selectedModel = preferredModel(for: selectedAgent) ?? selectedModel
        }
        if let projectKey = session.projectKey,
           !projectKey.isEmpty,
           session.workspace?.contains("/projects/") == true {
            cloudProjectKey = projectKey
            workspaceMode = "existing"
        } else {
            // 已有会话的自动工作区是服务端按会话分配的目录，配置面板仍显示“新建工作区”。
            workspacePath = ""
            workspaceMode = "new"
        }
    }

    private func updateCurrentSession(modelId: Int? = nil, agentId: Int? = nil, sessionId: Int? = nil) async {
        guard let id = sessionId ?? selectedSession?.id else { return }
        do {
            let updated = try await api.updateSession(sessionId: id, modelId: modelId, agentId: agentId)
            guard selectedSession?.id == id else { return }
            selectedSession = updated
            syncSelectionFromSession()
            groups = try await api.loadGroups().groups
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func connect() {
        guard socket == nil, let token = NativeTokenStore.shared.accessToken,
              let url = URL(string: "wss://mao.yupengsheng.cn/api/ws/stream?client=browser") else { return }
        isConnected = false
        socketErrorMessage = nil
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 30
        let delegate = NativeWebSocketDelegate()
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        let task = session.webSocketTask(with: url)
        socket = task
        socketSession = session
        socketDelegate = delegate
        socketTimeoutTask?.cancel()
        socketTimeoutTask = Task { [weak self, weak task] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard !Task.isCancelled, let self, let task else { return }
            await MainActor.run {
                guard self.socket === task, !self.isConnected else { return }
                self.handleSocketFailure(NativeError(message: "连接服务器超时，请检查网络后重试"), task: task)
            }
        }
        delegate.onOpen = { [weak self, weak task] in
            Task { @MainActor in
                guard let self, let task, self.socket === task else { return }
                do {
                    // URLSessionWebSocketTask 在 didOpenWithProtocol 之前不能发送帧。
                    // 首帧必须是 auth，发送成功后再开始接收服务端回包。
                    try await self.sendSocket(
                        type: "auth",
                        rootFields: ["token": token, "client": "browser", "pageEnabled": false]
                    )
                    await self.receiveLoop(for: task)
                } catch {
                    self.handleSocketFailure(error, task: task)
                }
            }
        }
        delegate.onClose = { [weak self, weak task] closeCode, reason in
            Task { @MainActor in
                guard let self, let task, self.socket === task else { return }
                let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) }
                let message = reasonText?.isEmpty == false
                    ? reasonText!
                    : "WebSocket 已关闭（\(closeCode.rawValue)）"
                self.handleSocketFailure(NativeError(message: message), task: task)
            }
        }
        task.resume()
    }

    private func receiveLoop(for task: URLSessionWebSocketTask) async {
        do {
            while !Task.isCancelled {
                let message = try await task.receive()
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let value): data = value
                @unknown default: continue
                }
                await handleSocketData(data)
            }
        } catch {
            handleSocketFailure(error, task: task)
        }
    }

    private func handleSocketFailure(_ error: Error?, task: URLSessionWebSocketTask) {
        guard socket === task else { return }
        isConnected = false
        socket = nil
        socketSession?.invalidateAndCancel()
        socketSession = nil
        socketDelegate = nil
        socketTimeoutTask?.cancel()
        socketTimeoutTask = nil
        subscribedSessionId = nil
        if let error, !(error is CancellationError) {
            socketErrorMessage = error.localizedDescription
        }
        scheduleReconnect()
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
                socketTimeoutTask?.cancel()
                socketTimeoutTask = nil
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
        selectedSession = NativeSession(id: selected.id, agentId: selected.agentId, agentName: selected.agentName, modelId: selected.modelId, modelName: selected.modelName, title: selected.title, status: selected.status, executionMode: selected.executionMode, workspace: selected.workspace, projectKey: selected.projectKey, permissionLevel: selected.permissionLevel, phase: phase, summary: selected.summary, updatedAt: selected.updatedAt, createdAt: selected.createdAt, running: phase == "RUNNING", unread: selected.unread)
        groups = groups.map { group in
            NativeSessionGroup(key: group.key, label: group.label, total: group.total, hasMore: group.hasMore, sessions: group.sessions.map { item in
                guard item.id == id else { return item }
                return NativeSession(id: item.id, agentId: item.agentId, agentName: item.agentName, modelId: item.modelId, modelName: item.modelName, title: item.title, status: item.status, executionMode: item.executionMode, workspace: item.workspace, projectKey: item.projectKey, permissionLevel: item.permissionLevel, phase: phase, summary: item.summary, updatedAt: item.updatedAt, createdAt: item.createdAt, running: phase == "RUNNING", unread: item.unread)
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
