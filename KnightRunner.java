package com.knight.backend;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/* ============================================================================
   KNIGHT COMPILER — POST /api/run  { language, code, stdin }
   Does NOT execute anything on your server. It forwards the code to a sandboxed
   Judge0 service (default: the public https://ce.judge0.com) and returns the output.
   Point it at your own Judge0 with the JUDGE0_URL (and optional JUDGE0_TOKEN) env vars.
============================================================================ */
@RestController
@RequestMapping("/api")
class RunController {
    private static final String BASE = Optional.ofNullable(System.getenv("JUDGE0_URL"))
            .filter(s -> !s.isBlank()).orElse("https://ce.judge0.com").replaceAll("/+$", "");
    private static final String TOKEN = System.getenv("JUDGE0_TOKEN");
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final ObjectMapper json = new ObjectMapper();
    private final Map<String, Long> langIds = new ConcurrentHashMap<>();   // our key -> Judge0 language id
    private final Map<String, long[]> hits = new ConcurrentHashMap<>();    // ip -> [windowStart, count]

    /** our language key -> regex over Judge0 language names */
    private static final Map<String, Pattern> NAMES = new LinkedHashMap<>();
    static {
        String[][] p = {
            {"python", "^Python \\(3"}, {"javascript", "^JavaScript"}, {"typescript", "^TypeScript"},
            {"java", "^Java \\("}, {"c", "^C \\("}, {"cpp", "^C\\+\\+ \\("}, {"csharp", "^C# \\("},
            {"go", "^Go \\("}, {"rust", "^Rust"}, {"ruby", "^Ruby"}, {"php", "^PHP"}, {"swift", "^Swift"},
            {"kotlin", "^Kotlin"}, {"scala", "^Scala"}, {"bash", "^Bash"}, {"lua", "^Lua"}, {"perl", "^Perl"},
            {"r", "^R \\("}, {"haskell", "^Haskell"}, {"dart", "^Dart"}, {"sql", "^SQL"}, {"fsharp", "^F#"},
            {"pascal", "^Pascal"}, {"fortran", "^Fortran"}, {"cobol", "^COBOL"}, {"ocaml", "^OCaml"},
            {"elixir", "^Elixir"}, {"groovy", "^Groovy"}, {"prolog", "^Prolog"}, {"assembly", "^Assembly"}
        };
        for (String[] e : p) NAMES.put(e[0], Pattern.compile(e[1]));
    }

    public static class RunRequest { public String language, code, stdin; }

    @PostMapping("/run")
    ResponseEntity<?> run(@RequestBody RunRequest req,
                                            @RequestHeader(value = "X-Forwarded-For", required = false) String xff) {
        String ip = xff == null ? "local" : xff.split(",")[0].trim();
        if (tooMany(ip)) return ResponseEntity.status(429).body(Map.of("error", "Too many runs. Wait a few seconds."));
        if (req == null || req.code == null || req.code.length() > 100_000 || req.language == null)
            return ResponseEntity.badRequest().body(Map.of("error", "Send { language, code }. Code max 100 KB."));
        try {
            long id = languageId(req.language.toLowerCase());
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("language_id", id); body.put("source_code", req.code);
            body.put("stdin", req.stdin == null ? "" : req.stdin);
            body.put("cpu_time_limit", 5); body.put("wall_time_limit", 10);
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(BASE + "/submissions?base64_encoded=false&wait=true"))
                    .timeout(Duration.ofSeconds(40)).header("Content-Type", "application/json");
            if (TOKEN != null && !TOKEN.isBlank()) b.header("X-Auth-Token", TOKEN);
            HttpResponse<String> r = http.send(b.POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(),
                    HttpResponse.BodyHandlers.ofString());
            if (r.statusCode() >= 400) return ResponseEntity.status(502).body(Map.of("error", "Compiler service answered " + r.statusCode()));
            JsonNode n = json.readTree(r.body());
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("stdout", n.path("stdout").asText("")); out.put("stderr", n.path("stderr").asText(""));
            out.put("compile", n.path("compile_output").asText(""));
            out.put("status", n.path("status").path("description").asText(""));
            out.put("time", n.path("time").asText("")); out.put("memory", n.path("memory").asInt(0));
            return ResponseEntity.ok(out);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.status(502).body(Map.of("error", "Could not reach the compiler service."));
        }
    }

    private long languageId(String key) throws Exception {
        Pattern pat = NAMES.get(key);
        if (pat == null) throw new IllegalArgumentException("Unsupported language: " + key);
        Long cached = langIds.get(key);
        if (cached != null) return cached;
        HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create(BASE + "/languages"))
                .timeout(Duration.ofSeconds(15)).GET().build(), HttpResponse.BodyHandlers.ofString());
        long best = -1;
        for (JsonNode l : json.readTree(r.body())) {
            if (pat.matcher(l.path("name").asText("")).find()) best = Math.max(best, l.path("id").asLong());
        }
        if (best < 0) throw new IllegalArgumentException("The compiler service has no runtime for " + key + ".");
        langIds.put(key, best);
        return best;
    }

    private boolean tooMany(String ip) {
        long now = System.currentTimeMillis();
        long[] w = hits.computeIfAbsent(ip, k -> new long[]{now, 0});
        synchronized (w) {
            if (now - w[0] > 10_000) { w[0] = now; w[1] = 0; }
            return ++w[1] > 8;     // 8 runs per 10 seconds per IP
        }
    }
}
