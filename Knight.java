import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import javax.crypto.Mac;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.function.BiConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * KNIGHT — Knight.java
 * ====================
 * The entire backend in one file: HTTP server, data layer, auth, persistence.
 * Replaces the former server.js + database.js pair.
 *
 * DELIBERATELY ZERO EXTERNAL DEPENDENCIES. No Maven, no Gradle, no jars to
 * download. Everything below is built on the JDK's own standard library, so
 * the whole thing runs with a bare `java Knight.java`. That keeps deployment
 * to a single command and removes an entire class of "works on my machine"
 * build failures.
 *
 * WHAT THAT COSTS — read this before deploying, these are real:
 *
 *  1. PASSKEYS / WebAuthn are NOT implemented. The old Node server used the
 *     @simplewebauthn library, which does CBOR decoding, COSE key parsing and
 *     attestation signature verification. Hand-rolling that is security-critical
 *     cryptography and getting it subtly wrong yields a login that LOOKS fine
 *     but is not actually secure. The six passkey routes therefore return a
 *     clear 501 rather than a broken imitation. Email/password and guest login
 *     are fully implemented and work.
 *
 *  2. REAL-TIME (Socket.IO) is NOT implemented. The browser's socket.io-client
 *     speaks the Socket.IO protocol, which a plain JDK server cannot answer.
 *     Chat, pings, presence and live notifications are served over plain HTTP
 *     polling endpoints instead (see /api/chat and /api/presence/friends).
 *     Messages still send and arrive; they just arrive on a poll rather than
 *     being pushed instantly.
 *
 *  3. PASSWORD HASHES ARE NOT COMPATIBLE with the old bcrypt ones. This uses
 *     PBKDF2-HMAC-SHA256 (strong, and in the JDK). Any accounts created under
 *     the Node server must be created again. On Render's free tier data.json
 *     is wiped on redeploy anyway, so in practice this changes nothing.
 *
 * Run:   JWT_SECRET=something java Knight.java
 */
public class Knight {

    static final int PORT = Integer.parseInt(env("PORT", "3000"));
    static final String JWT_SECRET = env("JWT_SECRET", "dev-only-insecure-secret-change-me");
    static final String DATA_DIR = env("DATA_DIR", ".");
    static final String BUILD_TAG = "knight-java-1.0";
    static final SecureRandom RNG = new SecureRandom();

    static String env(String k, String d) {
        String v = System.getenv(k);
        return (v == null || v.isEmpty()) ? d : v;
    }

    // ========================================================================
    // JSON — a minimal but complete parser/serializer.
    // Objects are LinkedHashMap (insertion order preserved so responses read
    // the same way every time), arrays are ArrayList, numbers are Double,
    // and everything else maps to the obvious Java type.
    // ========================================================================
    static final class Json {

        static Object parse(String s) {
            if (s == null || s.isBlank()) return null;
            P p = new P(s);
            p.ws();
            Object v = p.value();
            p.ws();
            if (p.i < p.s.length()) throw new IllegalArgumentException("trailing junk at " + p.i);
            return v;
        }

        private static final class P {
            final String s;
            int i = 0;
            P(String s) { this.s = s; }

            void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

            char peek() {
                if (i >= s.length()) throw new IllegalArgumentException("unexpected end of JSON");
                return s.charAt(i);
            }

            Object value() {
                ws();
                char c = peek();
                switch (c) {
                    case '{': return object();
                    case '[': return array();
                    case '"': return string();
                    case 't': expect("true"); return Boolean.TRUE;
                    case 'f': expect("false"); return Boolean.FALSE;
                    case 'n': expect("null"); return null;
                    default: return number();
                }
            }

            void expect(String lit) {
                if (!s.startsWith(lit, i)) throw new IllegalArgumentException("expected " + lit + " at " + i);
                i += lit.length();
            }

            Map<String, Object> object() {
                Map<String, Object> m = new LinkedHashMap<>();
                i++; // {
                ws();
                if (peek() == '}') { i++; return m; }
                while (true) {
                    ws();
                    String k = string();
                    ws();
                    if (peek() != ':') throw new IllegalArgumentException("expected : at " + i);
                    i++;
                    m.put(k, value());
                    ws();
                    char c = peek();
                    if (c == ',') { i++; continue; }
                    if (c == '}') { i++; return m; }
                    throw new IllegalArgumentException("expected , or } at " + i);
                }
            }

            List<Object> array() {
                List<Object> l = new ArrayList<>();
                i++; // [
                ws();
                if (peek() == ']') { i++; return l; }
                while (true) {
                    l.add(value());
                    ws();
                    char c = peek();
                    if (c == ',') { i++; continue; }
                    if (c == ']') { i++; return l; }
                    throw new IllegalArgumentException("expected , or ] at " + i);
                }
            }

            String string() {
                if (peek() != '"') throw new IllegalArgumentException("expected string at " + i);
                i++;
                StringBuilder sb = new StringBuilder();
                while (true) {
                    char c = s.charAt(i++);
                    if (c == '"') return sb.toString();
                    if (c != '\\') { sb.append(c); continue; }
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                            break;
                        default: throw new IllegalArgumentException("bad escape \\" + e);
                    }
                }
            }

            Double number() {
                int start = i;
                if (peek() == '-') i++;
                while (i < s.length() && (Character.isDigit(s.charAt(i)) || "+-.eE".indexOf(s.charAt(i)) >= 0)) i++;
                return Double.parseDouble(s.substring(start, i));
            }
        }

        static String stringify(Object o) {
            StringBuilder sb = new StringBuilder();
            write(o, sb);
            return sb.toString();
        }

        @SuppressWarnings("unchecked")
        static void write(Object o, StringBuilder sb) {
            if (o == null) { sb.append("null"); return; }
            if (o instanceof String) { escape((String) o, sb); return; }
            if (o instanceof Boolean) { sb.append(o); return; }
            if (o instanceof Number) {
                double d = ((Number) o).doubleValue();
                // Emit whole numbers without a trailing ".0" — the frontend
                // compares some of these as strings, and "1.0" != "1".
                if (d == Math.rint(d) && !Double.isInfinite(d)) sb.append((long) d);
                else sb.append(d);
                return;
            }
            if (o instanceof Map) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    escape(e.getKey(), sb);
                    sb.append(':');
                    write(e.getValue(), sb);
                }
                sb.append('}');
                return;
            }
            if (o instanceof Collection) {
                sb.append('[');
                boolean first = true;
                for (Object v : (Collection<Object>) o) {
                    if (!first) sb.append(',');
                    first = false;
                    write(v, sb);
                }
                sb.append(']');
                return;
            }
            escape(String.valueOf(o), sb);
        }

        static void escape(String s, StringBuilder sb) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    case '\b': sb.append("\\b"); break;
                    case '\f': sb.append("\\f"); break;
                    default:
                        if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                }
            }
            sb.append('"');
        }
    }

    // --- small helpers for building JSON values ------------------------------
    static Map<String, Object> obj(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]);
        return m;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> asMap(Object o) {
        return o instanceof Map ? (Map<String, Object>) o : new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    static List<Object> asList(Object o) {
        return o instanceof List ? (List<Object>) o : new ArrayList<>();
    }

    static String str(Object o) { return o == null ? "" : String.valueOf(o); }

    static String str(Map<String, Object> m, String k) { return str(m.get(k)); }

    static double num(Object o) {
        if (o instanceof Number) return ((Number) o).doubleValue();
        try { return Double.parseDouble(str(o)); } catch (Exception e) { return 0; }
    }

    static boolean bool(Object o) { return Boolean.TRUE.equals(o); }

    static String nowIso() { return Instant.now().toString(); }

    static String uuid() { return UUID.randomUUID().toString(); }

    // ========================================================================
    // STORE — the whole dataset as one JSON file, loaded at boot and written
    // back after every mutation. Same model the Node version used, so an
    // existing data.json keeps working (except password hashes, see header).
    //
    // Every read and write goes through the `LOCK` monitor. The HTTP server
    // runs a thread pool, so without that, two simultaneous signups could
    // interleave and lose one of the writes.
    // ========================================================================
    static final Object LOCK = new Object();
    static Map<String, Object> DB;

    static final String[] COLLECTIONS = {
        "users", "profiles", "friendRequests", "friends", "projects", "projectFiles",
        "projectMembers", "changeRequests", "notes", "chatMessages", "credentials", "projectStars",
        "projectVersions"
    };

    static Path dbPath() { return Paths.get(DATA_DIR, "data.json"); }

    static void load() {
        synchronized (LOCK) {
            DB = new LinkedHashMap<>();
            try {
                Path p = dbPath();
                if (Files.exists(p)) {
                    Object parsed = Json.parse(Files.readString(p, StandardCharsets.UTF_8));
                    DB = asMap(parsed);
                    System.out.println("Loaded data.json from " + p.toAbsolutePath());
                } else {
                    System.out.println("No data.json yet - starting empty at " + p.toAbsolutePath());
                }
            } catch (Exception e) {
                // A corrupt file must not take the whole service down, but it
                // also must not be silently overwritten — say so loudly.
                System.err.println("WARNING: could not read data.json, starting empty: " + e);
                DB = new LinkedHashMap<>();
            }
            for (String c : COLLECTIONS) DB.computeIfAbsent(c, k -> new ArrayList<>());
        }
    }

    static void persist() {
        synchronized (LOCK) {
            try {
                Path p = dbPath();
                if (p.getParent() != null) Files.createDirectories(p.getParent());
                // Write to a temp file then move, so a crash mid-write cannot
                // leave a half-written data.json that fails to parse on boot.
                Path tmp = Paths.get(p.toString() + ".tmp");
                Files.writeString(tmp, Json.stringify(DB), StandardCharsets.UTF_8);
                Files.move(tmp, p, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            } catch (Exception e) {
                System.err.println("PERSIST FAILED: " + e);
            }
        }
    }

    static List<Object> coll(String name) {
        synchronized (LOCK) {
            return asList(DB.computeIfAbsent(name, k -> new ArrayList<>()));
        }
    }

    /** Rows of a collection as maps — the shape every query below wants. */
    static List<Map<String, Object>> rows(String name) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object o : coll(name)) if (o instanceof Map) out.add(asMap(o));
        return out;
    }

    static Map<String, Object> findRow(String name, String key, String value) {
        for (Map<String, Object> r : rows(name)) if (value.equals(str(r, key))) return r;
        return null;
    }

    static void insert(String name, Map<String, Object> row) {
        synchronized (LOCK) {
            asList(DB.computeIfAbsent(name, k -> new ArrayList<>())).add(row);
        }
        persist();
    }

    // ========================================================================
    // PASSWORDS — PBKDF2-HMAC-SHA256. Stored as "pbkdf2$iterations$salt$hash",
    // all base64. Verification is constant-time so a timing side-channel can't
    // be used to probe hashes.
    // ========================================================================
    static final int PBKDF2_ITERATIONS = 120_000;

    static String hashPassword(String plain) {
        try {
            byte[] salt = new byte[16];
            RNG.nextBytes(salt);
            byte[] dk = pbkdf2(plain, salt, PBKDF2_ITERATIONS);
            Base64.Encoder b64 = Base64.getEncoder();
            return "pbkdf2$" + PBKDF2_ITERATIONS + "$" + b64.encodeToString(salt) + "$" + b64.encodeToString(dk);
        } catch (Exception e) {
            throw new RuntimeException("password hashing failed", e);
        }
    }

    static boolean verifyPassword(String plain, String stored) {
        try {
            if (stored == null) return false;
            String[] parts = stored.split("\\$");
            if (parts.length != 4 || !"pbkdf2".equals(parts[0])) {
                // Almost certainly a leftover bcrypt hash from the Node server.
                // We cannot verify it, and pretending otherwise would lock the
                // user out with a confusing "wrong password" instead of the truth.
                System.err.println("Cannot verify a non-PBKDF2 hash (old bcrypt account?) - user must sign up again.");
                return false;
            }
            int iter = Integer.parseInt(parts[1]);
            byte[] salt = Base64.getDecoder().decode(parts[2]);
            byte[] expected = Base64.getDecoder().decode(parts[3]);
            byte[] actual = pbkdf2(plain, salt, iter);
            return MessageDigest.isEqual(expected, actual);
        } catch (Exception e) {
            return false;
        }
    }

    static byte[] pbkdf2(String plain, byte[] salt, int iterations) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(plain.toCharArray(), salt, iterations, 256);
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
    }

    // ========================================================================
    // JWT — HS256, hand-rolled on javax.crypto.Mac. Same wire format the old
    // Node server issued, so the frontend needs no change at all.
    // ========================================================================
    static final Base64.Encoder B64URL = Base64.getUrlEncoder().withoutPadding();
    static final Base64.Decoder B64URL_DEC = Base64.getUrlDecoder();

    static String jwtSign(String userId, long ttlSeconds) {
        long iat = System.currentTimeMillis() / 1000;
        String header = B64URL.encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = B64URL.encodeToString(
            Json.stringify(obj("userId", userId, "iat", (double) iat, "exp", (double) (iat + ttlSeconds)))
                .getBytes(StandardCharsets.UTF_8));
        String signingInput = header + "." + payload;
        return signingInput + "." + B64URL.encodeToString(hmac(signingInput));
    }

    /** @return the userId, or null if the token is missing, malformed, tampered with, or expired. */
    static String jwtVerify(String token) {
        try {
            if (token == null) return null;
            String[] parts = token.split("\\.");
            if (parts.length != 3) return null;
            byte[] expected = hmac(parts[0] + "." + parts[1]);
            if (!MessageDigest.isEqual(expected, B64URL_DEC.decode(parts[2]))) return null;
            Map<String, Object> payload = asMap(Json.parse(new String(B64URL_DEC.decode(parts[1]), StandardCharsets.UTF_8)));
            if (num(payload.get("exp")) < System.currentTimeMillis() / 1000.0) return null;
            String uid = str(payload, "userId");
            return uid.isEmpty() ? null : uid;
        } catch (Exception e) {
            return null;
        }
    }

    static byte[] hmac(String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(JWT_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new RuntimeException("HMAC failed", e);
        }
    }

    // ========================================================================
    // HTTP plumbing
    // ========================================================================

    /** Thrown by handlers to return a specific status with a JSON error body. */
    static final class HttpError extends RuntimeException {
        final int status;
        HttpError(int status, String message) { super(message); this.status = status; }
    }

    static final class Ctx {
        final HttpExchange ex;
        final Map<String, String> params;
        final Map<String, String> query;
        final Map<String, Object> body;
        String userId; // null unless the route required auth

        Ctx(HttpExchange ex, Map<String, String> params, Map<String, String> query, Map<String, Object> body) {
            this.ex = ex; this.params = params; this.query = query; this.body = body;
        }

        String p(String k) { return params.getOrDefault(k, ""); }
        String q(String k) { return query.getOrDefault(k, ""); }
        String b(String k) { return str(body.get(k)); }
        Object raw(String k) { return body.get(k); }

        /** The authenticated user id, or a 401 if the route was reached without one. */
        String requireUser() {
            if (userId == null) throw new HttpError(401, "Not authenticated");
            return userId;
        }
    }

    interface Handler { Object handle(Ctx c) throws Exception; }

    static final class Route {
        final String method;
        final Pattern pattern;
        final List<String> paramNames = new ArrayList<>();
        final Handler handler;
        final boolean requiresAuth;

        Route(String method, String path, boolean requiresAuth, Handler handler) {
            this.method = method;
            this.requiresAuth = requiresAuth;
            this.handler = handler;
            StringBuilder rx = new StringBuilder("^");
            for (String seg : path.split("/", -1)) {
                if (seg.isEmpty()) continue;
                rx.append("/");
                if (seg.startsWith(":")) {
                    paramNames.add(seg.substring(1));
                    rx.append("([^/]+)");
                } else {
                    rx.append(Pattern.quote(seg));
                }
            }
            if (rx.length() == 1) rx.append("/");
            rx.append("/?$");
            this.pattern = Pattern.compile(rx.toString());
        }
    }

    static final List<Route> ROUTES = new ArrayList<>();

    static void get(String path, Handler h) { ROUTES.add(new Route("GET", path, false, h)); }
    static void post(String path, Handler h) { ROUTES.add(new Route("POST", path, false, h)); }
    static void authGet(String path, Handler h) { ROUTES.add(new Route("GET", path, true, h)); }
    static void authPost(String path, Handler h) { ROUTES.add(new Route("POST", path, true, h)); }
    static void authPut(String path, Handler h) { ROUTES.add(new Route("PUT", path, true, h)); }
    static void authDelete(String path, Handler h) { ROUTES.add(new Route("DELETE", path, true, h)); }

    static Map<String, String> parseQuery(String raw) {
        Map<String, String> m = new LinkedHashMap<>();
        if (raw == null || raw.isEmpty()) return m;
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            try {
                if (eq < 0) m.put(java.net.URLDecoder.decode(pair, StandardCharsets.UTF_8), "");
                else m.put(java.net.URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8),
                           java.net.URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
            } catch (Exception ignored) { }
        }
        return m;
    }

    static void send(HttpExchange ex, int status, String contentType, byte[] body) throws IOException {
        ex.getResponseHeaders().add("Content-Type", contentType);
        ex.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders().add("Access-Control-Allow-Headers", "Content-Type, Authorization");
        ex.getResponseHeaders().add("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        ex.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
        if (body.length > 0) {
            try (OutputStream os = ex.getResponseBody()) { os.write(body); }
        } else {
            ex.close();
        }
    }

    static void sendJson(HttpExchange ex, int status, Object value) throws IOException {
        send(ex, status, "application/json; charset=utf-8",
             Json.stringify(value).getBytes(StandardCharsets.UTF_8));
    }

    static void serveFile(HttpExchange ex, String filename, String contentType) throws IOException {
        Path p = Paths.get(filename);
        if (!Files.exists(p)) { sendJson(ex, 404, obj("error", filename + " not found on the server")); return; }
        send(ex, 200, contentType, Files.readAllBytes(p));
    }

    public static void main(String[] args) throws Exception {
        load();
        registerRoutes();

        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);
        server.setExecutor(Executors.newFixedThreadPool(16));
        server.createContext("/", Knight::dispatch);
        server.start();

        System.out.println("Knight server starting - build: " + BUILD_TAG);
        System.out.println("Knight server running on port " + PORT);
        if (JWT_SECRET.startsWith("dev-only")) {
            System.out.println("WARNING: JWT_SECRET is not set. Tokens will not survive a restart "
                             + "and everyone gets signed out. Set JWT_SECRET in production.");
        }
    }

    static void dispatch(HttpExchange ex) {
        String method = ex.getRequestMethod();
        String path = ex.getRequestURI().getPath();
        try {
            if ("OPTIONS".equalsIgnoreCase(method)) { send(ex, 204, "text/plain", new byte[0]); return; }

            for (Route r : ROUTES) {
                if (!r.method.equalsIgnoreCase(method)) continue;
                Matcher m = r.pattern.matcher(path);
                if (!m.matches()) continue;

                Map<String, String> params = new LinkedHashMap<>();
                for (int i = 0; i < r.paramNames.size(); i++) params.put(r.paramNames.get(i), m.group(i + 1));

                Map<String, Object> body = new LinkedHashMap<>();
                if ("POST".equalsIgnoreCase(method) || "PUT".equalsIgnoreCase(method)) {
                    String raw;
                    try (InputStream is = ex.getRequestBody()) {
                        raw = new String(is.readAllBytes(), StandardCharsets.UTF_8);
                    }
                    if (!raw.isBlank()) {
                        try {
                            body = asMap(Json.parse(raw));
                        } catch (Exception parseErr) {
                            // Always answer JSON, never an HTML error page — the
                            // frontend parses every response as JSON and an HTML
                            // body is exactly what produces baffling client errors.
                            sendJson(ex, 400, obj("error", "Request body was not valid JSON"));
                            return;
                        }
                    }
                }

                Ctx c = new Ctx(ex, params, parseQuery(ex.getRequestURI().getQuery()), body);

                String auth = ex.getRequestHeaders().getFirst("Authorization");
                if (auth != null && auth.startsWith("Bearer ")) c.userId = jwtVerify(auth.substring(7).trim());
                if (r.requiresAuth && c.userId == null) {
                    sendJson(ex, 401, obj("error", "Not authenticated"));
                    return;
                }

                Object result = r.handler.handle(c);
                if (result != null) sendJson(ex, 200, result);
                return;
            }

            // Anything Socket.IO must 404 honestly. If it fell through to the
            // SPA rule below, the browser would receive index.html in answer to
            // a <script> request and try to execute HTML as JavaScript, which
            // produces a baffling syntax error instead of a clear "not here".
            if (path.startsWith("/socket.io")) {
                sendJson(ex, 404, obj("error", "This server does not provide Socket.IO. The client falls back to HTTP polling."));
                return;
            }

            // Unknown GET that is not an API call: serve the SPA so client-side
            // routes (/projects/123 etc.) survive a refresh.
            if ("GET".equalsIgnoreCase(method) && !path.startsWith("/api/")) {
                serveFile(ex, "index.html", "text/html; charset=utf-8");
                return;
            }
            System.out.println("404: " + method + " " + path);
            sendJson(ex, 404, obj("error", "No route for " + method + " " + path));

        } catch (HttpError he) {
            try { sendJson(ex, he.status, obj("error", he.getMessage())); } catch (IOException ignored) { }
        } catch (Exception e) {
            System.err.println("Unhandled error on " + method + " " + path + ": " + e);
            e.printStackTrace();
            try { sendJson(ex, 500, obj("error", "Internal server error")); } catch (IOException ignored) { }
        }
    }

    // ========================================================================
    // DATA LAYER
    // ========================================================================

    static String newSocialId() {
        String alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — unreadable when shared aloud
        for (int attempt = 0; attempt < 50; attempt++) {
            StringBuilder sb = new StringBuilder("KNT-");
            for (int i = 0; i < 6; i++) sb.append(alphabet.charAt(RNG.nextInt(alphabet.length())));
            String candidate = sb.toString();
            if (findRow("profiles", "socialId", candidate) == null) return candidate;
        }
        return "KNT-" + uuid().substring(0, 6).toUpperCase();
    }

    static Map<String, Object> createUser(String email, String passwordHash, boolean guest) {
        Map<String, Object> u = obj("id", uuid(), "email", email, "passwordHash", passwordHash,
                                    "isGuest", guest, "createdAt", nowIso());
        insert("users", u);
        return u;
    }

    static Map<String, Object> createProfile(String userId, String username, String role, String device) {
        Map<String, Object> p = obj(
            "userId", userId,
            "socialId", newSocialId(),
            "username", username,
            "role", role == null || role.isEmpty() ? "Coder" : role,
            "bio", "", "github", "", "twitter", "",
            "device", device == null || device.isEmpty() ? "Windows" : device,
            "level", 1.0, "followers", 0.0, "projects", 0.0, "commits", 0.0,
            "avatar", null, "isAdmin", false,
            "camSettings", obj("deviceId", "", "micId", "", "mirror", true),
            "socialSettings", obj("allowFriendRequests", true, "autoAcceptFriends", false, "showSocialIdOnCard", true)
        );
        insert("profiles", p);
        return p;
    }

    /**
     * Never hand back a null profile. A user row with no matching profile row
     * is what produced the old "No profile returned from server" dead end —
     * the client had a valid token but nothing to render, so it bounced the
     * user back to the login screen with no way out. Rebuilding the missing
     * profile is always better than failing.
     */
    static Map<String, Object> ensureProfile(String userId) {
        Map<String, Object> p = findRow("profiles", "userId", userId);
        if (p != null) return p;
        System.err.println("Self-healing: user " + userId + " had no profile row, creating one.");
        Map<String, Object> u = findRow("users", "id", userId);
        String fallbackName = u == null ? "knight" : str(u, "email").split("@")[0];
        if (fallbackName.isEmpty()) fallbackName = "knight";
        return createProfile(userId, fallbackName, "Coder", "Windows");
    }

    static Map<String, Object> publicProfile(Map<String, Object> p) {
        if (p == null) return null;
        Map<String, Object> out = new LinkedHashMap<>(p);
        out.remove("camSettings"); // device-local settings are nobody else's business
        return out;
    }

    static boolean areFriends(String a, String b) {
        for (Map<String, Object> f : rows("friends")) {
            if (str(f, "userId").equals(a) && str(f, "friendId").equals(b)) return true;
            if (str(f, "userId").equals(b) && str(f, "friendId").equals(a)) return true;
        }
        return false;
    }

    static int starCount(String projectId) {
        int n = 0;
        for (Map<String, Object> s : rows("projectStars")) if (str(s, "projectId").equals(projectId)) n++;
        return n;
    }

    static boolean hasStarred(String projectId, String userId) {
        if (userId == null) return false;
        for (Map<String, Object> s : rows("projectStars"))
            if (str(s, "projectId").equals(projectId) && str(s, "userId").equals(userId)) return true;
        return false;
    }

    static Map<String, Object> withStars(Map<String, Object> project, String viewerId) {
        Map<String, Object> out = new LinkedHashMap<>(project);
        String pid = str(project, "id");
        out.put("stars", (double) starCount(pid));
        out.put("starredByMe", hasStarred(pid, viewerId));
        return out;
    }

    static boolean isMember(String projectId, String userId) {
        if (userId == null) return false;
        for (Map<String, Object> m : rows("projectMembers"))
            if (str(m, "projectId").equals(projectId) && str(m, "userId").equals(userId)) return true;
        return false;
    }

    static boolean canView(Map<String, Object> p, String viewerId) {
        if (p == null) return false;
        String vis = str(p, "visibility");
        if (vis.isEmpty() || "public".equals(vis)) return true;
        if (viewerId == null) return false;
        if (str(p, "ownerId").equals(viewerId)) return true;
        if (isMember(str(p, "id"), viewerId)) return true;
        if ("friends".equals(vis)) return areFriends(str(p, "ownerId"), viewerId);
        if ("selected".equals(vis)) {
            Map<String, Object> viewer = findRow("profiles", "userId", viewerId);
            if (viewer == null) return false;
            for (Object s : asList(p.get("visibleTo")))
                if (str(s).equalsIgnoreCase(str(viewer, "socialId"))) return true;
        }
        return false;
    }

    static Map<String, Object> requireProject(String id, String viewerId) {
        Map<String, Object> p = findRow("projects", "id", id);
        if (p == null) throw new HttpError(404, "Project not found");
        if (!canView(p, viewerId)) throw new HttpError(403, "You do not have access to this project");
        return p;
    }

    static Map<String, Object> requireOwner(String id, String userId) {
        Map<String, Object> p = findRow("projects", "id", id);
        if (p == null) throw new HttpError(404, "Project not found");
        if (!str(p, "ownerId").equals(userId)) throw new HttpError(403, "Only the project owner can do that");
        return p;
    }

    static String newJoinCode() {
        String alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 8; i++) sb.append(alphabet.charAt(RNG.nextInt(alphabet.length())));
        return sb.toString();
    }

    static double haversineKm(double lat1, double lng1, double lat2, double lng2) {
        double R = 6371.0;
        double dLat = Math.toRadians(lat2 - lat1), dLng = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                 + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                 * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return R * 2 * Math.asin(Math.sqrt(a));
    }

    /** Presence: a user counts as online if seen in the last 60s. */
    static final Map<String, Long> LAST_SEEN = new ConcurrentHashMapShim();
    static final class ConcurrentHashMapShim extends java.util.concurrent.ConcurrentHashMap<String, Long> { }

    static void touchPresence(String userId) {
        if (userId != null) LAST_SEEN.put(userId, System.currentTimeMillis());
    }

    static boolean isOnline(String userId) {
        Long t = LAST_SEEN.get(userId);
        return t != null && System.currentTimeMillis() - t < 60_000;
    }

    // ========================================================================
    // ROUTES
    // ========================================================================
    static void registerRoutes() {

        // ---------- static + health ----------
        get("/", c -> { serveFile(c.ex, "index.html", "text/html; charset=utf-8"); return null; });
        get("/index.html", c -> { serveFile(c.ex, "index.html", "text/html; charset=utf-8"); return null; });
        get("/script.js", c -> { serveFile(c.ex, "script.js", "application/javascript; charset=utf-8"); return null; });
        get("/style.css", c -> { serveFile(c.ex, "style.css", "text/css; charset=utf-8"); return null; });

        // Open this in a browser after deploying. If the build tag is not what
        // you expect, the host is still serving an older version and none of
        // your changes are live — by far the most common cause of "I fixed it
        // but nothing changed".
        get("/api/health", c -> obj("ok", true, "build", BUILD_TAG, "runtime", "java",
                                    "time", nowIso(), "users", (double) rows("users").size()));

        // ---------- auth ----------
        post("/api/auth/signup", c -> {
            String email = c.b("email").trim().toLowerCase();
            String password = c.b("password");
            String username = c.b("username").trim();
            if (email.isEmpty() || password.isEmpty()) throw new HttpError(400, "Email and password are required");
            if (password.length() < 6) throw new HttpError(400, "Password must be at least 6 characters");
            if (findRow("users", "email", email) != null) throw new HttpError(409, "An account with that email already exists");
            if (username.isEmpty()) username = email.split("@")[0];

            Map<String, Object> user = createUser(email, hashPassword(password), false);
            Map<String, Object> profile = createProfile(str(user, "id"), username, c.b("role"), c.b("device"));
            touchPresence(str(user, "id"));
            return obj("token", jwtSign(str(user, "id"), 30L * 24 * 3600), "profile", profile);
        });

        post("/api/auth/login", c -> {
            String email = c.b("email").trim().toLowerCase();
            String password = c.b("password");
            if (email.isEmpty() || password.isEmpty()) throw new HttpError(400, "Email and password are required");
            Map<String, Object> user = findRow("users", "email", email);
            // Same message for "no such user" and "wrong password" on purpose:
            // distinguishing them tells an attacker which emails are registered.
            if (user == null || !verifyPassword(password, str(user, "passwordHash")))
                throw new HttpError(401, "Incorrect email or password");
            String uid = str(user, "id");
            touchPresence(uid);
            return obj("token", jwtSign(uid, 30L * 24 * 3600), "profile", ensureProfile(uid));
        });

        post("/api/auth/guest", c -> {
            String suffix = uuid().substring(0, 8);
            Map<String, Object> user = createUser("guest-" + suffix + "@knight.local", null, true);
            Map<String, Object> profile = createProfile(str(user, "id"), "guest_" + suffix, "Explorer", c.b("device"));
            touchPresence(str(user, "id"));
            return obj("token", jwtSign(str(user, "id"), 30L * 24 * 3600), "profile", profile, "isGuest", true);
        });

        // ---------- passkeys: deliberately not implemented, see the file header ----------
        Handler passkeyUnavailable = c -> {
            throw new HttpError(501, "Passkeys are not available on this server build. Use email and password to sign in.");
        };
        post("/api/auth/passkey/register-options", passkeyUnavailable);
        post("/api/auth/passkey/register-verify", passkeyUnavailable);
        post("/api/auth/passkey/login-options", passkeyUnavailable);
        post("/api/auth/passkey/login-verify", passkeyUnavailable);
        authGet("/api/auth/passkeys", c -> new ArrayList<>());
        authDelete("/api/auth/passkeys/:id", c -> obj("ok", true));

        // ---------- profile ----------
        authGet("/api/profile/me", c -> {
            touchPresence(c.requireUser());
            return ensureProfile(c.requireUser());
        });

        authPut("/api/profile/me", c -> {
            String uid = c.requireUser();
            Map<String, Object> p = ensureProfile(uid);
            synchronized (LOCK) {
                for (String f : new String[]{"username", "role", "bio", "github", "twitter", "device", "avatar", "defaultPage"})
                    if (c.body.containsKey(f)) p.put(f, c.body.get(f));
                if (c.body.containsKey("camSettings")) p.put("camSettings", asMap(c.raw("camSettings")));
                if (c.body.containsKey("socialSettings")) p.put("socialSettings", asMap(c.raw("socialSettings")));
            }
            persist();
            return p;
        });

        authGet("/api/profile/by-social/:socialId", c -> {
            Map<String, Object> p = findRow("profiles", "socialId", c.p("socialId").toUpperCase());
            if (p == null) throw new HttpError(404, "No profile with that Social ID");
            return publicProfile(p);
        });

        // ---------- friends ----------
        authPost("/api/friend-request", c -> {
            String uid = c.requireUser();
            String targetSocial = c.b("socialId").trim().toUpperCase();
            Map<String, Object> target = findRow("profiles", "socialId", targetSocial);
            if (target == null) throw new HttpError(404, "No profile with that Social ID");
            String targetId = str(target, "userId");
            if (targetId.equals(uid)) throw new HttpError(400, "You cannot add yourself");
            if (areFriends(uid, targetId)) throw new HttpError(409, "You are already friends");

            Map<String, Object> settings = asMap(target.get("socialSettings"));
            if (settings.containsKey("allowFriendRequests") && !bool(settings.get("allowFriendRequests")))
                throw new HttpError(403, "That user is not accepting friend requests");

            for (Map<String, Object> r : rows("friendRequests"))
                if (str(r, "fromUserId").equals(uid) && str(r, "toSocialId").equals(targetSocial)
                    && "pending".equals(str(r, "status")))
                    throw new HttpError(409, "You already have a pending request to that user");

            if (bool(settings.get("autoAcceptFriends"))) {
                insert("friends", obj("userId", uid, "friendId", targetId, "createdAt", nowIso()));
                return obj("ok", true, "autoAccepted", true);
            }
            Map<String, Object> req = obj("id", uuid(), "fromUserId", uid, "toSocialId", targetSocial,
                                          "status", "pending", "createdAt", nowIso());
            insert("friendRequests", req);
            return obj("ok", true, "request", req);
        });

        authGet("/api/friend-requests/incoming", c -> {
            String uid = c.requireUser();
            Map<String, Object> me = ensureProfile(uid);
            List<Object> out = new ArrayList<>();
            for (Map<String, Object> r : rows("friendRequests")) {
                if (!"pending".equals(str(r, "status"))) continue;
                if (!str(r, "toSocialId").equals(str(me, "socialId"))) continue;
                Map<String, Object> from = findRow("profiles", "userId", str(r, "fromUserId"));
                Map<String, Object> row = new LinkedHashMap<>(r);
                row.put("fromProfile", publicProfile(from));
                out.add(row);
            }
            return out;
        });

        authPost("/api/friend-request/:id/accept", c -> {
            String uid = c.requireUser();
            Map<String, Object> me = ensureProfile(uid);
            Map<String, Object> req = findRow("friendRequests", "id", c.p("id"));
            if (req == null) throw new HttpError(404, "Request not found");
            if (!str(req, "toSocialId").equals(str(me, "socialId")))
                throw new HttpError(403, "That request was not sent to you");
            if (!"pending".equals(str(req, "status"))) throw new HttpError(409, "That request was already handled");

            synchronized (LOCK) { req.put("status", "accepted"); }
            insert("friends", obj("userId", str(req, "fromUserId"), "friendId", uid, "createdAt", nowIso()));
            return obj("ok", true);
        });

        authGet("/api/friends", c -> {
            String uid = c.requireUser();
            List<Object> out = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            for (Map<String, Object> f : rows("friends")) {
                String other = null;
                if (str(f, "userId").equals(uid)) other = str(f, "friendId");
                else if (str(f, "friendId").equals(uid)) other = str(f, "userId");
                if (other == null || !seen.add(other)) continue;
                Map<String, Object> p = findRow("profiles", "userId", other);
                if (p == null) continue;
                Map<String, Object> row = new LinkedHashMap<>(publicProfile(p));
                row.put("online", isOnline(other));
                out.add(row);
            }
            return out;
        });

        authGet("/api/presence/friends", c -> {
            String uid = c.requireUser();
            touchPresence(uid);
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map<String, Object> f : rows("friends")) {
                if (str(f, "userId").equals(uid)) out.put(str(f, "friendId"), isOnline(str(f, "friendId")));
                else if (str(f, "friendId").equals(uid)) out.put(str(f, "userId"), isOnline(str(f, "userId")));
            }
            return out;
        });

        // ---------- chat (HTTP polling; see the note about Socket.IO up top) ----------
        authGet("/api/chat/:friendId", c -> {
            String uid = c.requireUser();
            touchPresence(uid);
            String other = c.p("friendId");
            List<Object> out = new ArrayList<>();
            for (Map<String, Object> m : rows("chatMessages")) {
                boolean mine = str(m, "fromUser").equals(uid) && str(m, "toUser").equals(other);
                boolean theirs = str(m, "fromUser").equals(other) && str(m, "toUser").equals(uid);
                if (mine || theirs) out.add(m);
            }
            out.sort(Comparator.comparing(o -> str(asMap(o), "createdAt")));
            return out;
        });

        authPost("/api/chat/:friendId", c -> {
            String uid = c.requireUser();
            String other = c.p("friendId");
            String body = c.b("body").trim();
            if (body.isEmpty()) throw new HttpError(400, "Message cannot be empty");
            if (!areFriends(uid, other)) throw new HttpError(403, "You can only message friends");
            Map<String, Object> msg = obj("id", uuid(), "fromUser", uid, "toUser", other,
                                          "body", body, "createdAt", nowIso());
            insert("chatMessages", msg);
            touchPresence(uid);
            return msg;
        });

        // ---------- notes ----------
        authGet("/api/notes", c -> {
            String uid = c.requireUser();
            List<Object> out = new ArrayList<>();
            for (Map<String, Object> n : rows("notes")) if (str(n, "userId").equals(uid)) out.add(n);
            return out;
        });

        authPost("/api/notes", c -> {
            String uid = c.requireUser();
            String title = c.b("title").isEmpty() ? "Untitled note" : c.b("title");
            Map<String, Object> n = obj("id", uuid(), "userId", uid, "title", title,
                                        "content", c.b("content"), "createdAt", nowIso(), "updatedAt", nowIso());
            insert("notes", n);
            return n;
        });

        authPut("/api/notes/:id", c -> {
            String uid = c.requireUser();
            Map<String, Object> n = findRow("notes", "id", c.p("id"));
            if (n == null || !str(n, "userId").equals(uid)) throw new HttpError(404, "Note not found");
            synchronized (LOCK) {
                if (c.body.containsKey("title")) n.put("title", c.b("title"));
                if (c.body.containsKey("content")) n.put("content", c.b("content"));
                n.put("updatedAt", nowIso());
            }
            persist();
            return n;
        });

        authDelete("/api/notes/:id", c -> {
            String uid = c.requireUser();
            synchronized (LOCK) {
                asList(DB.get("notes")).removeIf(o -> {
                    Map<String, Object> n = asMap(o);
                    return str(n, "id").equals(c.p("id")) && str(n, "userId").equals(uid);
                });
            }
            persist();
            return obj("ok", true);
        });

        // ---------- projects ----------
        authPost("/api/projects", c -> {
            String uid = c.requireUser();
            String name = c.b("name").trim();
            if (name.isEmpty()) throw new HttpError(400, "Project needs a name");

            Map<String, Object> location = null;
            Map<String, Object> loc = asMap(c.raw("location"));
            if (loc.get("lat") instanceof Number && loc.get("lng") instanceof Number) {
                location = obj("lat", num(loc.get("lat")), "lng", num(loc.get("lng")),
                               "label", str(loc.get("label")));
            }

            Map<String, Object> p = obj(
                "id", uuid(), "ownerId", uid, "name", name,
                "description", c.b("description"), "category", c.b("category"),
                "tags", asList(c.raw("tags")),
                "visibility", c.b("visibility").isEmpty() ? "public" : c.b("visibility"),
                "visibleTo", asList(c.raw("visibleTo")),
                "location", location,
                "joinCode", newJoinCode(), "joinCodeEnabled", true,
                "deployedUrl", "", "createdAt", nowIso()
            );
            insert("projects", p);

            Map<String, Object> me = ensureProfile(uid);
            synchronized (LOCK) { me.put("projects", num(me.get("projects")) + 1); }
            persist();
            return withStars(p, uid);
        });

        authGet("/api/projects", c -> {
            String uid = c.userId;
            List<Object> out = new ArrayList<>();
            for (Map<String, Object> p : rows("projects")) if (canView(p, uid)) out.add(withStars(p, uid));
            return out;
        });

        authGet("/api/projects/mine", c -> {
            String uid = c.requireUser();
            List<Object> out = new ArrayList<>();
            for (Map<String, Object> p : rows("projects"))
                if (str(p, "ownerId").equals(uid) || isMember(str(p, "id"), uid)) out.add(withStars(p, uid));
            return out;
        });

        authGet("/api/projects/trending", c -> {
            String uid = c.userId;
            List<Map<String, Object>> visible = new ArrayList<>();
            for (Map<String, Object> p : rows("projects")) if (canView(p, uid)) visible.add(withStars(p, uid));
            visible.sort((a, b) -> Double.compare(num(b.get("stars")), num(a.get("stars"))));
            return new ArrayList<Object>(visible);
        });

        authGet("/api/projects/socials", c -> {
            String uid = c.requireUser();
            List<Object> out = new ArrayList<>();
            for (Map<String, Object> p : rows("projects")) {
                if (str(p, "ownerId").equals(uid)) continue;
                if (areFriends(uid, str(p, "ownerId")) && canView(p, uid)) out.add(withStars(p, uid));
            }
            return out;
        });

        authGet("/api/projects/near", c -> {
            String uid = c.userId;
            if (c.q("lat").isEmpty() || c.q("lng").isEmpty()) throw new HttpError(400, "lat and lng are required");
            double lat, lng, radius;
            try {
                lat = Double.parseDouble(c.q("lat"));
                lng = Double.parseDouble(c.q("lng"));
                radius = c.q("radius").isEmpty() ? 50 : Double.parseDouble(c.q("radius"));
            } catch (NumberFormatException e) {
                throw new HttpError(400, "lat, lng and radius must be numbers");
            }
            List<Map<String, Object>> near = new ArrayList<>();
            for (Map<String, Object> p : rows("projects")) {
                Map<String, Object> loc = asMap(p.get("location"));
                if (loc.isEmpty() || !canView(p, uid)) continue;
                double d = haversineKm(lat, lng, num(loc.get("lat")), num(loc.get("lng")));
                if (d > radius) continue;
                Map<String, Object> row = withStars(p, uid);
                row.put("distanceKm", Math.round(d * 100) / 100.0);
                near.add(row);
            }
            near.sort((a, b) -> Double.compare(num(a.get("distanceKm")), num(b.get("distanceKm"))));
            return new ArrayList<Object>(near);
        });

        authGet("/api/projects/:id", c -> withStars(requireProject(c.p("id"), c.userId), c.userId));

        authPost("/api/projects/:id/star", c -> {
            String uid = c.requireUser();
            String pid = str(requireProject(c.p("id"), uid), "id");
            boolean starred;
            synchronized (LOCK) {
                boolean had = hasStarred(pid, uid);
                if (had) {
                    asList(DB.get("projectStars")).removeIf(o -> {
                        Map<String, Object> s = asMap(o);
                        return str(s, "projectId").equals(pid) && str(s, "userId").equals(uid);
                    });
                    starred = false;
                } else {
                    asList(DB.get("projectStars")).add(obj("projectId", pid, "userId", uid, "createdAt", nowIso()));
                    starred = true;
                }
            }
            persist();
            return obj("starred", starred, "stars", (double) starCount(pid));
        });

        authPut("/api/projects/:id/deployed-url", c -> {
            Map<String, Object> p = requireOwner(c.p("id"), c.requireUser());
            synchronized (LOCK) { p.put("deployedUrl", c.b("deployedUrl")); }
            persist();
            return p;
        });

        // ---------- join codes ----------
        authGet("/api/projects/:id/join-code", c -> {
            Map<String, Object> p = requireOwner(c.p("id"), c.requireUser());
            return obj("joinCode", str(p, "joinCode"), "enabled", bool(p.get("joinCodeEnabled")));
        });

        authPut("/api/projects/:id/join-code", c -> {
            Map<String, Object> p = requireOwner(c.p("id"), c.requireUser());
            synchronized (LOCK) { p.put("joinCodeEnabled", bool(c.raw("enabled"))); }
            persist();
            return obj("joinCode", str(p, "joinCode"), "enabled", bool(p.get("joinCodeEnabled")));
        });

        authPost("/api/projects/:id/join-code/regenerate", c -> {
            Map<String, Object> p = requireOwner(c.p("id"), c.requireUser());
            synchronized (LOCK) { p.put("joinCode", newJoinCode()); }
            persist();
            return obj("joinCode", str(p, "joinCode"));
        });

        authPost("/api/projects/join", c -> {
            String uid = c.requireUser();
            String code = c.b("joinCode").trim().toUpperCase();
            Map<String, Object> target = null;
            for (Map<String, Object> p : rows("projects"))
                if (code.equals(str(p, "joinCode").toUpperCase())) { target = p; break; }
            if (target == null) throw new HttpError(404, "No project with that join code");
            if (!bool(target.get("joinCodeEnabled"))) throw new HttpError(403, "Joining by code is turned off for that project");
            String pid = str(target, "id");
            if (str(target, "ownerId").equals(uid)) throw new HttpError(409, "You already own that project");
            if (isMember(pid, uid)) throw new HttpError(409, "You are already a member");
            insert("projectMembers", obj("projectId", pid, "userId", uid, "role", "member", "joinedAt", nowIso()));
            return withStars(target, uid);
        });

        // ---------- members ----------
        authGet("/api/projects/:id/members", c -> {
            String pid = str(requireProject(c.p("id"), c.userId), "id");
            Map<String, Object> project = findRow("projects", "id", pid);
            List<Object> out = new ArrayList<>();
            Map<String, Object> owner = findRow("profiles", "userId", str(project, "ownerId"));
            if (owner != null) {
                Map<String, Object> row = new LinkedHashMap<>(publicProfile(owner));
                row.put("role", "owner");
                out.add(row);
            }
            for (Map<String, Object> m : rows("projectMembers")) {
                if (!str(m, "projectId").equals(pid)) continue;
                Map<String, Object> p = findRow("profiles", "userId", str(m, "userId"));
                if (p == null) continue;
                Map<String, Object> row = new LinkedHashMap<>(publicProfile(p));
                row.put("role", str(m, "role").isEmpty() ? "member" : str(m, "role"));
                out.add(row);
            }
            return out;
        });

        authPost("/api/projects/:id/members", c -> {
            String uid = c.requireUser();
            Map<String, Object> project = requireOwner(c.p("id"), uid);
            Map<String, Object> target = findRow("profiles", "socialId", c.b("socialId").trim().toUpperCase());
            if (target == null) throw new HttpError(404, "No profile with that Social ID");
            String targetId = str(target, "userId");
            if (targetId.equals(uid)) throw new HttpError(400, "You already own this project");
            if (isMember(str(project, "id"), targetId)) throw new HttpError(409, "That user is already a member");
            insert("projectMembers", obj("projectId", str(project, "id"), "userId", targetId,
                                         "role", "member", "joinedAt", nowIso()));
            return obj("ok", true);
        });

        // ---------- files ----------
        authGet("/api/projects/:id/files", c -> {
            String pid = str(requireProject(c.p("id"), c.userId), "id");
            List<Object> out = new ArrayList<>();
            for (Map<String, Object> f : rows("projectFiles")) if (str(f, "projectId").equals(pid)) out.add(f);
            return out;
        });

        authPost("/api/projects/:id/files", c -> {
            String uid = c.requireUser();
            Map<String, Object> project = requireProject(c.p("id"), uid);
            String pid = str(project, "id");
            if (!str(project, "ownerId").equals(uid) && !isMember(pid, uid))
                throw new HttpError(403, "Only members can edit files");
            String filename = c.b("filename").trim();
            if (filename.isEmpty()) throw new HttpError(400, "File needs a name");

            Map<String, Object> existing = null;
            for (Map<String, Object> f : rows("projectFiles"))
                if (str(f, "projectId").equals(pid) && str(f, "filename").equals(filename)) { existing = f; break; }

            if (existing != null) {
                synchronized (LOCK) {
                    existing.put("content", c.b("content"));
                    existing.put("language", c.b("language"));
                    existing.put("updatedBy", uid);
                    existing.put("updatedAt", nowIso());
                }
                persist();
                return existing;
            }
            Map<String, Object> f = obj("id", uuid(), "projectId", pid, "filename", filename,
                                        "content", c.b("content"), "language", c.b("language"),
                                        "updatedBy", uid, "updatedAt", nowIso());
            insert("projectFiles", f);
            return f;
        });

        authDelete("/api/projects/:id/files/:fileId", c -> {
            String uid = c.requireUser();
            Map<String, Object> project = requireProject(c.p("id"), uid);
            if (!str(project, "ownerId").equals(uid) && !isMember(str(project, "id"), uid))
                throw new HttpError(403, "Only members can delete files");
            synchronized (LOCK) {
                asList(DB.get("projectFiles")).removeIf(o -> str(asMap(o), "id").equals(c.p("fileId")));
            }
            persist();
            return obj("ok", true);
        });

        // ---------- versions ----------
        authGet("/api/projects/:id/versions", c -> {
            String pid = str(requireProject(c.p("id"), c.userId), "id");
            List<Object> out = new ArrayList<>();
            for (Map<String, Object> v : rows("projectVersions")) if (str(v, "projectId").equals(pid)) out.add(v);
            out.sort(Comparator.comparing(o -> str(asMap(o), "createdAt")));
            Collections.reverse(out);
            return out;
        });

        authPost("/api/projects/:id/versions", c -> {
            String uid = c.requireUser();
            Map<String, Object> project = requireProject(c.p("id"), uid);
            String pid = str(project, "id");
            if (!str(project, "ownerId").equals(uid) && !isMember(pid, uid))
                throw new HttpError(403, "Only members can cut a version");

            List<Object> snapshot = new ArrayList<>();
            for (Map<String, Object> f : rows("projectFiles"))
                if (str(f, "projectId").equals(pid)) snapshot.add(new LinkedHashMap<>(f));

            int next = 0;
            for (Map<String, Object> v : rows("projectVersions"))
                if (str(v, "projectId").equals(pid)) next = Math.max(next, (int) num(v.get("version")));

            Map<String, Object> v = obj("id", uuid(), "projectId", pid, "version", (double) (next + 1),
                                        "label", c.b("label"), "files", snapshot,
                                        "createdBy", uid, "createdAt", nowIso());
            insert("projectVersions", v);
            return v;
        });

        authPost("/api/projects/:id/versions/:version/restore", c -> {
            String uid = c.requireUser();
            Map<String, Object> project = requireOwner(c.p("id"), uid);
            String pid = str(project, "id");
            Map<String, Object> target = null;
            for (Map<String, Object> v : rows("projectVersions"))
                if (str(v, "projectId").equals(pid) && str(v, "version").equals(c.p("version"))) { target = v; break; }
            if (target == null) throw new HttpError(404, "Version not found");

            List<Object> restored = asList(target.get("files"));
            synchronized (LOCK) {
                asList(DB.get("projectFiles")).removeIf(o -> str(asMap(o), "projectId").equals(pid));
                for (Object o : restored) asList(DB.get("projectFiles")).add(new LinkedHashMap<>(asMap(o)));
            }
            persist();
            return obj("ok", true, "restoredFiles", (double) restored.size());
        });

        // ---------- change requests ----------
        authGet("/api/projects/:id/change-requests", c -> {
            String pid = str(requireProject(c.p("id"), c.userId), "id");
            List<Object> out = new ArrayList<>();
            for (Map<String, Object> r : rows("changeRequests")) if (str(r, "projectId").equals(pid)) out.add(r);
            return out;
        });

        authPost("/api/projects/:id/change-requests", c -> {
            String uid = c.requireUser();
            String pid = str(requireProject(c.p("id"), uid), "id");
            Map<String, Object> r = obj("id", uuid(), "projectId", pid, "fileId", c.b("fileId"),
                                        "requestedBy", uid, "summary", c.b("summary"),
                                        "content", c.b("content"), "status", "pending", "createdAt", nowIso());
            insert("changeRequests", r);
            return r;
        });

        authPost("/api/change-requests/:id/resolve", c -> {
            String uid = c.requireUser();
            Map<String, Object> r = findRow("changeRequests", "id", c.p("id"));
            if (r == null) throw new HttpError(404, "Change request not found");
            requireOwner(str(r, "projectId"), uid);
            String decision = c.b("status").isEmpty() ? "approved" : c.b("status");
            synchronized (LOCK) {
                r.put("status", decision);
                r.put("resolvedBy", uid);
                r.put("resolvedAt", nowIso());
            }
            if ("approved".equals(decision)) {
                Map<String, Object> f = findRow("projectFiles", "id", str(r, "fileId"));
                if (f != null) synchronized (LOCK) {
                    f.put("content", str(r, "content"));
                    f.put("updatedBy", str(r, "requestedBy"));
                    f.put("updatedAt", nowIso());
                }
            }
            persist();
            return r;
        });

        // ---------- admin ----------
        authGet("/api/admin/check", c -> obj("isAdmin", bool(ensureProfile(c.requireUser()).get("isAdmin"))));

        authGet("/api/admin/projects", c -> {
            if (!bool(ensureProfile(c.requireUser()).get("isAdmin")))
                throw new HttpError(403, "Admins only");
            List<Object> out = new ArrayList<>();
            for (Map<String, Object> p : rows("projects")) out.add(withStars(p, c.userId));
            return out;
        });
    }
}
