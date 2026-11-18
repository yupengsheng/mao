import SwiftUI

struct NativeRootView: View {
    @StateObject private var store = NativeStore()
    @State private var drawerPresented = false

    var body: some View {
        Group {
            if store.user == nil {
                NativeLoginView()
            } else {
                NativeChatView(drawerPresented: $drawerPresented)
            }
        }
        .environmentObject(store)
        .tint(Color(red: 0.12, green: 0.44, blue: 0.98))
    }
}

private struct NativeLoginView: View {
    @EnvironmentObject private var store: NativeStore
    @State private var username = ""
    @State private var password = ""
    @FocusState private var focusedField: Field?

    private enum Field { case username, password }

    var body: some View {
        NavigationView {
            VStack(spacing: 24) {
                Spacer()
                VStack(spacing: 12) {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 48, weight: .semibold))
                        .foregroundStyle(.tint)
                    Text("登录 Mao")
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                    Text("原生 iOS 客户端")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                VStack(spacing: 12) {
                    TextField("用户名", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .username)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .password }
                        .nativeInputStyle()
                    SecureField("密码", text: $password)
                        .textContentType(.password)
                        .focused($focusedField, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { login() }
                        .nativeInputStyle()
                }
                Button(action: login) {
                    HStack {
                        if store.isLoading { ProgressView().tint(.white) }
                        Text(store.isLoading ? "登录中…" : "登录")
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .disabled(username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty || store.isLoading)
                if let error = store.errorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }
                Spacer()
            }
            .padding(.horizontal, 24)
            .navigationBarHidden(true)
        }
    }

    private func login() {
        focusedField = nil
        Task { await store.login(username: username, password: password) }
    }
}

private struct NativeChatView: View {
    @EnvironmentObject private var store: NativeStore
    @Binding var drawerPresented: Bool
    @FocusState private var composerFocused: Bool

    var body: some View {
        ZStack(alignment: .leading) {
            VStack(spacing: 0) {
                NativeTopBar(drawerPresented: $drawerPresented, composerFocused: $composerFocused)
                Divider()
                NativeMessageList()
                NativeComposer(focused: $composerFocused)
            }
            .background(Color(uiColor: .systemBackground))
            if drawerPresented {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { drawerPresented = false } }
                NativeHistoryDrawer(isPresented: $drawerPresented)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    .transition(.move(edge: .leading))
                    .shadow(color: .black.opacity(0.15), radius: 16, x: 8, y: 0)
            }
        }
        .animation(.easeOut(duration: 0.2), value: drawerPresented)
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            store.retryConnection()
        }
        .alert("提示", isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
            Button("确定", role: .cancel) { store.errorMessage = nil }
            if !store.isConnected { Button("重试") { store.errorMessage = nil; store.retryConnection() } }
        } message: {
            Text(store.errorMessage ?? "")
        }
    }
}

private struct NativeTopBar: View {
    @EnvironmentObject private var store: NativeStore
    @Binding var drawerPresented: Bool
    @FocusState.Binding var composerFocused: Bool

    var body: some View {
        HStack(spacing: 12) {
            Button {
                composerFocused = false
                withAnimation { drawerPresented = true }
            } label: {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("打开历史会话")
            VStack(alignment: .leading, spacing: 2) {
                Text(store.selectedSession?.title?.isEmpty == false ? store.selectedSession!.title! : "新任务")
                    .font(.headline)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Circle().fill(store.isConnected ? Color.green : Color.orange).frame(width: 6, height: 6)
                    Text(store.isConnected ? "已连接" : "连接中")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button {
                store.startNewChat()
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("新建会话")
        }
        .padding(.horizontal, 8)
        .frame(height: 56)
        .background(.thinMaterial)
    }
}

private struct NativeHistoryDrawer: View {
    @EnvironmentObject private var store: NativeStore
    @Binding var isPresented: Bool
    @State private var historyExpanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Mao")
                    .font(.title3.weight(.bold))
                Spacer()
                Button { withAnimation { isPresented = false } } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .semibold))
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("关闭历史会话")
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            Divider()
            Button {
                store.startNewChat()
                withAnimation { isPresented = false }
            } label: {
                Label("新建会话", systemImage: "plus")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 13)
            }
            .buttonStyle(.plain)
            Divider()
            DisclosureGroup(isExpanded: $historyExpanded) {
                if store.groups.isEmpty {
                    Text("暂无历史会话")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(store.groups) { group in
                                Text(group.label)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 16)
                                    .padding(.top, 12)
                                ForEach(group.sessions) { session in
                                    Button {
                                        store.selectSession(session)
                                        withAnimation { isPresented = false }
                                    } label: {
                                        HStack(spacing: 10) {
                                            Image(systemName: session.id == store.selectedSession?.id ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right")
                                                .foregroundStyle(session.id == store.selectedSession?.id ? Color.accentColor : Color.secondary)
                                            Text(session.title?.isEmpty == false ? session.title! : "未命名会话")
                                                .lineLimit(2)
                                                .multilineTextAlignment(.leading)
                                            Spacer(minLength: 0)
                                            if session.running == true { ProgressView().scaleEffect(0.75) }
                                        }
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 11)
                                        .contentShape(Rectangle())
                                        .background(session.id == store.selectedSession?.id ? Color.accentColor.opacity(0.1) : .clear)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
            } label: {
                Label("历史会话", systemImage: "clock.arrow.circlepath")
                    .font(.headline)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
            }
            .padding(.top, 4)
            Spacer()
            Divider()
            HStack(spacing: 10) {
                Image(systemName: "person.crop.circle.fill").font(.title3).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(store.user?.displayName ?? store.user?.username ?? "用户").font(.subheadline.weight(.medium)).lineLimit(1)
                    Text(store.user?.email ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Button { Task { await store.logout() } } label: {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                        .frame(width: 36, height: 36)
                }
                .accessibilityLabel("退出登录")
            }
            .padding(16)
        }
        .frame(width: min(340, UIScreen.main.bounds.width * 0.86))
        .background(Color(uiColor: .secondarySystemBackground))
        .ignoresSafeArea(edges: .vertical)
    }
}

private struct NativeMessageList: View {
    @EnvironmentObject private var store: NativeStore

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 18) {
                    if store.messages.isEmpty {
                        VStack(spacing: 12) {
                            Spacer(minLength: 80)
                            Image(systemName: "sparkles")
                                .font(.system(size: 34, weight: .medium))
                                .foregroundStyle(.tint)
                            Text("今天有什么可以帮你？")
                                .font(.title3.weight(.semibold))
                            Text("输入任务，Mao 会实时执行并返回结果")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                    } else {
                        ForEach(store.messages) { message in
                            NativeMessageBubble(message: message)
                                .id(message.id)
                        }
                    }
                    if store.isLoadingMessages { ProgressView().padding(.top, 16) }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 18)
            }
            .onChange(of: store.messages.count) { _ in
                if let last = store.messages.last { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }
}

private struct NativeMessageBubble: View {
    let message: NativeMessage
    private var isUser: Bool { message.role.uppercased() == "USER" }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if isUser { Spacer(minLength: 42) }
            if !isUser {
                Image(systemName: "sparkles")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.tint)
                    .frame(width: 28, height: 28)
                    .background(Color.accentColor.opacity(0.12), in: Circle())
            }
            Text(message.content.isEmpty ? "正在思考…" : message.content)
                .font(.body)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(isUser ? Color.accentColor.opacity(0.12) : Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            if !isUser { Spacer(minLength: 18) }
        }
    }
}

private struct NativeComposer: View {
    @EnvironmentObject private var store: NativeStore
    @FocusState.Binding var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextEditor(text: $store.composerText)
                .frame(minHeight: 38, maxHeight: 110)
                .focused($focused)
                .font(.body)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            Button { store.sendComposer() } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(store.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.secondary : Color.accentColor)
            }
            .disabled(store.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isSending)
            .accessibilityLabel("发送消息")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.thinMaterial)
    }
}

private extension View {
    func nativeInputStyle() -> some View {
        self
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
