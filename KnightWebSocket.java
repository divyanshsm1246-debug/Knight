package com.knight.backend;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/* ============================================================================
   KNIGHT REAL-TIME — built into the backend, nothing extra to deploy.

   Endpoint: /ws/knight?userId=...&username=...
   Same protocol the frontend already speaks:
     client -> { type:"join", room }       join one room (a DM thread or "project:<id>")
     client -> { type:"chat", room, text } broadcast a chat message + keep recent history
     client -> { type:"typing", room }     "is typing…" signal
     client -> { type:"file-update", room, filename }
     server -> { type:"history", room, messages:[{from,text,at}] } on join
     server -> { type:"chat" | "typing" | "file-update", room, from, username, ... }
     server -> { type:"presence", online:[userIds] } whenever someone connects/leaves

   REQUIRES one extra dependency in pom.xml:
     <dependency>
       <groupId>org.springframework.boot</groupId>
       <artifactId>spring-boot-starter-websocket</artifactId>
     </dependency>
============================================================================ */

@Configuration
@EnableWebSocket
class KnightWebSocketConfig implements WebSocketConfigurer {
    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // Origins are narrowed by the same KNIGHT_ALLOWED_ORIGINS env var the REST API uses.
        String env = System.getenv("KNIGHT_ALLOWED_ORIGINS");
        List<String> origins = new ArrayList<>(List.of(
            "https://*.pages.dev", "https://*.workers.dev", "https://*.onrender.com",
            "https://*.vercel.app", "https://*.netlify.app", "https://*.github.io",
            "http://localhost:*", "http://127.0.0.1:*"));
        if (env != null) for (String o : env.split(",")) if (!o.isBlank()) origins.add(o.trim());
        registry.addHandler(new KnightWebSocketHandler(), "/ws/knight")
                .setAllowedOriginPatterns(origins.toArray(new String[0]));
    }
}

class KnightWebSocketHandler extends TextWebSocketHandler {
    private static final int HISTORY_LIMIT = 50;
    private static final int MAX_TEXT = 4000;
    private static final long MIN_GAP_MS = 150;   // per-connection flood guard

    private final ObjectMapper json = new ObjectMapper();
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    private final Map<String, String> roomOf = new ConcurrentHashMap<>();      // sessionId -> room
    private final Map<String, Long> lastMsg = new ConcurrentHashMap<>();
    private final Map<String, List<Map<String, Object>>> history = new ConcurrentHashMap<>();

    @Override
    public void afterConnectionEstablished(WebSocketSession s) throws Exception {
        Map<String, String> q = query(s);
        String uid = q.getOrDefault("userId", "");
        if (uid.isBlank() || uid.length() > 80) { s.close(CloseStatus.POLICY_VIOLATION); return; }
        s.getAttributes().put("userId", uid);
        s.getAttributes().put("username", clip(q.getOrDefault("username", "player"), 40));
        sessions.put(s.getId(), s);
        broadcastPresence();
    }

    @Override
    protected void handleTextMessage(WebSocketSession s, TextMessage m) throws Exception {
        if (m.getPayloadLength() > 20_000) return;
        long now = System.currentTimeMillis();
        JsonNode n;
        try { n = json.readTree(m.getPayload()); } catch (Exception e) { return; }
        String type = n.path("type").asText("");
        String room = clip(n.path("room").asText(""), 200);
        String uid = (String) s.getAttributes().get("userId");
        String name = (String) s.getAttributes().get("username");

        switch (type) {
            case "join" -> {
                if (room.isBlank()) return;
                roomOf.put(s.getId(), room);
                send(s, Map.of("type", "history", "room", room,
                        "messages", history.getOrDefault(room, List.of())));
            }
            case "ping" -> send(s, Map.of("type", "pong"));
            case "chat" -> {
                Long prev = lastMsg.put(s.getId(), now);       // flood guard applies to chat only
                if (prev != null && now - prev < MIN_GAP_MS) return;
                String text = clip(n.path("text").asText(""), MAX_TEXT).trim();
                if (room.isBlank() || text.isEmpty()) return;
                Map<String, Object> msg = new LinkedHashMap<>();
                msg.put("type", "chat"); msg.put("room", room); msg.put("from", uid);
                msg.put("username", name); msg.put("text", text); msg.put("at", now);
                List<Map<String, Object>> h = history.computeIfAbsent(room, k -> new CopyOnWriteArrayList<>());
                h.add(Map.of("from", uid, "text", text, "at", now));
                while (h.size() > HISTORY_LIMIT) h.remove(0);
                toRoom(room, msg);
            }
            case "typing", "file-update" -> {
                if (room.isBlank()) return;
                Map<String, Object> msg = new LinkedHashMap<>();
                msg.put("type", type); msg.put("room", room); msg.put("from", uid); msg.put("username", name);
                if (type.equals("file-update")) msg.put("filename", clip(n.path("filename").asText(""), 200));
                toRoomExcept(room, msg, s.getId());
            }
            default -> { }
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession s, CloseStatus st) {
        sessions.remove(s.getId()); roomOf.remove(s.getId()); lastMsg.remove(s.getId());
        broadcastPresence();
    }

    // ---- helpers ----
    private void broadcastPresence() {
        Set<String> online = new HashSet<>();
        for (WebSocketSession s : sessions.values()) online.add((String) s.getAttributes().get("userId"));
        Map<String, Object> msg = Map.of("type", "presence", "online", online);
        for (WebSocketSession s : sessions.values()) send(s, msg);
    }
    private void toRoom(String room, Object msg) {
        for (WebSocketSession s : sessions.values()) if (room.equals(roomOf.get(s.getId()))) send(s, msg);
    }
    private void toRoomExcept(String room, Object msg, String exceptId) {
        for (WebSocketSession s : sessions.values())
            if (!s.getId().equals(exceptId) && room.equals(roomOf.get(s.getId()))) send(s, msg);
    }
    private void send(WebSocketSession s, Object msg) {
        try {
            if (s.isOpen()) synchronized (s) { s.sendMessage(new TextMessage(json.writeValueAsString(msg))); }
        } catch (Exception ignored) { }
    }
    private static String clip(String v, int max) { return v == null ? "" : (v.length() > max ? v.substring(0, max) : v); }
    private static Map<String, String> query(WebSocketSession s) {
        Map<String, String> out = new HashMap<>();
        String raw = s.getUri() == null ? null : s.getUri().getRawQuery();
        if (raw == null) return out;
        for (String kv : raw.split("&")) {
            int i = kv.indexOf('=');
            if (i < 1) continue;
            out.put(java.net.URLDecoder.decode(kv.substring(0, i), java.nio.charset.StandardCharsets.UTF_8),
                    java.net.URLDecoder.decode(kv.substring(i + 1), java.nio.charset.StandardCharsets.UTF_8));
        }
        return out;
    }
}
